/**
 * The plugin's own text and configuration helpers, tested as plain functions: no registry, no
 * agent, no model. Each one decides what a request's tool description says, so the exact text is
 * the contract and these tests quote it in full where the text is the point.
 *
 * The same helpers running inside a real DSH assembly: tests/plugin.spec.mjs.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULTS,
  buildIndex,
  describeDetails,
  isDeferrable,
  renderDetails,
  resolveConfig,
  signature,
  summary,
} from '../src/index.mjs'

const TWO_WORDS = { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] }

function tool(name, description = `${name} does the thing. Detail the index leaves out.`, parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

/** Three servers, one of them not MCP-shaped, so grouping has something to say about all of them. */
const CATALOGUE = [
  tool('mcp__slack__post_message', 'post message on slack.'),
  tool('mcp__github__create_issue', 'create issue on github.', TWO_WORDS),
  tool('mcp__github__list_issues', 'list issues on github.'),
  tool('web_search', 'search the web.'),
]

describe('resolveConfig', () => {
  it('starts from the defaults', () => {
    expect(resolveConfig()).toEqual(DEFAULTS)
    expect(resolveConfig({ minTools: 3 })).toMatchObject({ minTools: 3, indexStyle: 'signature' })
  })

  it('leaves the defaults untouched', () => {
    const before = JSON.stringify(DEFAULTS)
    resolveConfig({ indexStyle: 'names' })
    expect(JSON.stringify(DEFAULTS)).toBe(before)
  })

  it('takes any index style it knows', () => {
    for (const indexStyle of ['names', 'summary', 'signature']) {
      expect(resolveConfig({ indexStyle }).indexStyle).toBe(indexStyle)
    }
  })

  it('refuses a tool name that is not a tool name', () => {
    for (const bad of ['bad name', '', 'a'.repeat(65), 'tool.details', 42, null]) {
      expect(() => resolveConfig({ detailsToolName: bad })).toThrow(/detailsToolName/)
      expect(() => resolveConfig({ callToolName: bad })).toThrow(/callToolName/)
    }
  })

  it('refuses the name DSH reserves for a PTC program', () => {
    expect(() => resolveConfig({ callToolName: 'run_code' })).toThrow(/reserves/)
    expect(() => resolveConfig({ detailsToolName: 'run_code' })).toThrow(/reserves/)
  })

  it('refuses reading and running with the same name', () => {
    expect(() => resolveConfig({ detailsToolName: 'x', callToolName: 'x' })).toThrow(/must differ/)
  })

  it('refuses prefixes that are not a list of strings', () => {
    for (const key of ['match', 'exclude', 'alwaysLoad']) {
      expect(() => resolveConfig({ [key]: 'mcp__' })).toThrow(new RegExp(key))
      expect(() => resolveConfig({ [key]: [3] })).toThrow(new RegExp(key))
    }
  })

  it('refuses counts that cannot work', () => {
    expect(() => resolveConfig({ maxDetails: 0 })).toThrow(/maxDetails/)
    expect(() => resolveConfig({ minTools: -1 })).toThrow(/minTools/)
    expect(() => resolveConfig({ indexChars: 1.5 })).toThrow(/indexChars/)
    expect(() => resolveConfig({ summaryChars: '120' })).toThrow(/summaryChars/)
  })

  it('refuses an unknown index style', () => {
    expect(() => resolveConfig({ indexStyle: 'full' })).toThrow(/names, summary, signature/)
  })
})

describe('isDeferrable', () => {
  const config = resolveConfig({ exclude: ['mcp__slack__keep_'], alwaysLoad: ['mcp__github__ping'] })

  it('defers what matches and nothing else', () => {
    expect(isDeferrable('mcp__github__create_issue', config)).toBe(true)
    expect(isDeferrable('read', config)).toBe(false)
  })

  it('never defers its own two tools', () => {
    expect(isDeferrable('tool_details', config)).toBe(false)
    expect(isDeferrable('call_tool', config)).toBe(false)
  })

  it('honours alwaysLoad over match, and exclude over match', () => {
    expect(isDeferrable('mcp__github__ping', config)).toBe(false)
    expect(isDeferrable('mcp__slack__keep_channel', config)).toBe(false)
    expect(isDeferrable('mcp__slack__post_message', config)).toBe(true)
  })

  it('defers only what the configured prefixes say', () => {
    const custom = resolveConfig({ match: ['mcp__', 'web_'] })
    expect(isDeferrable('web_search', custom)).toBe(true)
    expect(isDeferrable('read', custom)).toBe(false)
    expect(isDeferrable('web_search', config)).toBe(false)
  })
})

describe('summary', () => {
  it('keeps the first sentence of the first line', () => {
    expect(summary('Create an issue. Needs write access.\nMore.', 120)).toBe('Create an issue.')
    expect(summary('No full stop here', 120)).toBe('No full stop here')
  })

  it('stops at any sentence ending', () => {
    expect(summary('Wow! Then more.', 120)).toBe('Wow!')
    expect(summary('Really? Then more.', 120)).toBe('Really?')
  })

  it('cuts a long sentence', () => {
    expect(summary('a'.repeat(200), 20)).toBe(`${'a'.repeat(17)}...`)
  })

  it('never goes past the limit', () => {
    for (let limit = 0; limit <= 40; limit++) {
      expect(summary('Create an issue that takes a while to explain.', limit).length).toBeLessThanOrEqual(limit)
    }
  })

  it('respects a limit too small for an ellipsis', () => {
    expect(summary('Create an issue.', 4)).toBe('C...')
    expect(summary('Create an issue.', 3)).toBe('Cre')
    expect(summary('Create an issue.', 0)).toBe('')
  })

  it('says nothing about a tool that described nothing', () => {
    expect(summary(undefined, 120)).toBe('')
    expect(summary('   ', 120)).toBe('')
  })
})

describe('signature', () => {
  it('lists the parameter names, optional ones last and marked', () => {
    expect(signature(TWO_WORDS)).toBe('(title, body?)')
    expect(signature({ type: 'object', properties: { path: {}, content: {}, mode: {} }, required: ['path', 'content'] })).toBe('(path, content, mode?)')
  })

  it('keeps the order the schema declares them in', () => {
    expect(signature({ properties: { zeta: {}, alpha: {} } })).toBe('(zeta?, alpha?)')
  })

  it('writes empty parentheses when there is nothing to pass', () => {
    expect(signature(undefined)).toBe('()')
    expect(signature({})).toBe('()')
    expect(signature({ type: 'object', properties: {} })).toBe('()')
  })
})

describe('buildIndex', () => {
  it('groups by server, with the servers and the names inside each sorted', () => {
    expect(buildIndex(CATALOGUE, DEFAULTS)).toBe([
      'github:',
      '- mcp__github__create_issue(title, body?): create issue on github.',
      '- mcp__github__list_issues(): list issues on github.',
      'other:',
      '- web_search(): search the web.',
      'slack:',
      '- mcp__slack__post_message(): post message on slack.',
    ].join('\n'))
  })

  it('writes the same text whatever order the tools arrived in', () => {
    expect(buildIndex([...CATALOGUE].reverse(), DEFAULTS)).toBe(buildIndex(CATALOGUE, DEFAULTS))
  })

  it('writes one line per tool in each style', () => {
    const one = [tool('mcp__github__create_issue', 'create issue on github.', TWO_WORDS)]
    expect(buildIndex(one, resolveConfig({ indexStyle: 'names' }))).toBe('github:\n- mcp__github__create_issue')
    expect(buildIndex(one, resolveConfig({ indexStyle: 'summary' }))).toBe('github:\n- mcp__github__create_issue: create issue on github.')
    expect(buildIndex(one, DEFAULTS)).toBe('github:\n- mcp__github__create_issue(title, body?): create issue on github.')
  })

  it('cuts each summary to summaryChars', () => {
    const index = buildIndex(CATALOGUE, resolveConfig({ summaryChars: 10 }))
    expect(index).toContain('- mcp__slack__post_message(): post me...')
    expect(index).toContain('- mcp__github__create_issue(title, body?): create...')
  })

  it('drops the summaries but never a name once the budget runs out', () => {
    const index = buildIndex(CATALOGUE, resolveConfig({ indexChars: 90 }))
    const namesOnly = index.split('\n').at(-1)

    expect(namesOnly).toMatch(/^Also available \(ask tool_details for what they do\): /)
    for (const t of CATALOGUE) expect(index).toContain(t.name)
    expect(index).not.toContain('search the web')
  })

  it('never advertises a server with nothing under it', () => {
    for (const indexChars of [0, 40, 90, 140, 400]) {
      const lines = buildIndex(CATALOGUE, resolveConfig({ indexChars })).split('\n')
      const headers = lines.map((line, at) => [line, at]).filter(([line]) => line.endsWith(':'))

      // A header is only ever followed by its own tools, so one at the end would advertise an empty server.
      for (const [, at] of headers) expect(lines[at + 1]).toMatch(/^- /)
    }
  })

  it('lists names only, when not even a server header fits', () => {
    const index = buildIndex(CATALOGUE, resolveConfig({ indexChars: 0 }))
    expect(index.split('\n')).toHaveLength(1)
    for (const t of CATALOGUE) expect(index).toContain(t.name)
  })

  it('asks the configured details tool in the name-only line', () => {
    const config = resolveConfig({ detailsToolName: 'find_tools', indexChars: 0 })
    expect(buildIndex(CATALOGUE, config)).toContain('Also available (ask find_tools for what they do):')
  })
})

describe('describeDetails', () => {
  it('counts the tools it is indexing', () => {
    expect(describeDetails(CATALOGUE, DEFAULTS)).toContain('Available tools (4):')
    expect(describeDetails([], DEFAULTS)).toContain('Available tools (0):')
  })

  it('tells the model to check the index before claiming a gap', () => {
    expect(describeDetails(CATALOGUE, DEFAULTS)).toContain('Check this index before saying a capability is missing.')
  })

  it('lets the model call directly when the signature says enough', () => {
    expect(describeDetails(CATALOGUE, DEFAULTS)).toContain('clear from the signature below, call it directly')
  })

  it('makes the model read first when it only gave names', () => {
    const text = describeDetails(CATALOGUE, resolveConfig({ indexStyle: 'summary', callToolName: 'use_tool', detailsToolName: 'find_tools' }))
    expect(text).toContain('call find_tools with its exact name')
    expect(text).toContain('then run it with use_tool')
    expect(text).not.toContain('call it directly')
  })
})

describe('renderDetails', () => {
  const value = (tools = [], unknown = [], truncated = 0) => ({ tools, unknown, truncated })

  it('shows each tool in full and how to run it', () => {
    const text = renderDetails(value([{ name: 'mcp__github__create_issue', description: 'Create an issue.', parameters: TWO_WORDS }]), DEFAULTS)
    expect(text).toBe([
      '## mcp__github__create_issue',
      'Create an issue.',
      `Parameters: ${JSON.stringify(TWO_WORDS)}`,
      '',
      'Run one with call_tool({"name": "<tool name>", "arguments": {...}}).',
    ].join('\n'))
  })

  it('answers a name that does not exist with the closest real ones', () => {
    const text = renderDetails(value([], [{ name: 'mcp__github__create_isue', closest: ['mcp__github__create_issue'] }]), DEFAULTS)
    expect(text).toContain('No tool named "mcp__github__create_isue". Closest: mcp__github__create_issue.')
  })

  it('points back at the index when nothing is close', () => {
    const text = renderDetails(value([], [{ name: 'kubernetes_pods', closest: [] }]), DEFAULTS)
    expect(text).toContain('No tool named "kubernetes_pods". Use a name from the index in tool_details\'s description.')
  })

  it('says how many names it left out', () => {
    expect(renderDetails(value([], [], 3), DEFAULTS)).toContain('3 more name(s) not shown: ask for at most 10 at a time.')
  })

  it('says something useful when the call asked for nothing', () => {
    expect(renderDetails(value(), DEFAULTS)).toBe('Nothing to show: ask tool_details with exact names from the index.')
    expect(renderDetails(value(), resolveConfig({ detailsToolName: 'find_tools' }))).toContain('ask find_tools')
  })

  it('survives a tool that has neither description nor parameters', () => {
    expect(renderDetails(value([{ name: 'mcp__x__y' }]), DEFAULTS)).toContain('Parameters: {}')
  })
})
