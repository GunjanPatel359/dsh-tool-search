/**
 * dsh-tool-search: progressive disclosure of tools for DSH (built on DeepSeek Harness).
 *
 * Every tool definition is resent on every model request. An agent with a few MCP servers can
 * carry hundreds of definitions it never uses, which costs tokens on each step and makes the
 * model choose worse. This plugin keeps the matching tools (by default every `mcp__*` tool) out
 * of the request and gives the model one `tool_search` tool in their place. A search loads the
 * tools it finds for that agent, and from the next step on they are sent like any other tool.
 *
 * How it hides them: a scoped listener on `system-prompt/assemble`, the one place the tool list
 * of every request passes through. `ctx.tools.restrict()` would be the first choice, but it only
 * reaches tools a scope inherits, and MCP servers mounted through an ACP session are registered
 * on the agent's own scope, where a restriction does not apply. Hidden tools stay registered,
 * so a call to one by name still runs, and it loads that tool for the steps after it.
 */

import { search, serverOf } from './search.mjs'

export const name = 'dsh-tool-search'
export const inject = ['tools', 'systemPrompt']

/** The defaults, each overridable from the plugin's configuration. */
export const DEFAULTS = Object.freeze({
  /** The name the model calls the search tool by. */
  toolName: 'tool_search',
  /** A tool whose name starts with one of these is deferred. */
  match: ['mcp__'],
  /** Tools sent from the first step whatever `match` says. */
  alwaysLoad: [],
  /** Defer only when at least this many tools match; fewer cost less than a search does. */
  minTools: 10,
  /** Matches a keyword search returns when the model does not say. */
  defaultLimit: 5,
  /** The most matches one search may return. */
  maxLimit: 20,
  /** The most deferred names listed in the search tool's description. */
  maxListed: 200,
})

/** Merge and check a configuration. Throws on a value that cannot work. */
export function resolveConfig(config = {}) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  if (typeof resolved.toolName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(resolved.toolName)) {
    throw new Error(`dsh-tool-search: toolName must be 1-64 letters, digits, "_" or "-", got ${JSON.stringify(resolved.toolName)}`)
  }
  for (const key of ['match', 'alwaysLoad']) {
    if (!Array.isArray(resolved[key]) || resolved[key].some(v => typeof v !== 'string')) {
      throw new Error(`dsh-tool-search: ${key} must be a list of strings`)
    }
  }
  for (const key of ['minTools', 'defaultLimit', 'maxLimit', 'maxListed']) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 0) {
      throw new Error(`dsh-tool-search: ${key} must be a whole number of 0 or more`)
    }
  }
  if (resolved.defaultLimit < 1 || resolved.maxLimit < resolved.defaultLimit) {
    throw new Error('dsh-tool-search: need 1 <= defaultLimit <= maxLimit')
  }
  return resolved
}

/** Whether a tool is one this configuration defers. */
export function isDeferrable(toolName, config) {
  return toolName !== config.toolName
    && !config.alwaysLoad.includes(toolName)
    && config.match.some(prefix => toolName.startsWith(prefix))
}

const BASE_DESCRIPTION = [
  'Search for tools that are available but not loaded yet, and load them.',
  'Loaded tools can be called directly from the next step on. Search before saying a capability is missing.',
  'Query forms: keywords ("create issue"), "+word" to require a word in the tool name ("+github issue"),',
  'or "select:name_a,name_b" to load tools by exact name.',
].join(' ')

/** The search tool's description: what it does, then the names it can load. */
export function describe(deferred, config) {
  if (deferred.length === 0) return BASE_DESCRIPTION
  const names = deferred.map(t => t.name).sort()
  const listed = names.slice(0, config.maxListed)
  let text = `${BASE_DESCRIPTION}\n\nTools available to load (${names.length}): ${listed.join(', ')}`
  if (names.length > listed.length) {
    const servers = new Map()
    for (const name of names.slice(listed.length)) {
      const server = serverOf(name) ?? 'other'
      servers.set(server, (servers.get(server) ?? 0) + 1)
    }
    const rest = [...servers].map(([server, count]) => `${count} from ${server}`).join(', ')
    text += `, and ${names.length - listed.length} more (${rest}); search to find them.`
  }
  return text
}

/** The schema the model sees for the search tool. */
function parameters(config) {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords, "+word" for a required name word, or "select:name_a,name_b".',
      },
      limit: {
        type: 'integer',
        description: `Most tools to load for a keyword query (default ${config.defaultLimit}, at most ${config.maxLimit}).`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    loaded: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' } },
        required: ['name', 'description'],
      },
    },
    missing: { type: 'array', items: { type: 'string' } },
  },
  required: ['loaded', 'missing'],
}

/** What the model reads back from a search. */
export function renderResult(value) {
  const lines = []
  if (value.loaded.length > 0) {
    lines.push(`Loaded ${value.loaded.length} tool${value.loaded.length === 1 ? '' : 's'}; call them directly from your next step:`)
    for (const tool of value.loaded) lines.push(`- ${tool.name}: ${firstLine(tool.description)}`)
  } else {
    lines.push('No tools matched. Try other keywords, or "select:" with a name from the list in this tool\'s description.')
  }
  if (value.missing.length > 0) lines.push(`Not available: ${value.missing.join(', ')}`)
  return lines.join('\n')
}

function firstLine(text) {
  const line = String(text ?? '').split('\n')[0].trim()
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

/**
 * One agent's state: the deferrable tools seen at its last assembly, and the ones it has loaded.
 * Kept per agent, so a sub-agent searches and loads on its own.
 */
export class AgentTools {
  constructor(config) {
    this.config = config
    this.catalog = []
    this.loaded = new Set()
  }

  /** Rewrite one assembly's tool list: hide what is deferred, and describe what can be loaded. */
  filter(tools) {
    const deferrable = tools.filter(t => isDeferrable(t.name, this.config))
    this.catalog = deferrable.map(t => ({ name: t.name, description: t.description ?? '' }))
    if (deferrable.length < Math.max(1, this.config.minTools)) {
      // Too few to be worth a search: send everything, and not the search tool.
      return tools.filter(t => t.name !== this.config.toolName)
    }
    const deferred = this.catalog.filter(t => !this.loaded.has(t.name))
    return tools
      .filter(t => !isDeferrable(t.name, this.config) || this.loaded.has(t.name))
      .map(t => (t.name === this.config.toolName ? { ...t, description: describe(deferred, this.config) } : t))
  }

  /** Run one search and load what it found. */
  find(query, limit) {
    const capped = Math.min(Math.max(1, Number.isInteger(limit) ? limit : this.config.defaultLimit), this.config.maxLimit)
    const { matches, missing } = search(this.catalog, query, capped)
    for (const tool of matches) this.loaded.add(tool.name)
    return {
      loaded: matches.map(t => ({ name: t.name, description: t.description })),
      missing,
    }
  }

  /** A deferred tool called by name is loaded from then on, so its schema is there next time. */
  noteCall(toolName) {
    if (isDeferrable(toolName, this.config)) this.loaded.add(toolName)
  }
}

/** The search tool for one agent. */
export function searchTool(state) {
  const config = state.config
  return {
    name: config.toolName,
    description: BASE_DESCRIPTION,
    parameters: parameters(config),
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      return state.find(args?.query, args?.limit)
    },
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.on('agent/created', ({ agent }) => {
    const scope = agent.ctx
    const state = new AgentTools(resolved)
    scope.effect(() => scope.tools.register(searchTool(state)))
    scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      assembled.tools = state.filter(assembled.tools)
      return assembled
    })
    scope.on('tools/pre-execute', (exec, next) => {
      state.noteCall(exec.name)
      return next()
    })
  })
}
