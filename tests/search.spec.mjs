import { describe, expect, it } from 'vitest'
import { parseQuery, search, serverOf, words } from '../src/search.mjs'

const tools = [
  { name: 'mcp__github__create_issue', description: 'Create a new issue in a repository' },
  { name: 'mcp__github__list_issues', description: 'List issues in a repository' },
  { name: 'mcp__github__create_pull_request', description: 'Open a pull request' },
  { name: 'mcp__slack__post_message', description: 'Post a message to a channel' },
  { name: 'mcp__slack__search_messages', description: 'Search messages across channels' },
  { name: 'mcp__my_db__run_query', description: 'Run a read-only SQL query' },
]

describe('words and names', () => {
  it('splits snake, kebab and camel case', () => {
    expect(words('mcp__github__create_issue')).toEqual(['mcp', 'github', 'create', 'issue'])
    expect(words('postMessage-now')).toEqual(['post', 'message', 'now'])
  })

  it('reads the server out of an MCP name, single underscores included', () => {
    expect(serverOf('mcp__github__create_issue')).toBe('github')
    expect(serverOf('mcp__my_db__run_query')).toBe('my_db')
    expect(serverOf('read')).toBeUndefined()
  })

  it('parses the three query forms', () => {
    expect(parseQuery('select:a, b')).toEqual({ kind: 'select', names: ['a', 'b'] })
    expect(parseQuery('+github issue')).toEqual({ kind: 'keywords', required: ['github'], optional: ['issue'] })
  })
})

describe('search', () => {
  it('ranks a name match above a description match', () => {
    const { matches } = search(tools, 'issue', 5)
    expect(matches.map(t => t.name).slice(0, 2).sort()).toEqual(['mcp__github__create_issue', 'mcp__github__list_issues'])
  })

  it('requires +words to be in the name or server', () => {
    const { matches } = search(tools, '+slack message', 5)
    expect(matches.map(t => t.name).sort()).toEqual(['mcp__slack__post_message', 'mcp__slack__search_messages'])
  })

  it('finds by description when the name says nothing', () => {
    expect(search(tools, 'sql', 5).matches.map(t => t.name)).toEqual(['mcp__my_db__run_query'])
  })

  it('respects the limit', () => {
    expect(search(tools, 'github', 2).matches).toHaveLength(2)
  })

  it('returns nothing for an empty or unmatched query', () => {
    expect(search(tools, '   ', 5).matches).toEqual([])
    expect(search(tools, 'kubernetes', 5).matches).toEqual([])
  })

  it('selects exact names and reports the missing ones', () => {
    const { matches, missing } = search(tools, 'select:mcp__slack__post_message,nope', 5)
    expect(matches.map(t => t.name)).toEqual(['mcp__slack__post_message'])
    expect(missing).toEqual(['nope'])
  })
})
