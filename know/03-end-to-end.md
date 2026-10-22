# 3. How a request flows, end to end

1. **Boot.** DSH loads the plugin row (`cordis.patch.yml` or a `--patch`). `apply()` validates the config and listens for `agent/created`.
2. **Agent created.** For each agent (sub-agents too) the plugin creates an `AgentTools` state, registers `tool_details` and `call_tool` on the agent's own scope, and adds a scoped `system-prompt/assemble` listener. All of it unwinds when the agent is disposed.
3. **MCP servers connect.** `dsh-mcp-client` registers their tools as `mcp__<server>__<tool>`, globally or on the agent's scope (ACP `mcpServers`).
4. **Each model step: assembly.** DSH assembles sections and tools. The plugin's listener runs after the others (`await next()`), then:
   - collects the deferrable tools (`match` prefixes, minus `exclude`, minus `alwaysLoad`) into the agent's catalogue;
   - if fewer than `minTools`, leaves everything as is and hides its own two tools;
   - otherwise removes the deferred tools and sets `tool_details`' description to the index.
5. **The model picks names** from the index and calls `tool_details({names})`. It gets each tool's full description and JSON schema back as a normal tool result (stays in history, cached).
6. **The model calls `call_tool({name, arguments})`** (directly, when the signature makes the parameters clear). The plugin checks the name is in the catalogue, then calls `ctx.tools.execute()` with the real name, the agent, the signal, and the outer call's `rootCallId` / `token`. The registry runs its full pipeline: `tools/pre-execute` policies, guards, approvals, the tool, post-execute.
7. **Result.** A failure or denial becomes a failed `call_tool`. A success hands back the nested content unchanged (images included) through `finalizeContent`; deferred contexts and `concludeTurn` are forwarded.
8. **Next step.** The assembly is identical to the last one (same tools, same index), so the provider's prompt cache keeps the whole prefix.
