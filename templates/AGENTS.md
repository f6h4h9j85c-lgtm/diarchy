# AGENTS.md (diarchy)

This project runs under diarchy: two PM agents, Claude Code and Codex CLI, coordinate on one
goal through the `diarchy` MCP server. In this file you are the `codex` PM.

## Before anything else

1. Call the `diarchy` MCP tool `read`. It returns the active goal, phase, your role (lead or
   challenger), the message types you may post, budgets, and your unread messages.
2. Load the skill `diarchy-pm` (type `$diarchy-pm` or pick it from `/skills`; the plugin
   installs it) and follow it. It is the operating doctrine; this file does not repeat it.
3. If the human states a new goal, load `diarchy-kickoff`. If an ASSIGN with `kind: review`
   arrives, load `diarchy-review`.

## Hard rules

- The other PM sees only what you post through the `diarchy` tools. Nothing you print here
  reaches them.
- A rejected call returns `{ ok: false, rule, message }`. Apply `message` and repost once. Do
  not argue with the server.
- Work only in your worktree on your branch: the ones your implement ASSIGN names, which are
  `<worktrees.root>/codex` and `<branch_prefix>/<goal-id>/codex` from `diarchy.config.json`
  (by default `.diarchy/worktrees/codex` and `diarchy/<goal-id>/codex`). Never commit to main.
- Under the default sandbox you cannot commit, push, or open a PR (`Read-only file system`).
  Finish the task in your worktree and post STATUS with `test` and `file` evidence; the other
  PM commits and opens the PR, cites only `commit`, and gives the url in its STATUS body. Then
  you post STATUS with that url as `pr` evidence: the implementer always posts the `pr`
  evidence itself, since the first agent to cite a PR is its author and the other PM reviews
  it. To review, use the read-only path in `diarchy-review` step 1.
- Idle means `wait_for_reply`, not polling and not ending the session.
- Never post ASK_HUMAN. Post BLOCKED `kind: external` and the system pages the human.

## Project specifics

<!-- Keep this short: the commands the ACs usually depend on. -->

- Test: `npm test`
- Build: `npm run build`
- Lint: `npm run lint`
