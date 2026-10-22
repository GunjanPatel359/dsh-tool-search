/**
 * Name helpers: pure functions over tool schemas, with no dependency on the harness.
 * How they work: docs/name-matching.md.
 */

const MIN_FUZZY_LENGTH = 4
const MIN_SECOND_EDIT_LENGTH = 8
const MCP_MARKER = 'mcp'
const EXACT_WORD = 1
const TYPED_NEAR_IT = 0.75
const CAMEL_SEAM = /([a-z0-9])([A-Z])/g
const NOT_IN_A_WORD = /[^a-z0-9]+/
const MCP_SERVER = /^mcp__([^_](?:[^_]|_(?!_))*)__/

/** Split a tool name into lower-case words: `mcp__github__create_issue` -> mcp, github, create, issue. */
export function words(text) {
  return String(text ?? '')
    .replace(CAMEL_SEAM, '$1 $2')
    .toLowerCase()
    .split(NOT_IN_A_WORD)
    .filter(Boolean)
}

/** The server in an `mcp__<server>__<tool>` name, or undefined for any other name. */
export function serverOf(name) {
  const match = MCP_SERVER.exec(name)

  return match ? match[1] : undefined
}

/** Edit distance with swaps, exact up to `max`; past it, always `max + 1`. */
export function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1

  let rowAbove = []
  for (let column = 0; column <= b.length; column++) rowAbove.push(column)

  let rowBefore = null

  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let rowMinimum = i

    for (let j = 1; j <= b.length; j++) {
      const deleteFromA = rowAbove[j] + 1
      const insertIntoA = row[j - 1] + 1
      const substitute = rowAbove[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      let cell = Math.min(deleteFromA, insertIntoA, substitute)

      if (i >= 2 && j >= 2 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cell = Math.min(cell, rowBefore[j - 2] + 1)
      }

      row.push(cell)
      if (cell < rowMinimum) rowMinimum = cell
    }

    if (rowMinimum > max) return max + 1

    rowBefore = rowAbove
    rowAbove = row
  }

  return Math.min(rowAbove[b.length], max + 1)
}

/** Whether two words read as one word with a typo in it. */
function closeSpelling(a, b) {
  const shorter = Math.min(a.length, b.length)
  if (shorter < MIN_FUZZY_LENGTH) return false

  const budget = shorter >= MIN_SECOND_EDIT_LENGTH ? 2 : 1

  return distance(a, b, budget) <= budget
}

/** Whether any of these words reads as `word` with a typo in it. */
function mistypedAs(word, candidates) {
  for (const candidate of candidates) {
    if (closeSpelling(word, candidate)) return true
  }

  return false
}

/** Best score first, then by name. */
function byCloseness(a, b) {
  if (b.score !== a.score) return b.score - a.score

  return a.name.localeCompare(b.name)
}

/** Up to `limit` real names closest to one that does not exist, best first. */
export function suggest(tools, wanted, limit = 5) {
  const wantedWords = words(wanted).filter(word => word !== MCP_MARKER)
  if (wantedWords.length === 0) return []

  const scored = []
  for (const tool of tools) {
    const toolWords = words(tool.name).filter(word => word !== MCP_MARKER)
    let shared = 0

    for (const word of wantedWords) {
      if (toolWords.includes(word)) shared += EXACT_WORD
      else if (mistypedAs(word, toolWords)) shared += TYPED_NEAR_IT
    }

    if (shared === 0) continue

    const longer = Math.max(wantedWords.length, toolWords.length)

    scored.push({ name: tool.name, score: shared / longer })
  }

  scored.sort(byCloseness)

  return scored.slice(0, limit).map(match => match.name)
}
