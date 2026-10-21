# 8. Limits and next steps

- One `tool_details` step before a deferred tool's first use in a conversation (until compaction drops the result).
- Arguments are checked by the tool, not by the provider's schema enforcement.
- UIs show `call_tool` as the outer step.
- Models prefer directly visible tools: when a built-in overlaps an MCP tool, the built-in wins. Use `exclude` / `alwaysLoad` for MCP tools that must be the path.
- Not tested with PTC mode or structured-output children.
- Written against DSH 0.2.x; DSH is pre-1.0.

Next:
- Fewer steps: a stronger hint to batch independent `call_tool`s; keep MCP tools that overlap built-ins visible by default.
- Repeat the e2e on long multi-turn conversations, where the plugin should gain most.
- Native mode: on routes with DSH in-history tool updates (`toolUpdate`), load real definitions instead of `call_tool`.
- More providers and larger catalogues in the e2e matrix.
