# 4. Code map

## src/index.mjs (the plugin)

| Symbol | What it does |
|---|---|
| `name`, `inject` | Cordis plugin identity; waits for `tools` and `systemPrompt` |
| `DEFAULTS`, `resolveConfig()` | defaults and validation of the plugin config |
| `isDeferrable(name, config)` | the deferral rule: `match` minus `exclude` minus `alwaysLoad`, never the plugin's own tools |
| `summary(text, limit)` | first sentence of a description, capped |
| `buildIndex(tools, config)` | the grouped, sorted index; past `indexChars` lists names only |
| `describeDetails(tools, config)` | `tool_details`' description: usage text + index |
| `renderDetails(value, config)` | what the model reads back from `tool_details` |
| `AgentTools` | per-agent state: `filter()` rewrites an assembly's tools, `details()` answers a lookup |
| `signature(parameters)` | `(path, content, mode?)` for the `signature` index style |
| `detailsTool(state)` | the `tool_details` tool definition |
| `callTool(state, tools)` | the `call_tool` tool definition: nested `tools.execute`, `finalizeContent` pass-through |
| `apply(ctx, config)` | wires it all on `agent/created` |

## src/search.mjs (name helpers, no DSH dependency)

| Symbol | What it does |
|---|---|
| `words(text)` | split snake/kebab/camel names into words |
| `serverOf(name)` | the `<server>` in `mcp__<server>__<tool>` |
| `distance(a, b, max)` | edit distance with early exit |
| `suggest(tools, name)` | closest real names for a wrong one (shared words, typo tolerance) |

## Other files

| Path | What it is |
|---|---|
| `cordis.patch.yml` | the bundle layer `dsh plugin add` applies |
| `examples/local.patch.yml` | load from a checkout with `--patch` |
| `tests/plugin.spec.mjs` | plugin tests on the real DSH registry and assembly |
| `tests/search.spec.mjs` | unit tests for the helpers |
| `e2e/run.sh`, `e2e/summarize.mjs` | real model + real MCP servers, with vs without the plugin |
