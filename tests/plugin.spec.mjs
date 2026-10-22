/**
 * The plugin against the real DSH tool registry and prompt assembly: tools are registered on
 * agent scopes exactly as an ACP session's MCP servers are, every check reads the assembly a model
 * request would carry, and calls go through the registry's own execute pipeline.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as ToolSearch from '../src/index.mjs'

const signal = new AbortController().signal

const ISSUE_PARAMS = {
  type: 'object',
  properties: { title: { type: 'string' }, body: { type: 'string' } },
  required: ['title'],
}

function tool(name, description = `tool ${name}`, parameters = { type: 'object', properties: {} }, run) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: run ?? (args => Promise.resolve(`ran:${name}:${JSON.stringify(args)}`)),
  }
}

/** Twelve tools from two servers, enough to pass the default minTools of 10. */
const GITHUB = ['create_issue', 'list_issues', 'get_issue', 'create_pull_request', 'merge_pull_request', 'search_code']
const SLACK = ['post_message', 'list_channels', 'get_thread', 'add_reaction', 'search_messages', 'upload_file']

async function harness(config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolSearch, config)
  ctx.tools.register(tool('read', 'Read a file'))

  async function agent(id, presentation) {
    const key = { id }
    let scope
    await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
    key.ctx = scope.ctx
    if (presentation) key.ctx.tools.presentAs(presentation)
    ctx.emit('agent/created', { agent: key })
    return key
  }

  const mcp = (key, server, names) => {
    for (const n of names) {
      const full = `mcp__${server}__${n}`
      const description = `${n.replace(/_/g, ' ')} on ${server}. Longer detail that the index leaves out.`
      key.ctx.tools.register(n === 'create_issue' ? tool(full, description, ISSUE_PARAMS) : tool(full, description))
    }
  }
  const assemble = async key => (await ctx.systemPrompt.assemble({ scope: key })).tools
  const visible = async key => (await assemble(key)).map(t => t.name).sort()
  const call = (key, name, args = {}) => ctx.tools.execute({ signal, callId: 'c1', name, arguments: args, agent: key })
  const text = result => result.content.map(c => c.text).join('\n')
  return { ctx, agent, mcp, assemble, visible, call, text }
}

async function withTools(config) {
  const h = await harness(config)
  const a = await h.agent('a')
  h.mcp(a, 'github', GITHUB)
  h.mcp(a, 'slack', SLACK)
  await h.assemble(a) // the first step's assembly, which fills the agent's catalogue
  return { ...h, a }
}

describe('dsh-tool-search', () => {
  it('sends an index of names and summaries in place of the definitions', async () => {
    const { assemble, visible, a } = await withTools()
    expect(await visible(a)).toEqual(['call_tool', 'read', 'tool_details'])
    const index = (await assemble(a)).find(t => t.name === 'tool_details').description
    expect(index).toContain('Available tools (12)')
    expect(index).toContain('github:\n- mcp__github__create_issue(title, body?): create issue on github.')
    expect(index).toContain('slack:')
    expect(index).not.toContain('Longer detail')
  })

  it('keeps the tool list identical while the model reads details and runs tools', async () => {
    const { assemble, call, a } = await withTools()
    const before = JSON.stringify(await assemble(a))
    await call(a, 'tool_details', { names: ['mcp__github__create_issue'] })
    await call(a, 'call_tool', { name: 'mcp__github__create_issue', arguments: { title: 'x' } })
    expect(JSON.stringify(await assemble(a))).toBe(before)
  })

  it('returns the full description and parameters of the named tools', async () => {
    const { call, text, a } = await withTools()
    const result = await call(a, 'tool_details', { names: ['mcp__github__create_issue', 'mcp__slack__post_message'] })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('## mcp__github__create_issue')
    expect(text(result)).toContain('Longer detail that the index leaves out.')
    expect(text(result)).toContain(JSON.stringify(ISSUE_PARAMS))
    expect(text(result)).toContain('## mcp__slack__post_message')
  })

  it('answers a wrong name with the closest real ones', async () => {
    const { call, text, a } = await withTools()
    const result = await call(a, 'tool_details', { names: ['mcp__github__create_isue', 'github_create_issue'] })
    expect(text(result)).toContain('No tool named "mcp__github__create_isue". Closest: mcp__github__create_issue')
    expect(text(result)).toContain('No tool named "github_create_issue". Closest: mcp__github__create_issue')
  })

  it('caps how many tools one call returns', async () => {
    const { call, text, a } = await withTools({ maxDetails: 2 })
    const names = GITHUB.slice(0, 4).map(n => `mcp__github__${n}`)
    const result = await call(a, 'tool_details', { names })
    expect(result.value.tools).toHaveLength(2)
    expect(text(result)).toContain('2 more name(s) not shown')
  })

  it('runs a hidden tool with call_tool and hands back its result', async () => {
    const { call, text, a } = await withTools()
    const result = await call(a, 'call_tool', { name: 'mcp__github__create_issue', arguments: { title: 'Bug' } })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:mcp__github__create_issue:{"title":"Bug"}')
  })

  it('runs the nested call through the registry pipeline under the real name', async () => {
    const { ctx, call, text, a } = await withTools()
    const seen = []
    ctx.on('tools/pre-execute', (exec, next) => {
      seen.push(exec.name)
      return exec.name === 'mcp__slack__post_message' ? { kind: 'deny', reason: 'Blocked by policy.' } : next()
    })
    const result = await call(a, 'call_tool', { name: 'mcp__slack__post_message', arguments: {} })
    expect(seen).toEqual(['call_tool', 'mcp__slack__post_message'])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Blocked by policy.')
  })

  it('reports a failing tool as a failed call', async () => {
    const h = await harness({ minTools: 1 })
    const a = await h.agent('a')
    a.ctx.tools.register(tool('mcp__x__boom', 'Always fails.', undefined, () => Promise.reject(new Error('kaboom'))))
    await h.assemble(a)
    const result = await h.call(a, 'call_tool', { name: 'mcp__x__boom' })
    expect(result.isError).toBe(true)
    expect(h.text(result)).toContain('kaboom')
  })

  it('refuses a name that is not a deferred tool, with suggestions', async () => {
    const { call, text, a } = await withTools()
    const missing = await call(a, 'call_tool', { name: 'mcp__github__creat_issue' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('Closest: mcp__github__create_issue')
    // A tool that is not deferred is called directly, never through call_tool.
    expect((await call(a, 'call_tool', { name: 'read' })).isError).toBe(true)
  })

  it('keeps each agent to its own tools', async () => {
    const h = await harness()
    const a = await h.agent('a')
    const b = await h.agent('b')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    h.mcp(b, 'slack', [...SLACK, 'pin_message', 'set_topic', 'archive_channel', 'invite_user'])
    await h.assemble(a)
    await h.assemble(b)
    expect((await h.call(b, 'call_tool', { name: 'mcp__github__create_issue' })).isError).toBe(true)
    const index = (await h.assemble(b)).find(t => t.name === 'tool_details').description
    expect(index).not.toContain('github')
  })

  it('sends everything when too few tools match to be worth it', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', ['create_issue', 'list_issues'])
    expect(await h.visible(a)).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues', 'read'])
  })

  it('honours exclude, alwaysLoad and the tool names', async () => {
    const h = await harness({
      detailsToolName: 'find_tools',
      callToolName: 'use_tool',
      exclude: ['mcp__slack__'],
      alwaysLoad: ['mcp__github__create_issue'],
      minTools: 1,
    })
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    const names = await h.visible(a)
    expect(names).toContain('find_tools')
    expect(names).toContain('use_tool')
    expect(names).toContain('mcp__github__create_issue')
    expect(names).toContain('mcp__slack__post_message')
    expect(names).not.toContain('mcp__github__list_issues')
  })

  it('defers tools registered globally too, not only on the agent', async () => {
    const h = await harness({ minTools: 1 })
    for (const n of GITHUB) h.ctx.tools.register(tool(`mcp__github__${n}`))
    const a = await h.agent('a')
    expect(await h.visible(a)).toEqual(['call_tool', 'read', 'tool_details'])
  })

  it('lists every name even when the summaries do not fit', async () => {
    const { assemble, a } = await withTools({ indexChars: 200 })
    const index = (await assemble(a)).find(t => t.name === 'tool_details').description
    expect(index).toContain('Also available (ask tool_details for what they do):')
    for (const n of [...GITHUB, ...SLACK]) expect(index).toContain(n)
  })

  it('writes the index in each style', async () => {
    const index = async indexStyle => {
      const { assemble, a } = await withTools({ indexStyle })
      return (await assemble(a)).find(t => t.name === 'tool_details').description
    }
    expect(await index('names')).toContain('- mcp__github__create_issue\n')
    expect(await index('summary')).toContain('- mcp__github__create_issue: create issue on github.')
    const signed = await index('signature')
    expect(signed).toContain('- mcp__github__create_issue(title, body?): create issue on github.')
    expect(signed).toContain('call it directly')
  })

  it('refuses a tool name this agent already has, instead of shadowing it', async () => {
    const h = await harness({ detailsToolName: 'read', minTools: 1 })
    await expect(h.agent('a')).rejects.toThrow(/detailsToolName is "read", a tool this agent already has/)
    expect(h.ctx.tools.get('read').description).toBe('Read a file')
  })

  it('gives every server in the index a tool under it', async () => {
    const { assemble, a } = await withTools({ indexChars: 300 })
    const index = (await assemble(a)).find(t => t.name === 'tool_details').description
    expect(index).not.toContain('slack:')
    for (const n of [...GITHUB, ...SLACK]) expect(index).toContain(n)
  })

  it('lists names only when not even a server header fits', async () => {
    const { assemble, a } = await withTools({ indexChars: 10 })
    const index = (await assemble(a)).find(t => t.name === 'tool_details').description
    expect(index.split('\n').filter(line => /^[a-z0-9_]+:$/.test(line))).toEqual([])
    for (const n of [...GITHUB, ...SLACK]) expect(index).toContain(n)
  })

  it('names the configured details tool in the name-only list', async () => {
    const { assemble, a } = await withTools({ detailsToolName: 'find_tools', callToolName: 'use_tool', indexChars: 300 })
    const index = (await assemble(a)).find(t => t.name === 'find_tools').description
    expect(index).toContain('Also available (ask find_tools for what they do):')
  })

  it('answers a details call that asked for nothing', async () => {
    const { call, text, a } = await withTools()
    expect(text(await call(a, 'tool_details', { names: [] }))).toContain('Nothing to show')
    expect(text(await call(a, 'tool_details', {}))).toContain('Nothing to show')
  })

  it('stands down for an agent in PTC mode, whose programs see every tool anyway', async () => {
    const h = await harness()
    const a = await h.agent('a', 'ptc')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    expect(h.ctx.tools.get('tool_details', a)).toBeUndefined()
    expect(h.ctx.tools.get('call_tool', a)).toBeUndefined()
    expect(h.ctx.tools.get('mcp__github__create_issue', a)).toBeDefined()
    // A native agent beside it still gets the index.
    const b = await h.agent('b', 'native')
    h.mcp(b, 'github', GITHUB)
    h.mcp(b, 'slack', SLACK)
    expect(await h.visible(b)).toEqual(['call_tool', 'read', 'tool_details'])
  })

  it('leaves a structured-output child its structured_output tool', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    // Registered the way dsh-subagent registers it on a child that must answer in a schema.
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
    a.ctx.tools.register({
      name: 'structured_output',
      description: 'Report your final structured result.',
      parameters: schema,
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'Structured output recorded.' }] },
      execute: (_args, exec) => { exec.concludeTurn(); return Promise.resolve({ recorded: true }) },
    })
    const tools = await h.assemble(a)
    expect(tools.find(t => t.name === 'structured_output').parameters).toEqual(schema)
    expect(tools.find(t => t.name === 'tool_details').description).not.toContain('structured_output')
    const result = await h.call(a, 'structured_output', { answer: '42' })
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBe(true)
  })

  it('refuses a configuration that cannot work', () => {
    expect(() => ToolSearch.resolveConfig({ callToolName: 'run_code' })).toThrow(/reserves/)
    expect(() => ToolSearch.resolveConfig({ indexStyle: 'full' })).toThrow(/indexStyle/)
    expect(() => ToolSearch.resolveConfig({ detailsToolName: 'bad name' })).toThrow(/detailsToolName/)
    expect(() => ToolSearch.resolveConfig({ callToolName: 'tool_details' })).toThrow(/must differ/)
    expect(() => ToolSearch.resolveConfig({ match: 'mcp__' })).toThrow(/match/)
    expect(() => ToolSearch.resolveConfig({ maxDetails: 0 })).toThrow(/maxDetails/)
  })
})
