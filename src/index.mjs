/**
 * dsh-tool-search: deferred tool loading for DSH (built on DeepSeek Harness).
 *
 * Every tool definition is resent on every model request. An agent with a few MCP servers carries
 * hundreds of definitions it never uses, which costs tokens on each step and makes the model choose
 * worse. This plugin sends the matching tools (by default every `mcp__*` tool) as a compact index
 * instead: each tool's name and a one-line summary, in the description of a `tool_details` tool.
 * The model picks names from the index, reads their full description and parameters with
 * `tool_details`, and runs one with `call_tool`.
 *
 * The tool list the model sees never changes during a session. That is the point of `call_tool`:
 * adding a tool's definition mid-session would change the top of the request, and on most routes
 * the provider's prompt cache would then be rebuilt for the whole conversation, every time. Here
 * the details are an ordinary tool result, appended to the history and cached with it.
 *
 * How it hides tools: a scoped listener on `system-prompt/assemble`, the one place the tool list of
 * every request passes through. `ctx.tools.restrict()` cannot be used: it only reaches tools a
 * scope inherits, and MCP servers mounted through an ACP session are registered on the agent's own
 * scope. Hidden tools stay registered; `call_tool` runs them through the registry's own pipeline,
 * so permission policies, hooks and approvals see the real tool name and arguments.
 */

import { rank, serverOf, suggest } from './search.mjs'

export const name = 'dsh-tool-search'
export const inject = ['tools', 'systemPrompt']

/** The defaults, each overridable from the plugin's configuration. */
export const DEFAULTS = Object.freeze({
  /** The name the model reads tool details with. */
  detailsToolName: 'tool_details',
  /** The name the model runs a deferred tool with. */
  callToolName: 'call_tool',
  /** A tool whose name starts with one of these is deferred... */
  match: ['mcp__'],
  /** ...unless its name starts with one of these. */
  exclude: [],
  /** Exact names always sent in full, whatever `match` says. */
  alwaysLoad: [],
  /** Defer only when at least this many tools match; fewer cost less than the extra step does. */
  minTools: 10,
  /**
   * Tools whose full details are attached to each new user message, picked by matching the message
   * against the index, so the model can run them without a `tool_details` step. 0 turns it off;
   * never more than MAX_PREFETCH, however many tools match. Off by default: with the `signature`
   * index models rarely need a lookup, and in our runs the attached details cost more than they saved.
   */
  prefetch: 0,
  /** Characters of attached details per message: tools are added best first while they fit. */
  prefetchChars: 12000,
  /** The least match score a tool needs to be attached (a word in its name scores 3). */
  prefetchMinScore: 3,
  /** The most tools one `tool_details` call returns. */
  maxDetails: 10,
  /**
   * What each index line carries: 'names' (the name), 'summary' (name and the first sentence of
   * its description) or 'signature' (name, parameter names and summary; the model may then call a
   * simple tool without reading its details first).
   */
  indexStyle: 'signature',
  /** Characters of each tool's summary in the index. */
  summaryChars: 120,
  /** Characters of the whole index; past it, the remaining tools are listed by name only. */
  indexChars: 12000,
})

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const INDEX_STYLES = ['names', 'summary', 'signature']
/** The hard ceiling on attached tools: past it, a request that matches everything would undo the plugin. */
export const MAX_PREFETCH = 10

/** Merge and check a configuration. Throws on a value that cannot work. */
export function resolveConfig(config = {}) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  for (const key of ['detailsToolName', 'callToolName']) {
    if (typeof resolved[key] !== 'string' || !TOOL_NAME.test(resolved[key])) {
      throw new Error(`dsh-tool-search: ${key} must be 1-64 letters, digits, "_" or "-", got ${JSON.stringify(resolved[key])}`)
    }
  }
  if (resolved.detailsToolName === resolved.callToolName) {
    throw new Error('dsh-tool-search: detailsToolName and callToolName must differ')
  }
  for (const key of ['match', 'exclude', 'alwaysLoad']) {
    if (!Array.isArray(resolved[key]) || resolved[key].some(v => typeof v !== 'string')) {
      throw new Error(`dsh-tool-search: ${key} must be a list of strings`)
    }
  }
  for (const key of ['minTools', 'maxDetails', 'summaryChars', 'indexChars', 'prefetch', 'prefetchMinScore', 'prefetchChars']) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 0) {
      throw new Error(`dsh-tool-search: ${key} must be a whole number of 0 or more`)
    }
  }
  if (resolved.maxDetails < 1) throw new Error('dsh-tool-search: maxDetails must be at least 1')
  if (resolved.prefetch > MAX_PREFETCH) throw new Error(`dsh-tool-search: prefetch must be at most ${MAX_PREFETCH}`)
  if (!INDEX_STYLES.includes(resolved.indexStyle)) {
    throw new Error(`dsh-tool-search: indexStyle must be one of ${INDEX_STYLES.join(', ')}`)
  }
  return resolved
}

/** Whether a tool is one this configuration defers. */
export function isDeferrable(toolName, config) {
  return toolName !== config.detailsToolName
    && toolName !== config.callToolName
    && !config.alwaysLoad.includes(toolName)
    && config.match.some(prefix => toolName.startsWith(prefix))
    && !config.exclude.some(prefix => toolName.startsWith(prefix))
}

/** The first sentence of a description, cut to `limit` characters. */
export function summary(description, limit) {
  const line = String(description ?? '').trim().split('\n')[0].trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line
  return sentence.length > limit ? `${sentence.slice(0, Math.max(0, limit - 3)).trimEnd()}...` : sentence
}

/** A tool's parameter names, optional ones marked `?`: `(path, content, mode?)`. */
export function signature(parameters) {
  const properties = parameters?.properties ?? {}
  const required = new Set(parameters?.required ?? [])
  return `(${Object.keys(properties).map(key => (required.has(key) ? key : `${key}?`)).join(', ')})`
}

/** One index line, in the configured style. */
function indexLine(tool, config) {
  if (config.indexStyle === 'names') return `- ${tool.name}`
  const head = config.indexStyle === 'signature' ? `${tool.name}${signature(tool.parameters)}` : tool.name
  return `- ${head}: ${summary(tool.description, config.summaryChars)}`
}

/**
 * The index of deferred tools, grouped by server and sorted, so the same tools always give the
 * same text and the request prefix it sits in stays cacheable. Past `indexChars` the remaining
 * tools are listed by name only: every name is always there.
 */
export function buildIndex(tools, config) {
  const groups = new Map()
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const server = serverOf(tool.name) ?? 'other'
    if (!groups.has(server)) groups.set(server, [])
    groups.get(server).push(tool)
  }
  const lines = []
  const unsummarized = []
  let used = 0
  for (const [server, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${server}:`)
    used += server.length + 2
    for (const tool of group) {
      const line = indexLine(tool, config)
      if (unsummarized.length === 0 && used + line.length + 1 <= config.indexChars) {
        lines.push(line)
        used += line.length + 1
      } else {
        unsummarized.push(tool.name)
      }
    }
  }
  if (unsummarized.length > 0) lines.push(`Also available (ask tool_details for what they do): ${unsummarized.join(', ')}`)
  return lines.join('\n')
}

/** The details tool's description: how to use the two tools, then the index. */
export function describeDetails(deferred, config) {
  const how = config.indexStyle === 'signature'
    ? [
        `To use one, run it with ${config.callToolName}. When its parameters are clear from the signature below, call it directly;`,
        `otherwise read its full description and parameters first with ${config.detailsToolName} (several names at once if you need them).`,
      ]
    : [
        `To use one, call ${config.detailsToolName} with its exact name (several at once if you need them) to read its full description and parameters,`,
        `then run it with ${config.callToolName}.`,
      ]
  const head = [
    'More tools are available than are listed among your tools; they are indexed below.',
    ...how,
    ...(config.prefetch > 0
      ? [`The full details of the tools that best match the latest request may already follow the conversation; run those directly with ${config.callToolName}.`]
      : []),
    'Check this index before saying a capability is missing.',
  ].join(' ')
  return `${head}\n\nAvailable tools (${deferred.length}):\n${buildIndex(deferred, config)}`
}

/** One tool in full, as `tool_details` and the attached details write it. */
function detailBlock(tool) {
  return [`## ${tool.name}`, String(tool.description ?? '').trim(), `Parameters: ${JSON.stringify(tool.parameters ?? {})}`, ''].join('\n')
}

/**
 * The context attached to a user message: the matched tools in full, best first, at most
 * MAX_PREFETCH of them and only while they fit in `prefetchChars`. A tool too large to fit is
 * skipped rather than cut, so the model never sees half a schema.
 */
export function renderPrefetch(tools, config) {
  const head = `Tool details matched to the latest request (from the ${config.detailsToolName} index). Run any of them directly with ${config.callToolName}; use ${config.detailsToolName} only for other tools.`
  const blocks = []
  let used = head.length
  for (const tool of tools.slice(0, Math.min(config.prefetch, MAX_PREFETCH))) {
    const block = detailBlock(tool)
    if (used + block.length + 1 > config.prefetchChars) continue
    blocks.push(block)
    used += block.length + 1
  }
  if (blocks.length === 0) return ''
  return [head, '', ...blocks].join('\n').trimEnd()
}

/** What the model reads back: each tool in full, and the closest names for any it got wrong. */
export function renderDetails(value, config) {
  const lines = []
  for (const tool of value.tools) lines.push(detailBlock(tool))
  if (value.tools.length > 0) lines.push(`Run one with ${config.callToolName}({"name": "<tool name>", "arguments": {...}}).`)
  for (const miss of value.unknown) {
    lines.push(miss.closest.length > 0
      ? `No tool named "${miss.name}". Closest: ${miss.closest.join(', ')}.`
      : `No tool named "${miss.name}". Use a name from the index in ${config.detailsToolName}'s description.`)
  }
  if (value.truncated > 0) lines.push(`${value.truncated} more name(s) not shown: ask for at most ${config.maxDetails} at a time.`)
  return lines.join('\n')
}

const DETAILS_OUTPUT = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, parameters: {} },
        required: ['name', 'description'],
      },
    },
    unknown: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, closest: { type: 'array', items: { type: 'string' } } },
        required: ['name', 'closest'],
      },
    },
    truncated: { type: 'integer' },
  },
  required: ['tools', 'unknown', 'truncated'],
}

/**
 * One agent's view: the deferrable tools in full, as its latest assembly carried them. Kept per
 * agent, so each agent (sub-agents included) sees only the tools it actually has.
 */
export class AgentTools {
  constructor(config) {
    this.config = config
    this.catalog = new Map()
    this.request = ''
    this.attached = { request: undefined, text: '' }
  }

  /** Remember the latest user message; its matches are attached from the next assembly on. */
  noteRequest(text) {
    if (typeof text === 'string' && text.trim()) this.request = text
  }

  /**
   * The details to attach for the latest request: the same text for every step of a turn, so the
   * context snapshot (and the cache after it) only changes when a new user message arrives.
   * @param tools - the agent's visible tools for this assembly.
   */
  prefetchText(tools) {
    if (this.config.prefetch < 1 || !this.request) return ''
    if (this.attached.request === this.request) return this.attached.text
    const deferrable = tools.filter(t => isDeferrable(t.name, this.config))
    const active = deferrable.length >= Math.max(1, this.config.minTools)
    const limit = Math.min(this.config.prefetch, MAX_PREFETCH)
    const picked = active ? rank(deferrable, this.request, limit, this.config.prefetchMinScore) : []
    this.attached = { request: this.request, text: renderPrefetch(picked, this.config) }
    return this.attached.text
  }

  /** Rewrite one assembly's tool list: keep the deferred tools out, and put their index in. */
  filter(tools) {
    const { detailsToolName, callToolName } = this.config
    const deferrable = tools.filter(t => isDeferrable(t.name, this.config))
    this.catalog = new Map(deferrable.map(t => [t.name, t]))
    if (deferrable.length < Math.max(1, this.config.minTools)) {
      // Too few to be worth the extra step: send everything as it is, and not this plugin's tools.
      return tools.filter(t => t.name !== detailsToolName && t.name !== callToolName)
    }
    return tools
      .filter(t => !isDeferrable(t.name, this.config))
      .map(t => (t.name === detailsToolName ? { ...t, description: describeDetails(deferrable, this.config) } : t))
  }

  /** The full definitions of the named tools, and the closest real names for the rest. */
  details(names) {
    const wanted = [...new Set((Array.isArray(names) ? names : [names]).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()))]
    const asked = wanted.slice(0, this.config.maxDetails)
    const tools = []
    const unknown = []
    for (const name of asked) {
      const tool = this.catalog.get(name)
      if (tool) tools.push({ name, description: tool.description ?? '', parameters: tool.parameters ?? {} })
      else unknown.push({ name, closest: suggest([...this.catalog.values()], name) })
    }
    return { tools, unknown, truncated: wanted.length - asked.length }
  }
}

/** The details tool for one agent. Its description carries the index. */
export function detailsTool(state) {
  const config = state.config
  return {
    name: config.detailsToolName,
    description: describeDetails([], config),
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: `Exact tool names from the index (at most ${config.maxDetails}).`,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    output: { schema: DETAILS_OUTPUT, render: (_args, value) => [{ type: 'text', text: renderDetails(value, config) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      return state.details(args?.names)
    },
  }
}

/**
 * The call tool for one agent. It runs the deferred tool through the registry as a nested call of
 * its own, so pre-execute policies, guards and approvals apply to the real name and arguments, and
 * hands back the nested result's content unchanged (images included).
 */
export function callTool(state, tools) {
  const config = state.config
  const nested = new Map()
  const textOf = content => content.map(block => (block?.type === 'text' ? block.text : '')).filter(Boolean).join('\n')
  return {
    name: config.callToolName,
    description: `Run a tool from the index in ${config.detailsToolName}'s description. Read its parameters with ${config.detailsToolName} first; the arguments must follow them.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact tool name.' },
        arguments: { type: 'object', description: 'The tool\'s arguments, as its parameters describe.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const target = args?.name
      if (typeof target !== 'string' || !state.catalog.has(target)) {
        const closest = typeof target === 'string' ? suggest([...state.catalog.values()], target) : []
        throw new Error(`No tool named "${target}" to run.${closest.length ? ` Closest: ${closest.join(', ')}.` : ''}`)
      }
      const result = await tools.execute({
        callId: `${exec.callId}:${target}`,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        name: target,
        arguments: args.arguments ?? {},
        agent: exec.agent,
        signal: exec.signal,
      })
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      if (result.isError) throw new Error(textOf(result.content) || `${target} failed.`)
      if (result.concludesTurn) exec.concludeTurn()
      nested.set(exec.token, result.content)
      return result.value ?? null
    },
    finalizeContent(exec, result) {
      const content = nested.get(exec.token)
      nested.delete(exec.token)
      return result.isError ? undefined : content
    },
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.on('agent/created', ({ agent }) => {
    const scope = agent.ctx
    const state = new AgentTools(resolved)
    scope.effect(() => scope.tools.register(detailsTool(state)))
    scope.effect(() => scope.tools.register(callTool(state, ctx.tools)))
    scope.on('session/event', (_session, event) => {
      if (event?.type !== 'user/message' || event.data?.source?.kind === 'tool') return
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      state.noteRequest(content.filter(block => block?.type === 'text').map(block => block.text).join('\n'))
    })
    scope.effect(() => scope.systemPrompt.context({
      name: 'dsh-tool-search:prefetch',
      order: 5000,
      interpolate: false,
      required: true,
      text: context => state.prefetchText(ctx.tools.schemas(context?.scope ?? agent)),
    }))
    scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      assembled.tools = state.filter(assembled.tools)
      return assembled
    })
  })
}
