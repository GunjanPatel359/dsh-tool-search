# dsh-tool-search

Deferred tool loading for [DSH](https://github.com/deepseek-ai/deepseek-harness). Built on DeepSeek Harness; not an official DeepSeek project.

Every tool definition is sent again on every model request. Connect a few MCP servers and an agent carries hundreds of definitions it never uses: thousands of tokens on every step, and a model that picks tools worse because it has too many to choose from.

`dsh-tool-search` sends those tools as a short index instead: each tool's **name and one-line summary**, grouped by server. When the model needs one, it reads the full description and parameters with `tool_details` and runs it with `call_tool`.

```
without:  read, bash, mcp__github__create_issue {full schema}, mcp__github__list_issues {full schema}, ... ×180
with:     read, bash, tool_details {index: 180 names + one-liners}, call_tool

model → tool_details(["mcp__github__create_issue"])   → full description + parameters
model → call_tool("mcp__github__create_issue", {...}) → the tool's own result
```

Measured on a real 20-tool MCP server: full definitions 30,810 characters, a name + summary index 2,209 (about 93% less).

## Does it save tokens?

Per step, always: the first request of a task was 26-62% smaller in our runs. Per task it depends on the model, because the model takes extra steps (the lookup, fewer calls per step, detours into built-in tools). Three runs each, one small task:

| Model | Tokens per task |
|---|---|
| OpenAI gpt-5.4-mini | -40% |
| DeepSeek deepseek-flash | -20% (25 tools), -10% (75 tools) |
| Claude claude-haiku-5-5 | +17% with the `summary` index; about even with `signature` (now the default) |

Every run finished its task with and without the plugin. Details and caveats: [know/07-results.md](know/07-results.md).

## Why it never breaks the prompt cache

Providers cache a request from the top, and tool definitions sit near the top, before the conversation. A plugin that adds a tool's definition when the model asks for it changes that top part, and on most routes the provider then re-processes the **whole conversation** at full price, every time a tool is loaded.

Here the tool list the model sees is the same on every step of a session. The index changes only when the set of connected tools changes, which would change the request anyway. Tool details come back as an ordinary tool result: appended to the history and cached with it.

## Why the model doesn't miss tools

The index is always sent, so the model sees every tool that exists and asks for exact names; there is no keyword search to guess wrong. A name that does not exist (a typo, a missing `mcp__server__` prefix, a server that disconnected) gets the closest real names back instead of a dead end.

## Install

As a bundle in a profile:

```sh
dsh plugin --profile tui add dsh-tool-search
dsh --profile tui
```

Or from a checkout, for one run:

```sh
git clone https://github.com/GunjanPatel359/dsh-tool-search
cd dsh-tool-search
dsh tui --patch ./examples/local.patch.yml
```

The plugin has no runtime dependencies and imports nothing from DSH, so it also loads as a single file through any patch row whose `name` points at `src/index.mjs`.

## Configuration

```yaml
- id: dsh-tool-search
  name: dsh-tool-search
  config:
    match: ['mcp__']          # name prefixes to defer
    exclude: []               # ...except these prefixes, e.g. ['mcp__mycore__'] for tools used every turn
    alwaysLoad: []            # exact names always sent in full
    minTools: 10              # defer only when at least this many match
    indexStyle: signature     # names | summary | signature (name, parameter names, summary)
    maxDetails: 10            # most tools one tool_details call returns
    summaryChars: 120         # length of each summary in the index
    indexChars: 12000         # past this, remaining tools are listed by name only
    detailsToolName: tool_details
    callToolName: call_tool
```

A patch replaces a row's whole `config`, so restate every key you set.

Below `minTools` matching tools nothing changes: every tool is sent as usual and the plugin's two tools are not offered, since a handful of definitions costs less than an extra step.

Keep tools the agent uses on most turns out of the index with `exclude` or `alwaysLoad`: each deferred tool costs one `tool_details` step before its first use.

## How it works

DSH builds one prompt assembly per model step, and every tool the model sees passes through the `system-prompt/assemble` waterfall. On `agent/created` the plugin gives each agent its own state, registers `tool_details` and `call_tool` on the agent's scope, and adds a scoped listener on that waterfall that removes the deferred tools and writes their index into `tool_details`' description.

It does not use `ctx.tools.restrict()`, the registry's own filter, because a restriction only reaches tools a scope inherits. MCP servers mounted through an ACP session (`session/new` with `mcpServers`) are registered on the agent's own scope, where a restriction does not apply. Filtering the assembly covers both kinds.

Hidden tools stay registered. `call_tool` runs one through the registry as a nested call, so `tools/pre-execute` policies, guards, approvals and hooks see the real tool name and arguments, a denial or failure comes back as a failed `call_tool`, and the tool's own result content (images included) is passed back unchanged.

Each agent sees only its own tools, sub-agents included, and its state goes when the agent is disposed.

## Trade-offs

- **One extra step** (`tool_details`) before the first use of a deferred tool in a conversation. Its result stays in the history, so later uses in the same conversation need none, until compaction drops it.
- **Arguments are checked by the tool, not by the provider.** The model writes them from the parameters it read, and a wrong argument comes back as the tool's own error.
- **UIs show `call_tool`** as the outer step, with the real tool as its nested call.
- **Not tested with PTC mode** or structured-output children, which also rewrite the assembly.

## Development

```sh
npm install
npm test
```

End to end, with a real model and real MCP servers (keys in `~/.dsh-e2e.env`; see [know/06-testing.md](know/06-testing.md)):

```sh
RUNS=3 ./e2e/run.sh                         # DeepSeek
PROVIDER=anthropic SERVERS=large ./e2e/run.sh
```

How it all works, file by file: [know/](know/README.md).

The tests mount the real DSH tool registry and prompt assembly (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-scope`), register MCP-shaped tools on agent scopes the way an ACP session does, read the assembly a model request would carry, and run calls through the registry's execute pipeline.

Written against DSH 0.2.x. The extension points it uses are documented, but DSH is pre-1.0 and they can change between releases.

## License

MIT
