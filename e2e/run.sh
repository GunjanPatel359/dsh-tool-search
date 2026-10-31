#!/usr/bin/env bash
# End-to-end check: the same task with and without dsh-tool-index, on a real model and real MCP
# servers, repeated RUNS times. Writes every run's events to e2e/out/<provider>-<servers>/ and
# prints the comparison (means, with min-max).
#
# Keys: put them in ~/.dsh-e2e.env (or point DSH_E2E_ENV at another file), one per line:
#   export DEEPSEEK_API_KEY=...
#   export ANTHROPIC_API_KEY=...
#   export OPENAI_API_KEY=...
#   export GEMINI_API_KEY=...
#
# Settings (environment variables):
#   PROVIDER   deepseek (default) | anthropic | openai | google
#   MODEL      the model id; defaults per provider below
#   SERVERS    small (default: filesystem + everything) | large (adds memory, Playwright, Chrome DevTools)
#   RUNS       how many times to run each side (default 1)
#   MIN_TOOLS  the plugin's minTools (default 10)
#   INDEX_STYLE   the plugin's indexStyle: names | summary | signature (default)
#   MODE       single (default: one task) | multi (a 5-message conversation in one session,
#              each message resuming it with --session-id; only some messages need tools)
#   SKIP_BASELINE set to run only the plugin side
#   SKIP_PLUGIN   set to run only the baseline side
#   TAG           a suffix for the output folder
#
#   ./e2e/run.sh                                  # one run, DeepSeek, small
#   RUNS=3 SERVERS=large ./e2e/run.sh
#   PROVIDER=anthropic RUNS=3 ./e2e/run.sh "your own task"
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ENV_FILE="${DSH_E2E_ENV:-$HOME/.dsh-e2e.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
PROVIDER="${PROVIDER:-deepseek}"
SERVERS="${SERVERS:-small}"
RUNS="${RUNS:-1}"
TASK="${*:-Create a file notes/today.md in the allowed directory containing the sum of 17 and 25 (use the add tool), then list the directory and tell me what is in it.}"

case "$PROVIDER" in
  deepseek)  MODEL="${MODEL:-deepseek-flash}";   KEY=DEEPSEEK_API_KEY ;;
  anthropic) MODEL="${MODEL:-claude-haiku-5-5}"; KEY=ANTHROPIC_API_KEY ;;
  openai)    MODEL="${MODEL:-gpt-5.4-mini}";     KEY=OPENAI_API_KEY ;;
  google)    MODEL="${MODEL:-gemini-3.5-flash}"; KEY=GEMINI_API_KEY ;;
  *) echo "PROVIDER must be deepseek, anthropic, openai or google" >&2; exit 2 ;;
esac
if [ -z "$(printenv "$KEY" || true)" ]; then
  echo "$KEY is not set: add 'export $KEY=...' to $ENV_FILE" >&2
  exit 2
fi

OUT="$HERE/out/$PROVIDER-$SERVERS${INDEX_STYLE:+-$INDEX_STYLE}${MODE:+-$MODE}${TAG:+-$TAG}"
SANDBOX="$OUT/sandbox"
rm -rf "$OUT" && mkdir -p "$SANDBOX"

# The MCP servers, written with the sandbox's absolute path.
{
  cat <<YAML
- insert:
    - id: mcp-filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fs
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem@2.0.0', '$SANDBOX']
    - id: mcp-everything
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: everything
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-everything@2.0.0']
YAML
  if [ "$SERVERS" = large ]; then
    cat <<YAML
    - id: mcp-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-memory@2.0.0']
        env: { MEMORY_FILE_PATH: '$OUT/memory.jsonl' }
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: playwright
        transport: stdio
        command: npx
        args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--isolated']
    - id: mcp-devtools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: devtools
        transport: stdio
        command: npx
        args: ['-y', 'chrome-devtools-mcp@1.11.0', '--headless', '--isolated']
YAML
  fi
} > "$OUT/mcp.patch.yml"

# The model route. DeepSeek is the profile's default; the others go through the pi-ai adapter.
if [ "$PROVIDER" = deepseek ]; then
  cat > "$OUT/model.patch.yml" <<YAML
- id: agent-default-model
  config:
    provider: deepseek-official
    model: $MODEL
YAML
else
  cat > "$OUT/model.patch.yml" <<YAML
- id: llm-pi-ai
  config:
    providers:
      $PROVIDER:
        apiKeyEnv: $KEY
- id: agent-default-model
  config:
    provider: $PROVIDER
    model: $MODEL
YAML
fi

cat > "$OUT/plugin.patch.yml" <<YAML
- insert:
    - id: dsh-tool-index
      name: '$ROOT/src/index.mjs'
      config:
        minTools: ${MIN_TOOLS:-10}
        indexStyle: ${INDEX_STYLE:-signature}
YAML

# The conversation MODE=multi plays: small talk between tool work, as a chat goes.
TURNS=(
  "Hi! In two sentences, what kinds of things can you help me with here?"
  "Use the add tool to compute 17 + 25."
  "Save that result to notes/today.md in the allowed directory."
  "Thanks. In one sentence: why is 42 a famous number?"
  "Now list the allowed directory and tell me what is in it."
)

run() {
  local label="$1"; shift
  local home="$OUT/home-$label"
  mkdir -p "$home"
  rm -rf "$SANDBOX" && mkdir -p "$SANDBOX"
  echo "== $label ($PROVIDER $MODEL, $SERVERS, ${MODE:-single})" >&2
  : > "$OUT/$label.jsonl"
  local session=""
  local prompts=("$TASK")
  [ "${MODE:-single}" = multi ] && prompts=("${TURNS[@]}")
  for prompt in "${prompts[@]}"; do
    # Run inside the sandbox, so the model's built-in file tools write there and not into the repo.
    (cd "$SANDBOX" && DSH_HOME="$home" npx --yes "@deepseek-ai/dsh@$DSH_VERSION" --profile headless \
      --patch "$OUT/model.patch.yml" "$@" --json ${session:+--session-id "$session"} "$prompt" \
      >> "$OUT/$label.jsonl" 2>> "$OUT/$label.stderr") || echo "   (exit $?; see $OUT/$label.stderr)" >&2
    # Later messages resume the session the first one created.
    [ -n "$session" ] || session="$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").find(x=>x.includes("\"type\":\"session\""));if(l)process.stdout.write(JSON.parse(l).sessionId)' "$OUT/$label.jsonl")"
  done
}

for i in $(seq 1 "$RUNS"); do
  [ -n "${SKIP_BASELINE:-}" ] || run "baseline-$i" --patch "$OUT/mcp.patch.yml"
  [ -n "${SKIP_PLUGIN:-}" ] || run "plugin-$i" --patch "$OUT/mcp.patch.yml" --patch "$OUT/plugin.patch.yml"
done

node "$HERE/summarize.mjs" "$OUT"
