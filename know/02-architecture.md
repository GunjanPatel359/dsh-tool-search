# 2. Architecture

One DSH plugin, no runtime dependencies, two source files.

```
DSH host
├── tool registry (ctx.tools)          global tools + per-agent scoped tools (MCP over ACP lands here)
├── prompt assembly (ctx.systemPrompt) builds one assembly per model step: sections + tools
└── dsh-tool-search
    ├── on agent/created, per agent:
    │   ├── AgentTools state           the agent's deferred tools, from its latest assembly
    │   ├── tool_details  (registered) description = the index; returns full definitions by name
    │   ├── call_tool     (registered) runs a deferred tool as a nested registry call
    │   └── system-prompt/assemble     scoped waterfall listener: hides deferred tools, writes the index
    └── search.mjs                     name helpers: words, serverOf, suggest (closest names)
```

What the model sees each step:

```
[built-in tools] + [excluded / alwaysLoad tools] + tool_details{index} + call_tool
```

The index: every deferred tool's name, parameter names and the first sentence of its description
(`indexStyle: signature`; also `summary` or `names`), grouped by server, sorted.
