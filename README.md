# dsh-tool-search

Tool search for [DSH](https://github.com/deepseek-ai/deepseek-harness). Built on DeepSeek Harness; not an official DeepSeek project.

Every tool definition is sent again on every model request. Connect a few MCP servers and an agent carries hundreds of definitions it never uses: thousands of tokens on every step, and a model that picks tools worse because it has too many to choose from.

`dsh-tool-search` keeps those tools out of the request and gives the model one `tool_search` tool in their place. The model searches when it needs something, the matching tools load for that agent, and from the next step on they are sent like any other tool.

```
before: read, write, bash, mcp__github__create_issue, mcp__github__list_issues, ... (180 tools)
after:  read, write, bash, tool_search
        ↓ model calls tool_search("+github issue")
        read, write, bash, tool_search, mcp__github__create_issue, mcp__github__list_issues
```

## Install

As a bundle in a profile:

```sh
dsh plugin --profile tui add dsh-tool-search
dsh --profile tui
```

Or from a checkout, for one run:

```sh
git clone https://github.com/<you>/dsh-tool-search
cd dsh-tool-search
dsh tui --patch ./examples/local.patch.yml
```

The plugin has no runtime dependencies and imports nothing from DSH, so it also loads as a single file through any patch row whose `name` points at `src/index.mjs`.

## How the model uses it

The search tool's description lists the names of the tools it can load, so the model knows what exists without paying for every schema. Three query forms:

| Query | Loads |
|---|---|
| `create issue` | the best keyword matches, by name, then server, then description |
| `+github issue` | only tools whose name or server contains `github` |
| `select:mcp__slack__post_message,mcp__slack__get_thread` | exactly those tools |

`limit` caps a keyword search (default 5, at most 20). A tool the model calls by name without searching still runs, and is loaded from then on.

## Configuration

```yaml
- id: dsh-tool-search
  name: dsh-tool-search
  config:
    toolName: tool_search     # what the model calls it
    match: ['mcp__']          # name prefixes to defer
    alwaysLoad: []            # exact names always sent
    minTools: 10              # defer only when at least this many match
    defaultLimit: 5
    maxLimit: 20
    maxListed: 200            # names listed in the search tool's description
```

A patch replaces a row's whole `config`, so restate every key you set.

Below `minTools` matching tools, nothing is hidden and the search tool is not offered: a handful of definitions costs less than an extra step.

## How it works

DSH builds one prompt assembly per model step, and every tool the model sees passes through the `system-prompt/assemble` waterfall. On `agent/created` the plugin gives each agent its own state, registers the search tool on the agent's scope, and adds a scoped listener on that waterfall which removes the deferred tools that agent has not loaded.

It does not use `ctx.tools.restrict()`, the registry's own filter, because a restriction only reaches tools a scope inherits. MCP servers mounted through an ACP session (`session/new` with `mcpServers`) are registered on the agent's own scope, where a restriction does not apply. Filtering the assembly covers both kinds.

Hidden tools stay registered: execution, permissions and hooks see them exactly as before. Only what the model is shown changes.

Each agent searches and loads on its own, sub-agents included, and its state goes when the agent is disposed.

## Trade-offs

- **Prompt cache.** Loading a tool changes the tool list, which invalidates the provider's cached prefix from the tool definitions onward, once per search. Many tools sent every step costs more than that for most sessions; a session that loads one tool per step does not benefit.
- **One extra step** before the first use of a deferred tool.
- **Loaded tools are kept in memory.** A resumed session starts with nothing loaded; tools the model already used load again on their first call.
- **Not tested with PTC mode** or structured-output children, which also rewrite the assembly.

## Development

```sh
npm install
npm test
```

The tests mount the real DSH tool registry and prompt assembly (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-scope`), register MCP-shaped tools on agent scopes the way an ACP session does, and read the assembly a model request would carry.

Written against DSH 0.2.x. The extension points it uses are documented, but DSH is pre-1.0 and they can change between releases.

## License

MIT
