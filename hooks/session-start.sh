#!/usr/bin/env bash
# diarchy SessionStart hook: print a short inbox brief for this agent so the PM
# starts the session knowing the goal phase and what it owes the other PM.
#
# Usage: session-start.sh <agent-id>        (claude | codex; default claude)
#
# Resolves bin/diarchy.js relative to this file, or uses $DIARCHY_BIN when set.
# Never breaks a session: exits 0 and prints nothing when node, the binary, or
# an active goal is missing.
set -euo pipefail

agent="${1:-claude}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="${DIARCHY_BIN:-$here/../bin/diarchy.js}"

[ -f "$bin" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

node "$bin" inbox-skim --agent "$agent" 2>/dev/null || true
exit 0
