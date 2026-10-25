#!/usr/bin/env bash
# diarchy PreToolUse hook: deny a shell command that would post as the human
# (`diarchy reply`, `diarchy stop`). The human is an identity the CLI assumes,
# not a credential (ANTI-SLOP.md, What this does NOT prevent); this hook keeps
# the PM's own shell from assuming it.
#
# Usage: pre-tool-guard.sh <agent-id>       (claude | codex; default claude)
# Stdin: the hook event JSON, passed through to `diarchy guard`.
# Stdout: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}
#         when tool_input.command runs one of the human's commands; nothing otherwise.
#
# Resolves bin/diarchy.js relative to this file, or uses $DIARCHY_BIN when set.
# Never breaks a session: exits 0 and prints nothing when node or the binary is
# missing. Commands that do not mention diarchy skip the node start-up. Only a
# JSON object from the CLI is forwarded.
set -euo pipefail

agent="${1:-claude}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="${DIARCHY_BIN:-$here/../bin/diarchy.js}"

input="$(cat 2>/dev/null || true)"
case "$input" in
  *diarchy*) ;;
  *) exit 0 ;;
esac

[ -f "$bin" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

out="$(printf '%s' "$input" | node "$bin" guard --agent "$agent" 2>/dev/null || true)"
case "$out" in
  '{'*) printf '%s\n' "$out" ;;
esac
exit 0
