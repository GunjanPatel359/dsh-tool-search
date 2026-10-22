# How the plugin works — `src/index.mjs`

`name-matching.md` covers the name helpers in `src/search.mjs`. This is the rest: what the plugin
does to a request, and what every function in `src/index.mjs` contributes to it.

## The problem, and the one idea everything else follows from

Every tool definition is resent on every model request. An agent with a few MCP servers carries
hundreds of definitions it never opens: thousands of tokens per step, and a model that chooses worse
because it has too many to choose from.

The obvious fix — reveal a tool's definition when the model asks for it — breaks the prompt cache.
The tool list sits at the top of the request; changing it invalidates the prefix, so on most routes
the provider rebuilds the cache for the whole conversation, every time a tool is revealed. That
costs more than the definitions did.

So the rule the rest of the file obeys:

> **The list of tool names the model sees never changes during a session.**

Deferred tools are replaced by a compact **index** of names and one-line summaries. Reading a tool's
full description becomes an ordinary tool *result* (`tool_details`), which appends to the history and
is cached with it. Running a tool becomes an ordinary tool *call* (`call_tool`). Neither changes the
tool list, so the prefix survives and the cache keeps hitting.

Measured on a real 20-tool server: full definitions 30,810 characters, the index 2,209.

## Flow

```
plugin loads          →  name, inject, DEFAULTS
ctx.plugin(...)       →  resolveConfig()          once, at startup
agent created         →  apply()                  wires everything for that one agent
every model request   →  system-prompt/assemble
                          → AgentTools.filter()     rewrites the tool list
                              → buildIndex()        → indexLine() → summary() / signature()
                              → describeDetails()   the text the model reads
model calls tool_details → AgentTools.details()     → renderDetails()  the text it reads back
model calls call_tool    → nested execute through the registry → finalizeContent()
```

## Configuration

`DEFAULTS` is the whole tuning surface; each key is overridable from plugin config.

| key | default | what it decides |
|---|---|---|
| `detailsToolName` | `tool_details` | the tool carrying the index in its description |
| `callToolName` | `call_tool` | the tool that runs a deferred tool |
| `match` | `['mcp__']` | which tools get deferred, by prefix |
| `exclude` | `[]` | prefix opt-out, beats `match` |
| `alwaysLoad` | `[]` | exact-name opt-out, beats everything |
| `minTools` | `10` | below this the plugin gives up entirely |
| `maxDetails` | `10` | most tools one `tool_details` call returns |
| `indexStyle` | `signature` | `names`, `summary`, or `signature` per index line |
| `summaryChars` | `120` | characters each summary gets |
| `indexChars` | `12000` | characters the **summaries** get — not a cap on the output |

`minTools` is the kill switch: an extra round trip to read an index costs more than nine schemas cost
in tokens, so under ten matching tools the plugin passes everything through untouched and strips its
own two tools from the request. The agent never learns it exists.

`indexStyle: 'signature'` is the cheapest trick in the design: parameter names in the index let the
model call a simple tool *without* a details read first, collapsing two steps into one for much of the
catalogue.

## The functions

### Plugin identity — `name`, `inject`

Cordis's contract. `name` identifies the plugin; `inject` declares which services it needs and forces
them to start first — without it `ctx.tools` and `ctx.systemPrompt` wouldn't exist when `apply` runs.

### `resolveConfig(config)`

Shallow-merges over `DEFAULTS`, then rejects anything that cannot work: tool names must be 1-64 of
`[A-Za-z0-9_-]` (providers reject anything else), neither may be `run_code` (DSH reserves it for
PTC mode and would otherwise reject it later with an unrelated-looking error), the two names must differ, `match`/`exclude`/
`alwaysLoad` must be string arrays, the four numeric options whole and non-negative, `maxDetails ≥ 1`,
`indexStyle` one of three. Failing at startup rather than mid-conversation is the point — a bad config
must never surface as odd agent behaviour twenty turns in.

What it cannot check is whether the two tool names are *free*, because at startup there is no agent to
ask. That check lives in `apply`.

Note `{ ...DEFAULTS, ...config }` copies arrays by reference: a caller that mutates the array it passed
in changes the resolved config. `Object.freeze` on `DEFAULTS` doesn't reach values.

### `isDeferrable(toolName, config)`

The gate every tool passes, and the only place the four list options interact. All five conditions must
hold: not one of the plugin's own two tools (it would index itself), not in `alwaysLoad`, starts with a
`match` prefix, and not an `exclude` prefix.

Evaluation order is the precedence. `alwaysLoad` is tested before `match`, so "exact names always sent
in full, whatever `match` says" is literal. `exclude` is tested last, so it beats `match` — you can
widen with one and re-narrow with the other.

### `summary(description, limit)`

Turns a real tool description into the one line the index shows. Three steps:

1. Keep only the first line. Descriptions are often markdown with a heading line then bullet lists; the
   first line is almost always the summary.
2. Cut at the first sentence: `/^(.+?[.!?])(\s|$)/` is lazy up to the first `.!?`, then **requires**
   whitespace or end-of-string. That requirement is why `"Version 1.2 is out."` isn't cut at `1.` — a
   digit follows the dot, not a space.
3. Respect the budget, appending `...` only when `...` fits inside it. Below 4 characters the text is
   simply cut, because `"..."` would overshoot a limit of 3.

Known limit: `"See e.g. the docs."` cuts to `"See e.g."`, since an abbreviation looks exactly like a
sentence end. Fixing that needs a list of abbreviations, which isn't worth it for a summary line.

### `signature(parameters)`

`{path, content, mode}` with `required: ['path']` renders as `(path, content?, mode?)`. Optional
parameters get `?`.

Only one level deep, deliberately: `Object.keys(properties)` reads top-level names, so a nested schema
shows as `(filter?)` and the shape inside `filter` is invisible. The trade is real, because
`indexStyle: 'signature'` explicitly invites the model to call without reading details — an
under-informative signature is where a wrong call comes from. The `?? {}` guards mean a malformed
schema can't throw.

### `indexLine(tool, config)`

Private, because it means nothing without a config. The three styles:

```
names      - mcp__github__create_issue
summary    - mcp__github__create_issue: create issue on github.
signature  - mcp__github__create_issue(title, body?): create issue on github.
```

Only the head differs between `summary` and `signature`; both share the `: summary` tail.

### `buildIndex(tools, config)`

The most delicate function in the file, because its output sits inside the cached prefix: the same
tools must always produce identical bytes.

1. **Group by server.** `[...tools].sort(...)` copies before sorting — never mutate the caller's array,
   and DSH may hand the same array twice — then `serverOf` files each tool under its server, with
   anything non-MCP under `other`.
2. **Sort the groups too**, so Map insertion order can't leak into the output.
3. **Budget the summaries.** `used` accumulates characters and a line is emitted while it fits. A
   group's header is charged to its own first line, so a group whose tools don't fit contributes no
   header — no server advertised with nothing under it.
4. **One line dropped, all later lines dropped.** The `unsummarized.length === 0` test is what keeps the
   index monotonic. Without it a short line further down would resume the summaries and the index would
   interleave summaries with a bare name list.
5. **Names are never given up.** Dropped tools go on one `Also available (…): a, b, c` line. That line
   is not bounded by `indexChars`, which is why `indexChars` describes the summary section rather than
   the whole index.

The invariants worth knowing: same tools in any arrival order give byte-identical output, every name
survives at any `indexChars`, and 500 tools at the default budget produce roughly 22,700 characters of
index.

### `describeDetails(deferred, config)`

The prose wrapper around the index, in three parts: what this is ("more tools are available than are
listed among your tools"), how to use the two tools (worded differently depending on whether signatures
are visible), and `Check this index before saying a capability is missing` — which exists because
models otherwise answer "I can't do that" when the capability is indexed two lines below.

The tool count in `Available tools (180):` tells the model how big the catalogue is, and gives the tests
something stable to assert on.

### `renderDetails(value, config)`

The presentation layer for `tool_details`: the machine result becomes the text the model reads.

```
## mcp__github__create_issue
Create an issue in the repository.
Parameters: {"type":"object","properties":{"title":{...}}}

Run one with call_tool({"name": "<tool name>", "arguments": {...}}).
No tool named "mcp__github__create_isue". Closest: mcp__github__create_issue.
2 more name(s) not shown: ask for at most 10 at a time.
```

Ordering is deliberate: definitions, then how to run one, then the mistakes, then the truncation
notice. `Parameters:` prints the raw JSON schema rather than something prettier, because the model has
to construct arguments from it exactly and a reformatted version loses or reorders constraints. A call
that asked for nothing usable returns a pointer back at the index instead of a blank result — a blank
tool result teaches a model nothing.

### `AgentTools` — one per agent

The per-agent state, and the pivot of the design. One instance per agent is what makes sub-agent
isolation work: a sub-agent's index only contains the tools that sub-agent actually has.

**`filter(tools)`** runs on every assembly. It computes the deferrable set, **stores it as the
catalogue**, then either bails (below `minTools`: pass everything through minus the plugin's two tools)
or rewrites (drop the deferred tools, and swap `tool_details`' description for the freshly built index).
`{ ...t, description }` copies rather than mutating DSH's object.

The subtlety: **the catalogue is a side effect of prompt assembly, not of registration.** Both
`details()` and `call_tool` read `this.catalog`, so the plugin only works after at least one assembly
has run for that agent. Correct in practice — assembly always precedes a model call — but it means the
object has two lives and the second depends on the first. The test harness assembles before exercising
anything for exactly this reason.

**`details(names)`** normalises input (string or array, non-strings dropped, trimmed, deduped), caps at
`maxDetails`, then splits into hits and misses. Each miss gets `suggest()` over the whole catalogue —
that's the typo-recovery path. `truncated` is measured against the deduped list so repeated names don't
report phantom hidden entries.

### `detailsTool(state)`

The definition for `tool_details`. Its `description` at registration is `describeDetails([], config)` —
an intentionally empty placeholder, because the real index is injected per assembly by `filter` and the
registered definition never needs to change. `parameters` requires `names` and sets
`additionalProperties: false`; every extra property a model invents is a validation failure, so the
schema stays tight. `output` pairs the `DETAILS_OUTPUT` schema (for programmatic consumers) with
`renderDetails` (for the model). `isConcurrencySafe: true` because it is a pure read of a Map, so the
harness may batch several.

### `callTool(state, tools)`

The most consequential function here. `tools` is the **root registry**, passed in from `apply` — that is
the whole trick.

1. **Validate.** The name must be a string and present in this agent's catalogue. Otherwise throw with
   `suggest()`'s best names, so the model self-corrects in one step instead of guessing again.
2. **Re-dispatch through the registry** rather than calling the tool's own `execute`.
   `parent: exec.token` makes it a genuine nested call, so `tools/pre-execute` policies, guards and
   approval prompts all see the real tool name and real arguments. Calling the definition directly would
   have bypassed every one of those. This is the security-relevant property of the plugin: hiding a tool
   from the *prompt* does not hide it from the *policy layer*.
3. **Re-home context.** `deferContext` moves the nested call's additional context onto this call so
   nothing the inner tool injected is lost in the wrapping.
4. **Propagate failure and turn-end.** An inner error throws with the inner tool's own text; an inner
   `concludesTurn` ends this turn too.
5. **Hand the content over.** Stash the inner *content blocks* keyed by `exec.token`, return the inner
   *value*.

`finalizeContent` exists because of that last split. `execute` must return a schema-typed JSON value, but
the model needs the inner tool's original content — wrapping an image-returning tool should show the
image, not a JSON string of it. `nested` is the channel between the two callbacks, since DSH gives
`finalizeContent` no access to what `execute` produced. `result.isError ? undefined : content` returns
`undefined` on failure, meaning "leave DSH's error content alone" — and because the throw in `execute`
happens before the `set`, failed calls never leave a stale entry. DSH runs `finalizeContent` exactly once
per normalised result, including failures, and disposes it with the call fiber, so the map cannot grow.

`isConcurrencySafe: () => false` because these tools have side effects.

### `apply(ctx, config)`

Wiring, per agent.

1. Resolve the config once, then reuse it for every agent: one shared config object, one `AgentTools`
   per agent.
2. Listen on `agent/created`, not globally — this is what makes sub-agent isolation work.
3. **Stand down under PTC mode.** In PTC mode the model calls tools from a `run_code` program, and
   DSH writes that program's tool API from the registry (`sdkSchemas`), not from the assembly this
   plugin filters. Every tool is declared to the program anyway, so the plugin has nothing to save,
   and its two tools would only show up as extra entries with an empty catalogue. Measured before
   this check existed (DeepSeek, 25 MCP tools): 7 steps and 99,226 tokens against 2 steps and 25,872
   without the plugin, with the model looking up an empty catalogue. After it: the first request is
   byte-for-byte the size of the run without the plugin. The private `modeFor()` is not available, but
   the registry shows the reserved `run_code` to exactly the agents that are not in native mode, so
   `ctx.tools.get('run_code', agent)` is the check.
4. **Check the two tool names before registering them.** An agent-scope tool shadows a global one of the
   same name, so a configured name already in use would silently replace a working tool. After
   registration the shadow is what resolves and nothing looks wrong, so the question has to be asked
   first: `ctx.tools.get(name, agent)`. It resolves the global layer for any scope key and never throws,
   so an unrecognised key fails open rather than breaking agent creation.
5. Register both tools inside `scope.effect`, so they belong to this agent's scope and are cleaned up
   with it.
6. Add the assembly listener: `await next()` first so it runs after everything else has built the
   assembly, then replace `assembled.tools` and return the same object.

**Why a listener on `system-prompt/assemble` and not `ctx.tools.restrict()`.** `restrict()` only reaches
tools a scope *inherits*, and MCP servers mounted through an ACP session are registered on the agent's
own scope — so `restrict()` cannot see the exact tools this plugin needs to hide. The assemble listener
is the one place every request's tool list passes through, and its return value is authoritative.
Hidden tools stay registered, which is what makes `call_tool` able to reach them through the policy
layer.

## Known limits

- `indexChars` bounds the summary section, not the output. With every name preserved, a large catalogue
  at default settings emits roughly twice the configured budget.
- `signature()` is one level deep; nested parameter shapes are invisible in the index.
- The catalogue is populated by prompt assembly, so nothing works before the first assembly.
- `summary()` cuts at `e.g.`/`i.e.` because they look like sentence ends.
- A configured tool name colliding with a tool registered *after* `agent/created` is not detected; the
  pre-registration check only sees what is already visible to that agent.

## Verifying changes here

The invariants worth re-checking after any edit, and how the current code was checked:

- **Index determinism.** Same tools, shuffled arrival order → byte-identical output. Pinned in
  `tests/index.spec.mjs`; any change to grouping or sorting should be re-run against it.
- **Old-vs-new output equality.** 960 generated catalogues (1-40 tools per server × 2-4 servers × 6
  config sets) comparing `buildIndex` output: identical except where an empty server header used to be
  emitted, and the configured `detailsToolName` in the name-only line.
- **Summary budget.** Every limit 0-40, output length never exceeds the limit. Now a loop inside
  `tests/index.spec.mjs`, so it fails on its own instead of waiting for a manual run.
- **Suggestion correctness.** `distance` is fuzzed against a full-matrix reference implementation; see
  the end of `name-matching.md`.
- **What the tests cover.** `npm test` runs three files, one per source file: `tests/search.spec.mjs`
  for the name matching, `tests/index.spec.mjs` for the text and configuration helpers as plain
  functions, and `tests/plugin.spec.mjs` for what only the live registry can show — the tool list
  staying identical across reads and calls, a policy denial firing on the nested name, deferred
  context and the turn-ending marker ferrying out of a nested call, each agent keeping to its own
  tools, PTC and structured-output agents left alone, and every name surviving a tight index budget.
- `e2e/run.sh` is the only check that exercises a live model against the index prose.
