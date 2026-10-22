# 5. Design decisions

| Decision | Why |
|---|---|
| Filter in `system-prompt/assemble`, not `ctx.tools.restrict()` | `restrict()` only reaches inherited tools; MCP tools mounted through an ACP session are registered on the agent's own scope. The assembly is the one place every request's tool list passes through. |
| Tool list never changes during a session | Tools sit near the top of the request. Adding a definition mid-session makes the provider rebuild its cache for the whole conversation (on routes without DSH in-history tool updates, e.g. pi-ai by default). |
| `call_tool` instead of loading tools | Keeps the list fixed; definitions arrive as a tool result, appended and cached with the history. |
| Always send name + one-line summary | The model sees every tool that exists, so it asks for exact names. Measured: ~93% smaller than full definitions on a 20-tool server. |
| No keyword search | With the index present, search only adds a way to guess wrong. Wrong names get the closest real ones instead. |
| Nested `ctx.tools.execute` with the real name | Permission policies, guards, approvals and hooks see the real tool, not `call_tool`. |
| `minTools` (default 10) | Below it the extra lookup step costs more than the definitions. |
| Only `mcp__*` by default | Built-ins are few and used every turn; MCP tools come in bulk. `match` accepts any prefix. |
| Prefetch exists but is off by default | A lookup is a full model request (stateless APIs), so attaching likely tools before the model asks can remove it. Measured: with the `signature` index few lookups were left, and the attached details cost more than they saved. |
| `signature` index by default | Parameter names let models call most tools without a lookup; it brought every measured model to a saving (-15% to -56% per task). |
| Attached details go in a prompt context, not the tool list | Contexts are appended after the history and re-logged only when they change, so the cache holds. |
| At most 10 attached tools, a size budget, a minimum score | A request that matches everything must not undo the saving. |
| Plain `.mjs`, no imports from DSH | Loads as a single file from any patch row; nothing to build. |
