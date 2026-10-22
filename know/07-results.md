# 7. Results

From `e2e/run.sh`, 22 Oct 2026, DSH 0.2.1-rc.2. One task: compute 17 + 25 with the `add` tool, write it to
`notes/today.md` in the filesystem server's directory, list the directory. Provider-reported usage, summed over every
step of the task; 3 runs per cell; every column run with the same harness (dsh started inside the sandbox).

- **25 tools**: filesystem + everything servers.
- **75 tools**: + memory, Playwright, Chrome DevTools.

## Tokens per task

| Model | No plugin | Plugin (`signature`, prefetch off) | Plugin + prefetch 5 |
|---|---|---|---|
| DeepSeek deepseek-flash, 25 tools | 80,777 | **58,864 (-27%)** | 67,299 (-17%) |
| DeepSeek deepseek-flash, 75 tools | 183,274 | **79,838 (-56%)** | 80,924 (-56%) |
| Claude claude-haiku-5-5, 25 tools | 110,598 | **94,422 (-15%)** | 94,303 (-15%) |
| OpenAI gpt-5.4-mini, 25 tools | 50,846 | **23,398 (-54%)** | 50,355 (-1%) |

36/36 runs finished the task. Gemini was not measured (free-tier key: 5 requests a minute).

## Per request

Going from 25 to 75 tools added 13,579 tokens to the first request without the plugin and 1,560 with it: the plugin
removes about **88%** of what MCP tools cost per request, the same figure Agno's provider-native tool search reports
(agno PR #11219). The rest of a request (DSH's system prompt, its ~15 built-in tools, the conversation) is the same with
or without the plugin, which is why per-task percentages are smaller than 88%.

## What changed along the way

| Version | What we saw |
|---|---|
| Load a tool's definition on search | Every load changed the tool list and invalidated the provider cache for the whole conversation. Replaced. |
| Fixed list, `summary` index | Per request -29% to -62%, but per task -40% to +17%: models looked up most tools first (one extra step each). |
| `signature` index (now default) | Parameter names in the index; models call most tools directly. -15% to -56% per task. |
| Prefetch (now off) | Attaching matched tools' details to each message removed few lookups (there were few left) and cost ~3k tokens a message; OpenAI also moved to built-in tools. Kept as an option. |

## What the runs show

1. **The model uses the index correctly.** Real names every time; a wrong name (`add`) recovered through the
   closest-names reply.
2. **The prompt cache holds.** Cache reads grow step by step, as without the plugin.
3. **Extra steps were the cost, not the index.** Each step resends the whole prompt; the index is a few hundred tokens.
   Giving the model parameter names removed most lookups.
4. **Models may route around indexed tools** to built-ins (`bash`, `write`) when those can do the job. Keep MCP tools
   that must be the path visible (`exclude` / `alwaysLoad`).

## Caveats

- One small task. Long multi-turn conversations with few tool uses should favour the plugin more.
- Three runs per cell; ranges in `e2e/out/` overlap in places (Claude: 71k-113k with the plugin).
- Cheap models only.
