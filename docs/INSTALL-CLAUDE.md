# Install diarchy into Claude Code

The plugin adds the `diarchy` MCP server (seven tools: `kickoff`, `post`, `read`,
`wait_for_reply`, `decide`, `assign`, `status`), the skills `diarchy-pm`,
`diarchy-kickoff`, and `diarchy-review`, five subagents (`planner`, `designer`,
`implementer`, `reviewer`, `security`), a SessionStart hook that prints your inbox
brief, a PreToolUse hook that denies a shell call to the human's `diarchy reply`
and `diarchy stop`, and a Stop hook that keeps the turn open while you owe the
other PM a reply.

Requirements: Node 20.3 or later on `PATH`, Claude Code 2.1.275 or later (2.1.292 or
later for the one-line shell install in Path B), Linux or macOS.
Native Windows is untested and `diarchy start --driver real` refuses to run there; use WSL.

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

This needs Claude Code 2.1.292 or later. It adds the marketplace if it is not
configured yet, then installs at user scope. Add `--scope project` to record the
install in the project's `.claude/settings.json` so teammates get it too.

On 2.1.275 to 2.1.291, `--marketplace` is an unknown option; add the
marketplace first, then install by plugin id:

```
claude plugin marketplace add f6h4h9j85c-lgtm/diarchy
claude plugin install diarchy@diarchy
```

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
5. From a shell in the project, run `diarchy doctor` (or
   `node <plugin root>/bin/diarchy.js doctor` without a global install). Its
   `claude` checks confirm the version, every launch flag in
   `agents.claude.args`, the login, that `diarchy@diarchy` is enabled, that
   `claude mcp list` shows `plugin:diarchy:diarchy` connected, that the
   plugin's server answers `read` for a throwaway goal, that its guard hook
   denies `diarchy reply`, and that `disableAllHooks` is off, with no model
   call; each problem gets a `fix:` line. `diarchy doctor --live` adds one real
   `claude -p` turn that only calls `read`, capped with `--max-budget-usd 0.25`
   when the installed `claude` lists that flag. With Codex set up too,
   `diarchy smoke` then runs both PMs on a small goal in a throwaway
   repository and writes a diagnostics bundle (CONTRIBUTING.md, Live smoke
   test).

One session per agent: while a goal is active, only one session acts as
`claude`. The first session whose diarchy tools touch the goal holds it until
it exits; a second one gets `AGENT_BUSY` from the diarchy tools (PROTOCOL.md
section 10), and its Stop hook lets it end its turn. Where the hook cannot
tell the two sessions apart (a CLI running as pid 1 in a container, or sessions
in different pid namespaces), it keeps the turn open as usual. Next to
`diarchy start`, an interactive session that comes second is refused. One that
came first holds the goal instead: `diarchy start` logs
`claude waiting: another session (pid <pid>) acts as claude on this goal`,
spawns no `claude` PM and uses up no restart meanwhile, and starts the PM once
that session exits. Close the other session, or let it be the PM.

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
