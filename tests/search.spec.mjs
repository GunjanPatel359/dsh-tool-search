/**
 * The name helpers on their own: no registry, no harness, only the tool shapes they read. The rule
 * each one follows, and the reason for it: docs/name-matching.md.
 */
import { describe, expect, it } from 'vitest'
import { distance, serverOf, suggest, words } from '../src/search.mjs'

const tools = [
  { name: 'mcp__github__create_issue' },
  { name: 'mcp__github__list_issues' },
  { name: 'mcp__github__create_pull_request' },
  { name: 'mcp__slack__post_message' },
  { name: 'mcp__slack__add_reaction' },
  { name: 'mcp__my_db__run_query' },
]

describe('words', () => {
  it('splits snake, kebab and camel case', () => {
    expect(words('mcp__github__create_issue')).toEqual(['mcp', 'github', 'create', 'issue'])
    expect(words('postMessage-now')).toEqual(['post', 'message', 'now'])
  })

  it('splits a capital that starts a word and keeps a digit with the word it belongs to', () => {
    expect(words('mcp__github__createIssueV2')).toEqual(['mcp', 'github', 'create', 'issue', 'v2'])
  })

  it('splits nothing that has no letters or digits in it', () => {
    expect(words('')).toEqual([])
    expect(words('___')).toEqual([])
    expect(words(undefined)).toEqual([])
  })
})

describe('serverOf', () => {
  it('reads the server out of an MCP name, single underscores included', () => {
    expect(serverOf('mcp__github__create_issue')).toBe('github')
    expect(serverOf('mcp__my_db__run_query')).toBe('my_db')
    expect(serverOf('read')).toBeUndefined()
  })

  it('resolves a name with more double underscores to the leftmost server', () => {
    expect(serverOf('mcp__a__b__c')).toBe('a')
  })

  it('refuses a name that is not the shape it reads', () => {
    expect(serverOf('mcp____tool')).toBeUndefined()
    expect(serverOf('mcp__github')).toBeUndefined()
    expect(serverOf('github__create_issue')).toBeUndefined()
  })

  it('matches the prefix the way the harness writes it, and not otherwise', () => {
    expect(serverOf('MCP__github__create_issue')).toBeUndefined()
  })
})

describe('distance', () => {
  it('measures edit distance inside the budget', () => {
    expect(distance('issue', 'isue')).toBe(1)
    expect(distance('create', 'creat')).toBe(1)
    expect(distance('create', 'cerate')).toBe(1)
    expect(distance('query', 'qurey')).toBe(1)
  })

  it('measures two edits, which is what a long word is allowed', () => {
    expect(distance('reaction', 'reaccton', 2)).toBe(2)
  })

  it('defaults to a budget of three', () => {
    expect(distance('channels', 'channrlse')).toBe(2)
  })

  it('counts an empty string as the other one whole', () => {
    expect(distance('', '', 3)).toBe(0)
    expect(distance('', 'abc', 3)).toBe(3)
    expect(distance('', 'abc', 2)).toBe(3)
  })

  it('takes a budget of zero as a real one: same or not', () => {
    expect(distance('issue', 'issue', 0)).toBe(0)
    expect(distance('issue', 'issuel', 0)).toBe(1)
  })

  it('reports max + 1, not a measurement, once past the budget', () => {
    expect(distance('github', 'slack', 2)).toBe(3)
    expect(distance('github', 'slack', 1)).toBe(2)
    expect(distance('instance', 'distance', 1)).toBe(2)
  })

  it('takes the length gap as evidence enough', () => {
    expect(distance('create_issue', 'run', 2)).toBe(3)
  })

  it('agrees with a plain optimal-string-alignment matrix on random pairs', () => {
    // Full matrix: no budget, no pruning, no row reuse (docs/name-matching.md).
    const reference = (a, b) => {
      const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
      for (let i = 0; i <= a.length; i++) d[i][0] = i
      for (let j = 0; j <= b.length; j++) d[0][j] = j
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
      return d[a.length][b.length]
    }
    // Seeded, so a failure reproduces; a three-letter alphabet, so pairs are related often enough.
    let seed = 1
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const word = () => Array.from({ length: Math.floor(random() * 8) }, () => 'abc'[Math.floor(random() * 3)]).join('')
    const wrong = []
    for (let n = 0; n < 120000 && wrong.length < 3; n++) {
      const a = word()
      const b = word()
      const max = Math.floor(random() * 4)
      const truth = reference(a, b)
      const want = truth <= max ? truth : max + 1
      if (distance(a, b, max) !== want) wrong.push({ a, b, max, got: distance(a, b, max), want })
    }
    expect(wrong).toEqual([])
  })
})

describe('suggest', () => {
  it('finds the intended name behind a typo', () => {
    expect(suggest(tools, 'mcp__github__create_isue')[0]).toBe('mcp__github__create_issue')
  })

  it('finds a name behind a swapped pair of letters', () => {
    expect(suggest(tools, 'mcp__github__cerate_issue')[0]).toBe('mcp__github__create_issue')
    expect(suggest(tools, 'run_qurey')[0]).toBe('mcp__my_db__run_query')
  })

  it('finds a name given without its server prefix', () => {
    expect(suggest(tools, 'post_message')[0]).toBe('mcp__slack__post_message')
    expect(suggest(tools, 'run_query')[0]).toBe('mcp__my_db__run_query')
  })

  it('allows two mistakes in a word of eight letters or more, and none in a shorter one', () => {
    expect(suggest(tools, 'add_reaccton')[0]).toBe('mcp__slack__add_reaction')
    expect(suggest(tools, 'qerry')).toEqual([])
  })

  it('never guesses at a word too short to tell one from another', () => {
    // `run_query` is one edit away, and "sun" is three letters: too little shared to call a typo.
    expect(suggest(tools, 'sun')).toEqual([])
  })

  it('ranks the name sharing the most of the query first', () => {
    expect(suggest(tools, 'github_create_issue')).toEqual([
      'mcp__github__create_issue',
      'mcp__github__list_issues',
      'mcp__github__create_pull_request',
    ])
  })

  it('answers at most the number of names asked for', () => {
    expect(suggest(tools, 'issue', 1)).toEqual(['mcp__github__create_issue'])
    expect(suggest(tools, 'issue')).toHaveLength(2)
  })

  it('returns nothing when nothing is close', () => {
    expect(suggest(tools, 'kubernetes_pods')).toEqual([])
    expect(suggest(tools, '')).toEqual([])
  })

  it('returns nothing for a query that is only the mcp marker', () => {
    expect(suggest(tools, 'mcp__')).toEqual([])
  })
})
