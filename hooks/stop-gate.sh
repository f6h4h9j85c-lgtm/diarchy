#!/usr/bin/env bash
# diarchy Stop hook: keep the turn open while this agent owes the other PM a
# reply or has an unfinished assignment on an active goal.
#
# Usage: stop-gate.sh <agent-id>            (claude | codex; default claude)
# Stdin: the hook event JSON, passed through to `diarchy gate`.
# Stdout: {"decision":"block","reason":"..."} when the goal needs this agent;
#         nothing otherwise, which lets the turn end.
#
# Resolves bin/diarchy.js relative to this file, or uses $DIARCHY_BIN when set.
# Never breaks a session: exits 0 and prints nothing when node, the binary, or
# an active goal is missing. Only a JSON object from the CLI is forwarded.
set -euo pipefail

agent="${1:-claude}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="${DIARCHY_BIN:-$here/../bin/diarchy.js}"

[ -f "$bin" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

out="$(node "$bin" gate --agent "$agent" 2>/dev/null || true)"
case "$out" in
  '{'*) printf '%s\n' "$out" ;;
esac
exit 0
