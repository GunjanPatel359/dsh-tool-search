/**
 * Compare e2e runs from `dsh --profile headless --json` output: model steps, tokens (provider
 * reported, with cache reads), the tools the model called, and whether it finished.
 *
 *   node e2e/summarize.mjs <out-dir>        # reads baseline-N.jsonl and plugin-N.jsonl
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function summarize(file) {
  // MCP servers sometimes write to the same stdout; keep only the JSON event lines.
  const events = readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { return line.startsWith('{') ? [JSON.parse(line)] : [] } catch { return [] }
  })
  const steps = []
  const calls = []
  let answer = ''
  let error = ''
  for (const event of events) {
    if (event.type === 'status' && event.phase === 'step_end' && event.usage) steps.push(event.usage)
    if (event.type === 'tool_call') {
      if (event.tool === 'call_tool') calls.push(`call_tool(${event.input?.name})`)
      else if (event.tool === 'tool_details') calls.push(`tool_details(${(event.input?.names ?? []).join(', ')})`)
      else calls.push(event.tool)
    }
    if (event.type === 'final') answer = event.text ?? ''
    if (event.type === 'status' && event.reason?.kind === 'error') error = event.reason.error?.message ?? 'error'
    if (event.type === 'error') error = event.message
  }
  const sum = key => steps.reduce((total, usage) => total + (usage[key] ?? 0), 0)
  // Prompt = total - output: providers differ on whether inputTokens includes cache reads.
  const prompt = usage => (usage.totalTokens ?? 0) - (usage.outputTokens ?? 0)
  const first = steps[0] ? prompt(steps[0]) : 0
  return {
    steps: steps.length,
    firstPrompt: first,
    prompt: steps.reduce((total, usage) => total + prompt(usage), 0),
    input: sum('inputTokens'),
    cached: sum('cacheReadTokens'),
    output: sum('outputTokens'),
    total: sum('totalTokens'),
    calls,
    finished: !error && answer.trim().length > 0,
    error,
    answer,
  }
}

const dir = process.argv[2]
const files = readdirSync(dir).filter(f => /^(baseline|plugin)-\d+\.jsonl$/.test(f)).sort()
const runs = { baseline: [], plugin: [] }
for (const f of files) runs[f.startsWith('plugin') ? 'plugin' : 'baseline'].push({ file: f, ...summarize(join(dir, f)) })

const mean = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
const span = xs => (xs.length > 1 ? ` (${Math.min(...xs)}-${Math.max(...xs)})` : '')
const cell = (side, key) => `${mean(runs[side].map(r => r[key]))}${span(runs[side].map(r => r[key]))}`
const change = key => {
  const b = mean(runs.baseline.map(r => r[key]))
  const p = mean(runs.plugin.map(r => r[key]))
  return b ? `${p >= b ? '+' : ''}${Math.round(((p - b) / b) * 100)}%` : ''
}

console.log(`\n${dir}: ${runs.baseline.length} baseline run(s), ${runs.plugin.length} plugin run(s); means, (min-max)\n`)
console.log(`${''.padEnd(30)}${'baseline'.padStart(22)}${'plugin'.padStart(22)}${'change'.padStart(9)}`)
for (const [label, key] of [
  ['model steps', 'steps'],
  ['first-step prompt tokens', 'firstPrompt'],
  ['input tokens (all)', 'prompt'],
  ['  reported uncached', 'input'],
  ['  reported cache reads', 'cached'],
  ['output tokens', 'output'],
  ['total tokens', 'total'],
]) console.log(`${label.padEnd(30)}${cell('baseline', key).padStart(22)}${cell('plugin', key).padStart(22)}${change(key).padStart(9)}`)
const done = side => `${runs[side].filter(r => r.finished).length}/${runs[side].length}`
console.log(`${'finished the task'.padEnd(30)}${done('baseline').padStart(22)}${done('plugin').padStart(22)}`)

for (const side of ['baseline', 'plugin']) {
  for (const r of runs[side]) {
    console.log(`\n== ${r.file}: ${r.steps} steps, ${r.total} tokens${r.error ? `, ERROR: ${r.error}` : ''}`)
    console.log(`calls: ${r.calls.join(' -> ') || '(none)'}`)
  }
}
