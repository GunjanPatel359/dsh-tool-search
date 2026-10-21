# 7. Results

From `e2e/run.sh`, 21 Oct 2026, DSH 0.2.1-rc.2. One task: compute 17 + 25 with the `add` tool, write it to
`notes/today.md` in the filesystem server's directory, list the directory. Provider-reported usage, summed over
every step; means of 3 runs per side (min-max in `e2e/out/*` when you rerun).

- **small**: filesystem + everything servers, about 25 MCP tools.
- **large**: + memory, Playwright, Chrome DevTools, about 75 MCP tools.

## Totals (plugin with the `summary` index, before `signature` became the default)

| Model, servers | Tokens without | Tokens with | Change | Steps without -> with | Finished |
|---|---|---|---|---|---|
| OpenAI gpt-5.4-mini, small | 48,987 | 29,594 | **-40%** | 5 -> 4 | 3/3, 3/3 |
| DeepSeek deepseek-flash, small | 101,423 | 81,174 | **-20%** | 7 -> 8 | 3/3, 3/3 |
| DeepSeek deepseek-flash, large | 180,478 | 162,159 | **-10%** | 7 -> 11 | 3/3, 3/3 |
| Claude claude-haiku-5-5, small | 79,343 | 93,112 | **+17%** | 4 -> 6 | 3/3, 3/3 |
| Gemini gemini-3.5-flash, small | not measured | | | | free-tier key: 5 requests/min |

## Per-step prompt (first step)

| Setup | Without | With | Change |
|---|---|---|---|
| DeepSeek, small | 12,772 | 8,556 | -33% |
| DeepSeek, large | 26,351 | 10,116 | **-62%** |
| Claude, small | 17,675 | 12,565 | -29% |
| OpenAI, small | 8,870 | 6,562 | -26% |

The saving per step grows with the catalogue. The net saving does not grow with it, because steps go up.

## Index style A/B (Claude, small, 3 runs each)

| `indexStyle` | Tokens | Lookups per run | Detours into built-ins |
|---|---|---|---|
| none (no plugin) | 79,343 | | |
| `names` | 79,840 | 1-2 | 1 of 3 runs |
| `summary` | ~100,000 (6 runs) | 1-2 | 2 of 6 runs |
| `signature` | 80,542 | always 1 | none |

`signature` is now the default: the steadiest, and back to the no-plugin cost on the model that did worst.
`names` and `signature` are within noise of each other at 3 runs.

## What the runs show

1. **The model uses the index correctly.** Every run on every model picked real tool names, mostly in one
   `tool_details` call covering several tools, then ran them with `call_tool`. 21/21 plugin runs finished.
2. **The prompt cache holds.** Cache reads grow step by step with the plugin, as without it.
3. **The cost is extra steps, not the index.** One step resends the whole prompt (10-25k tokens); the index is
   a few hundred. Steps come from: the lookup itself, models calling fewer tools per step, and detours.
4. **Models detour into built-in tools.** With the plugin, DeepSeek on the large setup used `bash` / `read` to
   explore instead of the (indexed) filesystem tools: 7 -> 11 steps, which ate most of a 62% per-step saving.
   Tools that overlap built-ins should be kept visible (`exclude` / `alwaysLoad`).
5. **Wrong names recover.** Models twice asked for `add` (the task's wording); the closest-names reply led to
   `get-sum` without a failed call.
6. **Model differences are large.** OpenAI got cheaper and faster; Claude batches calls without the plugin and
   loses that with it.

## Caveats

- One small task. Real conversations with many turns and few tool uses should favour the plugin more (each turn
  resends the definitions; lookups stay in history).
- Three runs per cell; ranges overlap in several rows.
- Cheap models only. Gemini not measured.
