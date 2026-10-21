/**
 * The plugin against the real DSH tool registry and prompt assembly: tools are registered on
 * agent scopes exactly as an ACP session's MCP servers are, and every check reads the assembly
 * a model request would carry.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as ToolSearch from '../src/index.mjs'

const signal = new AbortController().signal

function tool(name, description = `tool ${name}`) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: () => Promise.resolve(`ran:${name}`),
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

  async function agent(id) {
    const key = { id }
    let scope
    await ctx.plugin(Object.assign(inner => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
    key.ctx = scope.ctx
    ctx.emit('agent/created', { agent: key })
    return key
  }

  const mcp = (key, server, names) => {
    for (const n of names) key.ctx.tools.register(tool(`mcp__${server}__${n}`, `${n.replace(/_/g, ' ')} on ${server}`))
  }
  const visible = async key => (await ctx.systemPrompt.assemble({ scope: key })).tools.map(t => t.name).sort()
  const call = async (key, name, args = {}) => {
    const result = await ctx.tools.execute({ signal, callId: 'c1', name, arguments: args, agent: key })
    return result.content.map(c => c.text).join('\n')
  }
  return { ctx, agent, mcp, visible, call }
}

describe('dsh-tool-search', () => {
  it('hides the MCP tools and offers the search tool in their place', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)

    expect(await h.visible(a)).toEqual(['read', 'tool_search'])
    const assembly = await h.ctx.systemPrompt.assemble({ scope: a })
    const description = assembly.tools.find(t => t.name === 'tool_search').description
    expect(description).toContain('Tools available to load (12)')
    expect(description).toContain('mcp__github__create_issue')
  })

  it('loads what a search finds, from the next assembly on', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    await h.visible(a) // the first step's assembly, which fills the catalogue

    const text = await h.call(a, 'tool_search', { query: '+github issue', limit: 2 })
    expect(text).toContain('Loaded 2 tools')

    const now = await h.visible(a)
    expect(now.filter(n => n.startsWith('mcp__'))).toHaveLength(2)
    expect(now.every(n => !n.startsWith('mcp__') || n.startsWith('mcp__github__'))).toBe(true)
    const description = (await h.ctx.systemPrompt.assemble({ scope: a })).tools.find(t => t.name === 'tool_search').description
    expect(description).toContain('Tools available to load (10)')
  })

  it('loads exact names with select:, and names the ones it does not have', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    await h.visible(a)

    const text = await h.call(a, 'tool_search', { query: 'select:mcp__slack__post_message,mcp__nope__x' })
    expect(text).toContain('mcp__slack__post_message')
    expect(text).toContain('Not available: mcp__nope__x')
    expect(await h.visible(a)).toEqual(['mcp__slack__post_message', 'read', 'tool_search'])
  })

  it('keeps each agent\'s loads to itself', async () => {
    const h = await harness()
    const a = await h.agent('a')
    const b = await h.agent('b')
    for (const key of [a, b]) {
      h.mcp(key, 'github', GITHUB)
      h.mcp(key, 'slack', SLACK)
      await h.visible(key)
    }

    await h.call(a, 'tool_search', { query: 'select:mcp__github__search_code' })
    expect(await h.visible(a)).toContain('mcp__github__search_code')
    expect(await h.visible(b)).toEqual(['read', 'tool_search'])
  })

  it('sends everything when too few tools match to be worth a search', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', ['create_issue', 'list_issues'])
    expect(await h.visible(a)).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues', 'read'])
  })

  it('still runs a hidden tool called by name, and loads it for later steps', async () => {
    const h = await harness()
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    await h.visible(a)

    expect(await h.call(a, 'mcp__slack__get_thread')).toBe('ran:mcp__slack__get_thread')
    expect(await h.visible(a)).toContain('mcp__slack__get_thread')
  })

  it('honours alwaysLoad, match and toolName', async () => {
    const h = await harness({ toolName: 'find_tools', alwaysLoad: ['mcp__github__create_issue'], minTools: 1, match: ['mcp__github__'] })
    const a = await h.agent('a')
    h.mcp(a, 'github', GITHUB)
    h.mcp(a, 'slack', SLACK)
    const names = await h.visible(a)
    expect(names).toContain('find_tools')
    expect(names).toContain('mcp__github__create_issue')
    expect(names).toContain('mcp__slack__post_message')
    expect(names).not.toContain('mcp__github__list_issues')
  })

  it('defers tools registered globally too, not only on the agent', async () => {
    const h = await harness({ minTools: 1 })
    for (const n of GITHUB) h.ctx.tools.register(tool(`mcp__github__${n}`))
    const a = await h.agent('a')
    expect(await h.visible(a)).toEqual(['read', 'tool_search'])
  })

  it('refuses a configuration that cannot work', () => {
    expect(() => ToolSearch.resolveConfig({ toolName: 'bad name' })).toThrow(/toolName/)
    expect(() => ToolSearch.resolveConfig({ match: 'mcp__' })).toThrow(/match/)
    expect(() => ToolSearch.resolveConfig({ defaultLimit: 30, maxLimit: 20 })).toThrow(/defaultLimit/)
  })
})
