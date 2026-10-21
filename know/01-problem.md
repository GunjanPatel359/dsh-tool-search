# 1. The problem

- A model request carries every tool definition: name, description, JSON schema.
- It is resent on every step of every turn.
- MCP servers bring tools in bulk (20-100+ per server), most unused in a given conversation.
- Cost: thousands of input tokens per step before the conversation starts.
- Quality: with many similar tools, models pick worse.
- DSH has no built-in deferral; its MCP client says definitions "enter every request while the tools are registered".

Built-in tools (read, write, bash, ...) are few and used on most turns, so only MCP tools are deferred by default.
