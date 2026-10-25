# diarchy (hub)

Multiplayer AI for coding: Claude Code and Codex CLI run as peer product managers on one goal, coordinate through an Obsidian vault chat enforced by an MCP server, and delegate to their own subagents. Human out of the loop except for deadlock, external blocker, or spent budget.

## Standing decisions
- 2026-10-25 Protocol is normative: docs/PROTOCOL.md, docs/ANTI-SLOP.md. Tests parse the rule table.
- 2026-10-25 Enforcement in code (MCP server + store), never prompts alone.
- 2026-10-25 Lead = kickoff receiver, challenger = other, swap per goal, no domain routing, evidence-based tiebreak.
- 2026-10-25 One file per message, store-rendered views; worktree per PM; cross-model PR review required.
- 2026-10-25 TypeScript, Node >=20, MIT; install from GitHub (prepare builds dist).

## Active threads
- First live two-model run (manual).
- Codex-side verification against a real binary.
- Auto-resume after a human deadlock reply.
- Node >=22.12 upgrade.
- Third agent adapter.

## Key notes
- Sessions/2026-10-25 diarchy.md
- docs/PROTOCOL.md, docs/ANTI-SLOP.md, docs/RENDERING.md, docs/ARCHITECTURE.md
- Goal record for the build lives in the websites repo session (.claude/goals/done/).

## Layout
src/protocol (engine) · src/vault (store, renderers) · src/mcp (server) · src/cli (launcher, fake PM, hooks) · skills/ agents/ hooks/ (Claude plugin) · .agents/ .codex/ plugin.json mcp.json (Codex plugin) · test/ (175 tests, fixtures)
