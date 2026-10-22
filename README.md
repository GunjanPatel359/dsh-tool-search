# dsh-tool-search

Deferred tool loading for [DSH](https://github.com/deepseek-ai/deepseek-harness). Built on DeepSeek Harness; not an official DeepSeek project.

## The problem

Every tool definition is sent again on every model request. Connect a few MCP servers and an agent carries hundreds of definitions it never uses: thousands of tokens on every step, and a model that picks tools worse because it has too many to choose from.

## What it does

`dsh-tool-search` sends those tools as a short index instead: each tool's **name, parameters and one-line summary**, grouped by server. When the model needs one, it reads the full details with `tool_details` and runs it with `call_tool`.

```
without:  read, bash, mcp__github__create_issue {full schema}, mcp__github__list_issues {full schema}, ... ×180
with:     read, bash, tool_details {index: 180 names + one-liners}, call_tool
```

- **Fewer tokens on every request.** The MCP tools cost about 88% less per request.
- **The prompt cache keeps working.** The tool list stays the same for the whole session, so loading a tool never forces the provider to re-read the conversation at full price.
- **The model doesn't miss tools.** Every tool is always named in the index, and a wrong name (a typo, a missing `mcp__server__` prefix) gets the closest real names back.
- **Nothing is bypassed.** Permission policies, approvals and hooks still see the real tool and its arguments.

## Does it save tokens?

Yes. One small task, three runs per cell, with real MCP servers:

| Model | Without the plugin | With it | Change |
|---|---|---|---|
| DeepSeek deepseek-flash, 25 MCP tools | 80,777 | 58,864 | **-27%** |
| DeepSeek deepseek-flash, 75 MCP tools | 183,274 | 79,838 | **-56%** |
| Claude claude-haiku-5-5, 25 MCP tools | 110,598 | 94,422 | **-15%** |
| OpenAI gpt-5.4-mini, 25 MCP tools | 50,846 | 23,398 | **-54%** |

And over a 5-message conversation in one session (DeepSeek, two of the messages need no tools):

| Servers | Without the plugin | With it | Change |
|---|---|---|---|
| 25 MCP tools | 159,736 | 106,398 | **-33%** |
| 75 MCP tools | 317,040 | 147,120 | **-54%** |

Tokens summed over every model step. Every run finished its task with and without the plugin. The more tools you connect, the more it saves.

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

With fewer than `minTools` matching tools nothing changes: a handful of definitions costs less than an extra step.

Keep tools the agent uses on most turns out of the index with `exclude` or `alwaysLoad`.

## Trade-offs

- **Sometimes one extra step** (`tool_details`) before a deferred tool is first used in a conversation.
- **Arguments are checked by the tool, not by the provider.** A wrong argument comes back as the tool's own error.
- **UIs show `call_tool`** as the outer step, with the real tool inside it.

## Compatibility

- **Native tool calls:** the mode the plugin is built for.
- **PTC mode** (`run_code`): the plugin steps aside for those agents and adds nothing to their requests. In PTC mode the model calls tools from code, and DSH already lists every tool for that code.
- **Sub-agents and structured-output children:** each agent gets its own index of its own tools. A child's `structured_output` tool stays a normal tool.

Written for DSH 0.2.x. DSH is pre-1.0, so its plugin interfaces can change between releases.

## License

MIT
