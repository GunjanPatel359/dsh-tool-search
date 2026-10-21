/**
 * Compare two e2e runs from `dsh --profile headless --json` output: model steps, tokens per step
 * (provider-reported, with cache reads), the tools the model called, and the final answer.
 *
 *   node e2e/summarize.mjs <baseline.jsonl> <plugin.jsonl>
 */
import { readFileSync } from 'node:fs'

function summarize(file) {
  const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const steps = []
  const calls = []
  let answer = ''
  let error = ''
  for (const event of events) {
    if (event.type === 'status' && event.phase === 'step_end' && event.usage) steps.push(event.usage)
    if (event.type === 'tool_call') {
      const inner = event.tool === 'call_tool' ? `call_tool(${event.input?.name})` : event.tool
      calls.push(event.tool === 'tool_details' ? `tool_details(${(event.input?.names ?? []).join(', ')})` : inner)
    }
    if (event.type === 'final') answer = event.text ?? ''
    if (event.type === 'status' && event.reason?.kind === 'error') error = event.reason.error?.message ?? 'error'
    if (event.type === 'error') error = event.message
  }
  const sum = key => steps.reduce((total, usage) => total + (usage[key] ?? 0), 0)
  return {
    steps,
    calls,
    answer,
    error,
    input: sum('inputTokens'),
    cached: sum('cacheReadTokens'),
    output: sum('outputTokens'),
    total: sum('totalTokens'),
  }
}

const [baselineFile, pluginFile] = process.argv.slice(2)
const runs = { baseline: summarize(baselineFile), plugin: summarize(pluginFile) }

const row = (label, f) => console.log(`${label.padEnd(36)}${String(f(runs.baseline)).padStart(12)}${String(f(runs.plugin)).padStart(12)}`)
console.log(`${''.padEnd(36)}${'baseline'.padStart(12)}${'plugin'.padStart(12)}`)
row('model steps', r => r.steps.length)
row('first step: prompt tokens', r => (r.steps[0] ? r.steps[0].inputTokens + (r.steps[0].cacheReadTokens ?? 0) : 0))
row('all steps: uncached input tokens', r => r.input)
row('all steps: cached input tokens', r => r.cached)
row('all steps: output tokens', r => r.output)
row('all steps: total tokens', r => r.total)
row('tool calls', r => r.calls.length)

for (const [label, r] of Object.entries(runs)) {
  console.log(`\n== ${label}`)
  r.steps.forEach((u, i) => console.log(`step ${i + 1}: input ${u.inputTokens}, cached ${u.cacheReadTokens ?? 0}, output ${u.outputTokens}`))
  console.log(`calls: ${r.calls.join(' -> ') || '(none)'}`)
  if (r.error) console.log(`error: ${r.error}`)
  console.log(`answer: ${r.answer.trim().slice(0, 500) || '(none)'}`)
}
