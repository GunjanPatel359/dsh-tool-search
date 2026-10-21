import { describe, expect, it } from 'vitest'
import { summary } from '../src/index.mjs'
import { distance, serverOf, suggest, words } from '../src/search.mjs'

const tools = [
  { name: 'mcp__github__create_issue' },
  { name: 'mcp__github__list_issues' },
  { name: 'mcp__github__create_pull_request' },
  { name: 'mcp__slack__post_message' },
  { name: 'mcp__my_db__run_query' },
]

describe('names', () => {
  it('splits snake, kebab and camel case', () => {
    expect(words('mcp__github__create_issue')).toEqual(['mcp', 'github', 'create', 'issue'])
    expect(words('postMessage-now')).toEqual(['post', 'message', 'now'])
  })

  it('reads the server out of an MCP name, single underscores included', () => {
    expect(serverOf('mcp__github__create_issue')).toBe('github')
    expect(serverOf('mcp__my_db__run_query')).toBe('my_db')
    expect(serverOf('read')).toBeUndefined()
  })

  it('measures edit distance, and stops early', () => {
    expect(distance('issue', 'isue')).toBe(1)
    expect(distance('create', 'creat')).toBe(1)
    expect(distance('github', 'slack', 2)).toBe(3)
  })
})

describe('suggest', () => {
  it('finds the intended name behind a typo', () => {
    expect(suggest(tools, 'mcp__github__create_isue')[0]).toBe('mcp__github__create_issue')
  })

  it('finds a name given without its server prefix', () => {
    expect(suggest(tools, 'post_message')[0]).toBe('mcp__slack__post_message')
    expect(suggest(tools, 'run_query')[0]).toBe('mcp__my_db__run_query')
  })

  it('returns nothing when nothing is close', () => {
    expect(suggest(tools, 'kubernetes_pods')).toEqual([])
    expect(suggest(tools, '')).toEqual([])
  })
})

describe('summary', () => {
  it('keeps the first sentence of the first line', () => {
    expect(summary('Create an issue. Needs write access.\nMore.', 120)).toBe('Create an issue.')
    expect(summary('No full stop here', 120)).toBe('No full stop here')
  })

  it('cuts a long sentence', () => {
    expect(summary('a'.repeat(200), 20)).toBe(`${'a'.repeat(17)}...`)
  })
})
