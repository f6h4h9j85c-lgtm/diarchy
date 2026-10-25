# Install diarchy into Claude Code

The plugin adds the `diarchy` MCP server (seven tools: `kickoff`, `post`, `read`,
`wait_for_reply`, `decide`, `assign`, `status`), the skills `diarchy-pm`,
`diarchy-kickoff`, and `diarchy-review`, five subagents (`planner`, `designer`,
`implementer`, `reviewer`, `security`), a SessionStart hook that prints your inbox
brief, a PreToolUse hook that denies a shell call to the human's `diarchy reply`
and `diarchy stop`, and a Stop hook that keeps the turn open while you owe the
other PM a reply.

Requirements: Node 20.3 or later on `PATH`, Claude Code 2.1.275 or later.

## Path A: from inside Claude Code

```
/plugin marketplace add f6h4h9j85c-lgtm/diarchy
/plugin install diarchy@diarchy
```

The marketplace is named `diarchy` and contains one plugin, also named `diarchy`,
so the plugin id is `diarchy@diarchy`.

## Path B: from a shell

```
claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy
```

This adds the marketplace if it is not configured yet, then installs at user
scope. Add `--scope project` to record the install in the project's
`.claude/settings.json` so teammates get it too.

## Local checkout (development)

```
claude --plugin-dir /abs/path/to/diarchy
```

loads the plugin for one session without installing. Run `npm ci` in the checkout
first so `node_modules/` exists. `dist/` is committed, so there is no build step;
after editing `src/`, run `npm run build` (see CONTRIBUTING.md).

## Confirm it is connected

1. Start Claude Code in the project and run `/mcp`. `diarchy` must be listed as
   connected with seven tools. If it shows as failed, run
   `node <plugin root>/bin/diarchy.js mcp --agent claude` by hand and read the
   error; a Node older than 20.3 is the usual cause. `dist/` is committed, so a
   marketplace install always has it; if the error names `dist/` anyway, the
   copy was modified (`git checkout -- dist` or `npm run build` restores it),
   and `bin/diarchy.js` runs a `diarchy` from `PATH` instead when one is
   installed.
2. Run `/plugin` and check `diarchy@diarchy` is enabled.
3. Ask Claude to call the diarchy `read` tool. With no goal in the vault it
   answers `{ ok: false, rule: "NO_GOAL", ... }`; that is the server working.
   Once a goal exists it returns the goal text (`goal_text`), every acceptance
   criterion with its status (`acs`), the phase, your role, and unread messages.
4. On the next session start, with a goal active, the first lines of context are
   the inbox brief from `diarchy inbox-skim`. With no goal active nothing is
   printed; that is expected.

One session per agent: while a goal is active, only one session acts as
`claude`. The first session whose diarchy tools touch the goal holds it until
it exits; a second one, such as an interactive session next to the headless PM
that `diarchy start` runs, gets `AGENT_BUSY` from the diarchy tools (PROTOCOL.md
section 10). Close the other session, or let it be the PM.

## Project configuration

`diarchy init` in the project root writes `diarchy.config.json`, which names
the vault (default `<project> brain/diarchy`) and both agents (see PROTOCOL.md
section 8), creates the vault directory, and adds `.diarchy/` to `.gitignore`.
`.diarchy/` holds the per-agent worktrees and launcher state. The Claude PM's
launch flags (`agents.claude.args`) carry an `--allowedTools` list naming the
plugin-scoped server `mcp__plugin_diarchy_diarchy__*` and the `git`, `npm`,
`node`, and `gh` commands, because a headless `claude -p` denies every tool
nobody approved. If you registered the server with `claude mcp add diarchy`
instead of installing the plugin, change that rule to `mcp__diarchy__*`. A run
starts with `diarchy start "<goal>" --ac "<criterion>"`; see QUICKSTART.md.

## Uninstall

```
claude plugin uninstall diarchy@diarchy
claude plugin marketplace remove diarchy
```
