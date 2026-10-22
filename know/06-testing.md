# 6. Testing

## Unit and integration (no network, no keys)

```sh
npm install
npm test
```

`tests/plugin.spec.mjs` mounts the real DSH packages (`dsh-tools`, `dsh-system-prompt`, `dsh-scope`), registers MCP-shaped tools on agent scopes like an ACP session does, reads the assembly a model request would carry, and executes through the registry. It checks: the index, a byte-identical tool list across steps, details, suggestions, `call_tool` through the pipeline (a pre-execute deny reaches it), per-agent isolation, `minTools`, config options, global tools, index overflow.

## End to end (real model, real MCP servers)

1. Put keys in `~/.dsh-e2e.env` (outside the repo, `chmod 600`):

   ```sh
   export DEEPSEEK_API_KEY=...
   export ANTHROPIC_API_KEY=...
   export OPENAI_API_KEY=...
   export GEMINI_API_KEY=...
   ```

   Only the provider you run needs a key. Another file: `DSH_E2E_ENV=/path ./e2e/run.sh`.

2. Run:

   ```sh
   ./e2e/run.sh                                   # DeepSeek, small (filesystem + everything), once
   RUNS=3 ./e2e/run.sh                            # three runs per side
   SERVERS=large RUNS=3 ./e2e/run.sh              # + memory, Playwright, Chrome DevTools
   PROVIDER=anthropic ./e2e/run.sh                # anthropic | openai | google; MODEL=... to pick
   MODE=multi SERVERS=large RUNS=3 ./e2e/run.sh   # a 5-message conversation in one session
   ```

Each run boots `dsh --profile headless --json` twice per round, without and with the plugin, and `e2e/summarize.mjs` prints steps, tokens (uncached, cached, output), tool calls and whether the task finished. Raw events stay in `e2e/out/` (not committed).
