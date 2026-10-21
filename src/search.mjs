/**
 * Ranking for tool search. Pure functions over tool schemas ({ name, description }), with no
 * dependency on the harness, so they can be tested and reused on their own.
 */

/** Split a tool name or a query into lower-case words: `mcp__github__create_issue` -> mcp, github, create, issue. */
export function words(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * The server a tool came from, when its name has the MCP shape `mcp__<server>__<tool>`.
 * @returns the server name, or undefined for any other name.
 */
export function serverOf(name) {
  const match = /^mcp__([^_](?:[^_]|_(?!_))*)__/.exec(name)
  return match ? match[1] : undefined
}

/**
 * Parse a query. `select:a,b` names tools exactly; anything else is keywords, where a word
 * starting with `+` is required to appear in the tool's name.
 */
export function parseQuery(query) {
  const text = String(query ?? '').trim()
  if (text.toLowerCase().startsWith('select:')) {
    const names = text.slice('select:'.length).split(',').map(s => s.trim()).filter(Boolean)
    return { kind: 'select', names }
  }
  const required = []
  const optional = []
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('+') && raw.length > 1) required.push(...words(raw.slice(1)))
    else optional.push(...words(raw))
  }
  return { kind: 'keywords', required, optional }
}

/**
 * Score one tool against keywords. A word in the tool's own name counts most, then the server
 * name, then the description. Zero means no match.
 */
export function score(tool, required, optional) {
  const server = serverOf(tool.name)
  const serverWords = new Set(server ? words(server) : [])
  const nameWords = new Set(words(tool.name).filter(w => w !== 'mcp' && !serverWords.has(w)))
  const descriptionWords = new Set(words(tool.description))
  const nameText = tool.name.toLowerCase()

  for (const word of required) {
    if (!nameWords.has(word) && !serverWords.has(word) && !nameText.includes(word)) return 0
  }

  let total = 0
  for (const word of [...required, ...optional]) {
    if (nameWords.has(word)) total += 4
    else if (nameText.includes(word)) total += 2
    if (serverWords.has(word)) total += 2
    if (descriptionWords.has(word)) total += 1
    else if (word.length >= 4 && [...descriptionWords].some(d => d.startsWith(word))) total += 0.5
  }
  return total
}

/**
 * Find the tools a query asks for.
 * @param tools - the searchable tool schemas.
 * @param query - `select:a,b`, or keywords.
 * @param limit - the most matches to return for a keyword query.
 * @returns `{ matches, missing }`: the matched schemas best first, and for `select:` the names
 *   that are not among the tools.
 */
export function search(tools, query, limit = 5) {
  const parsed = parseQuery(query)
  if (parsed.kind === 'select') {
    const byName = new Map(tools.map(t => [t.name, t]))
    const matches = []
    const missing = []
    for (const name of parsed.names) {
      const tool = byName.get(name)
      if (tool) matches.push(tool)
      else missing.push(name)
    }
    return { matches, missing }
  }
  if (parsed.required.length === 0 && parsed.optional.length === 0) return { matches: [], missing: [] }
  const matches = tools
    .map(tool => ({ tool, score: score(tool, parsed.required, parsed.optional) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.max(1, limit))
    .map(entry => entry.tool)
  return { matches, missing: [] }
}
