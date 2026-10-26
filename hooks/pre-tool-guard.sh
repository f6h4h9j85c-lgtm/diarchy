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
# JSON object from the CLI is forwarded. `diarchy guard` always exits 0, so any
# other code means the CLI could not start (a Codex plugin copy has no
# node_modules and no `diarchy` is on PATH): its error goes to stderr and the
# script exits 1 with nothing on stdout, which Claude Code and Codex both report
# as a non-blocking hook error. Never exit 2: both read that as a deny.
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

# pipefail off inside: the status is node's, not a printf cut short by SIGPIPE.
out="$(set +o pipefail; printf '%s' "$input" | node "$bin" guard --agent "$agent")" || exit 1
case "$out" in
  '{'*) printf '%s\n' "$out" ;;
esac
exit 0
