#!/usr/bin/env bash
# End-to-end check: the same task, with and without dsh-tool-search, against a real model and two
# real MCP servers (filesystem + everything). Writes each run's events to e2e/out/ and prints a
# comparison.
#
#   export DEEPSEEK_API_KEY=...        # the default dsh model route
#   ./e2e/run.sh                       # default task
#   ./e2e/run.sh "your own task"
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${DSH_E2E_ENV:-$HOME/.dsh-e2e.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
ROOT="$(dirname "$HERE")"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
TASK="${*:-Create a file notes/today.md in the allowed directory containing the sum of 17 and 25 (use the add tool), then list the directory and tell me what is in it.}"

OUT="$HERE/out"
SANDBOX="$OUT/sandbox"
rm -rf "$OUT" && mkdir -p "$SANDBOX"

# The two MCP servers, written with the sandbox's absolute path.
cat > "$OUT/mcp.patch.yml" <<YAML
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

cat > "$OUT/plugin.patch.yml" <<YAML
- insert:
    - id: dsh-tool-search
      name: '$ROOT/src/index.mjs'
      config:
        minTools: ${MIN_TOOLS:-10}
YAML

run() {
  local label="$1"; shift
  local home="$OUT/home-$label"
  mkdir -p "$home"
  echo "== $label" >&2
  DSH_HOME="$home" npx --yes "@deepseek-ai/dsh@$DSH_VERSION" --profile headless "$@" --json "$TASK" \
    > "$OUT/$label.jsonl" 2> "$OUT/$label.stderr" || echo "   (exit $?; see out/$label.stderr)" >&2
}

run baseline --patch "$OUT/mcp.patch.yml"
rm -rf "$SANDBOX" && mkdir -p "$SANDBOX"
run plugin --patch "$OUT/mcp.patch.yml" --patch "$OUT/plugin.patch.yml"

node "$HERE/summarize.mjs" "$OUT/baseline.jsonl" "$OUT/plugin.jsonl"
