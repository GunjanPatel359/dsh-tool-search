/**
 * Name helpers. Pure functions over tool schemas ({ name, description }), with no dependency on
 * the harness, so they can be tested and reused on their own.
 */

/** Split a tool name into lower-case words: `mcp__github__create_issue` -> mcp, github, create, issue. */
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

/** Edit distance between two short strings, stopping early past `max`. */
export function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, current[j])
    }
    if (best > max) return max + 1
    previous = current
  }
  return previous[b.length]
}

/** A likely typo: one edit in words of 4 letters or more, two in words of 8 or more. */
function closeSpelling(a, b) {
  const shorter = Math.min(a.length, b.length)
  if (shorter < 4) return false
  const allowed = shorter >= 8 ? 2 : 1
  return distance(a, b, allowed) <= allowed
}

/**
 * The real names closest to one the model asked for but that does not exist: a typo, a missing
 * server prefix, or a tool whose server has gone. Names sharing more words rank higher; a close
 * spelling counts as a shared word.
 * @returns up to `limit` names, best first; empty when nothing is close.
 */
export function suggest(tools, wanted, limit = 5) {
  const target = words(wanted).filter(w => w !== 'mcp')
  if (target.length === 0) return []
  const scored = []
  for (const tool of tools) {
    const candidate = words(tool.name).filter(w => w !== 'mcp')
    let shared = 0
    for (const word of target) {
      if (candidate.includes(word)) shared += 1
      else if (candidate.some(c => closeSpelling(word, c))) shared += 0.75
    }
    if (shared > 0) scored.push({ name: tool.name, score: shared / Math.max(target.length, candidate.length) })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(s => s.name)
}

/** Words that say nothing about which tool is meant. */
const STOPWORDS = new Set(`a an and are as at be but by can could do does for from get give has have how i if in
into is it its me my of on or our please should so some than that the their them then there these this to
tool tools up use using via want was we what when where which who why will with would you your`.split(/\s+/))

/** A crude stem, enough to match `issues` with `issue` and `listing` with `list`. */
export function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  // "-es" is a suffix only after s, x, z, ch or sh (boxes, processes); in "issues" the e is the word's own.
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** The words of a text worth matching on, stemmed, without stopwords and bare numbers. */
export function terms(text) {
  return [...new Set(words(text).filter(w => !STOPWORDS.has(w) && !/^\d+$/.test(w) && w.length > 1).map(stem))]
}

/**
 * The tools a request most likely needs, by plain word overlap: a request word in the tool's own
 * name counts 3, in its description 1, in its server's name 1. A server match alone never qualifies
 * a tool, so "on github" does not pull in every GitHub tool.
 * @param tools - schemas with name and description.
 * @param text - the request.
 * @param limit - the most tools to return.
 * @param minScore - the least score a tool needs.
 * @returns the best matches, best first.
 */
export function rank(tools, text, limit = 5, minScore = 3) {
  const wanted = terms(text)
  if (wanted.length === 0 || limit < 1) return []
  const scored = []
  for (const tool of tools) {
    const server = serverOf(tool.name)
    const serverTerms = new Set(server ? terms(server) : [])
    const nameTerms = new Set(terms(tool.name).filter(w => w !== 'mcp' && !serverTerms.has(w)))
    const descriptionTerms = new Set(terms(tool.description))
    let score = 0
    let specific = 0
    for (const word of wanted) {
      if (nameTerms.has(word)) { score += 3; specific += 1 }
      else if (descriptionTerms.has(word)) { score += 1; specific += 1 }
      if (serverTerms.has(word)) score += 1
    }
    if (specific > 0 && score >= minScore) scored.push({ tool, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(entry => entry.tool)
}
