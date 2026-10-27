# diarchy (hub)

Multiplayer AI for coding: Claude Code and Codex CLI run as peer product managers on one goal, coordinate through an Obsidian vault chat enforced by an MCP server, and delegate to their own subagents. Human out of the loop except for deadlock, external blocker, or spent budget.

## Standing decisions
- 2026-10-27 v0.3.0 after the open-item round and two audit passes, post-fix and confirmation, with no high or medium survivor (docs/audit/2026-10-27-v0.3.0-addendum.md).
- 2026-10-27 F033: only a STATUS carrying new work evidence resets the talk counter; seen evidence comes from the committed chat files, so budget.json is unchanged.
- 2026-10-27 Supervisor parking: never park a lead with a timed duty or a due DONE; a parked PM gets one uncounted relaunch at the park deadline.
- 2026-10-27 `diarchy start` and `kickoff` require `diarchy init` (they refuse without diarchy.config.json).
- 2026-10-27 `diarchy doctor` checks the setup and `diarchy smoke` runs the live test; tests never start a real model run.
- 2026-10-26 v0.2.0 after a two-round audit (115 confirmed findings fixed or deferred with a reason; docs/audit/2026-10-25-audit.md).
- 2026-10-26 Guard: the original split verdict is the floor; only inert quoted text given to data-only programs is exempt.
- 2026-10-26 Stored 0.1.0 chat files keep 0.1.0 field rules; new posts get the tightened rules; no protocol_version bump.
- 2026-10-25 Codex sandbox on by default; `diarchy init --codex-full-access` opts out. The implementer always posts its own `pr` evidence; a PM committing for a sandboxed PM cites only `commit`.
- 2026-10-25 Agent text renders as plain text in chat.md, goal.md, decisions.md.
- 2026-10-25 dist/ is committed (plugin installs run no build); CI rebuilds and diffs it. Node >= 20.3.
- 2026-10-25 Protocol is normative: docs/PROTOCOL.md, docs/ANTI-SLOP.md. Tests parse the rule table.
- 2026-10-25 Enforcement in code (MCP server + store), never prompts alone.
- 2026-10-25 Lead = kickoff receiver, challenger = other, swap per goal, no domain routing, evidence-based tiebreak.
- 2026-10-25 One file per message, store-rendered views; worktree per PM; cross-model PR review required.

## Active threads
- Push the v0.3.0 tag on 3229d6b (the build session could not push tags; steps in `Projects/diarchy handoff.md`).
- First live two-model run, now via `diarchy smoke` on a machine with both CLIs.
- Node >= 22.12 upgrade.
- Third agent adapter.

## Key notes
- START HERE: Projects/diarchy handoff.md (what the app is, how to run it, current state, next steps, code map, repo rules)
- Sessions/2026-10-27 diarchy.md (v0.3.0 round), Sessions/2026-10-26 diarchy.md (audit and fix), Sessions/2026-10-25 diarchy.md (v0.1.0 build)
- docs/audit/2026-10-27-v0.3.0-addendum.md, docs/audit/2026-10-25-audit.md
- docs/PROTOCOL.md, docs/ANTI-SLOP.md, docs/RENDERING.md, docs/ARCHITECTURE.md

## Layout
src/protocol (engine) · src/vault (store, locks, lease, renderers) · src/mcp (server) · src/cli (launcher, run record, preflight, fake PM, hooks, guard) · skills/ agents/ hooks/ .claude-plugin/ .mcp.json (Claude plugin) · .codex-plugin/ .agents/ .codex/agents/ mcp.json hooks/codex-hooks.json (Codex plugin) · dist/ (committed build) · test/ (539 tests, fixtures)
