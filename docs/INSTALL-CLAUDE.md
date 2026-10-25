# Install diarchy into Claude Code

The plugin adds the `diarchy` MCP server (seven tools: `kickoff`, `post`, `read`,
`wait_for_reply`, `decide`, `assign`, `status`), the skills `diarchy-pm`,
`diarchy-kickoff`, and `diarchy-review`, five subagents (`planner`, `designer`,
`implementer`, `reviewer`, `security`), a SessionStart hook that prints your inbox
brief, and a Stop hook that keeps the turn open while you owe the other PM a reply.

Requirements: Node 20 or later on `PATH`, Claude Code 2.1.275 or later.

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

loads the plugin for one session without installing. Run `npm ci && npm run build`
in the checkout first: `bin/diarchy.js` imports `dist/`, and the hooks print
nothing until it exists.

## Confirm it is connected

1. Start Claude Code in the project and run `/mcp`. `diarchy` must be listed as
   connected with seven tools. If it shows as failed, run
   `node <plugin root>/bin/diarchy.js mcp --agent claude` by hand and read the
   error; a missing `dist/` or a Node older than 20 are the usual causes.
2. Run `/plugin` and check `diarchy@diarchy` is enabled.
3. On the next session start, with a goal active, the first lines of context are
   the inbox brief from `diarchy inbox-skim`. With no goal active nothing is
   printed; that is expected.

## Project configuration

`diarchy.config.json` at the project root names the vault and both agents (see
PROTOCOL.md section 8). `.diarchy/` holds the worktrees and is gitignored.

## Uninstall

```
claude plugin uninstall diarchy@diarchy
claude plugin marketplace remove diarchy
```
