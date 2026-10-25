# Quickstart: a first diarchy run in ten minutes

You need Claude Code and Codex CLI installed and signed in, Node 20 or later, and a git repository with at least one commit.

## 1. Install the plugin in both CLIs

Claude Code, from a shell:

```
claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy
```

Codex CLI: `codex plugin marketplace add f6h4h9j85c-lgtm/diarchy`, then enable `diarchy@diarchy` and register the `diarchy` MCP server in `~/.codex/config.toml` as shown in [INSTALL-CODEX.md](INSTALL-CODEX.md). In each CLI, `/mcp` must list `diarchy`, and asking for the diarchy `read` tool must answer `NO_GOAL`: nothing is kicked off yet.

## 2. Initialise the project

```
cd /path/to/api
npm install -g github:f6h4h9j85c-lgtm/diarchy
diarchy init
cp /path/to/diarchy/templates/AGENTS.md AGENTS.md
```

`init` writes `diarchy.config.json` (vault path, both agents' launch commands, default budgets), creates `api brain/diarchy/`, and adds `.diarchy/` to `.gitignore`. Open `api brain` as a vault in Obsidian. `AGENTS.md` tells the Codex PM to call `read` and load `diarchy-pm` at session start.

## 3. Kick off

```
diarchy start "Add per-API-key rate limiting to the public API." \
  --ac "Requests over the per-key limit get HTTP 429 with a Retry-After header, and the count is shared across all API replicas." \
  --ac "The limit is configurable through RATE_LIMIT_PER_MIN with a documented default." \
  --ac "Tests cover the 429 path and the config override, and the full suite is green on main."
```

Each criterion is one checkable statement of at most 40 words; they become AC1, AC2, AC3 and are never reworded. The launcher prints the goal id (`20261025-rate-limit` for this goal on that date), the lead and the challenger, creates `.diarchy/worktrees/claude` and `.diarchy/worktrees/codex` on branches `diarchy/<goal-id>/<agent>`, and spawns `claude -p` and `codex exec` with a one-line prompt each. The lead alternates from the previous goal; `--lead claude` forces it.

Nobody is there to answer a permission prompt, so the Claude PM is launched with `--allowedTools` for the diarchy tools and for `git`, `npm`, `node`, and `gh`, and anything else is denied. If your checks run through another command, add `Bash(make *)` (or the like) to `agents.claude.args` in `diarchy.config.json` before this step.

## 4. The first three messages

Open `api brain/diarchy/goals/20261025-rate-limit/chat.md`. The callout at the top gives the phase (PLAN), who leads, and the budget used. Below it:

- `▸ human → all · KICKOFF`: your goal text.
- `○ claude → all · PROPOSE · plan`: one italic claim and a body listing 2 to 6 tasks mapped to ACs.
- `▲ codex → claude · CHALLENGE · plan`: one italic counter-claim and a `test:` bullet naming the check that settles it. If the challenger has no test to offer, this message does not appear.

Then `● DECIDE · plan` with its basis and a `Tasks:` list, and the heading `## → EXECUTE`. `diarchy watch` prints the same header lines in the terminal as they land.

## 5. When it blocks

`diarchy start` exits with code 2 and prints why. In Obsidian, `goal.md` now opens with a WARNING callout: who is blocked and their exact words, or the two positions of a deadlock, or which budget ran out, then the one command to run. `chat.md` shows the same under `## → BLOCKED`; `diarchy status` prints the command too.

## 6. Answer

```
diarchy reply "Read REDIS_URL from .env.staging; it is gitignored."
```

For a deadlock: `diarchy reply "<ruling>" --decision plan` (or `D<n>`). For a spent budget: `diarchy reply "continue" --budget messages_total=160`. The reply is posted as a DECIDE with `basis: human`, recorded in `decisions.md`, and the phase returns to where it was. Then run `diarchy start` with no goal text: it attaches to the active goal and respawns both PMs.

## 7. Stop

```
diarchy stop --reason "Out of time today."
```

This posts a human BLOCKED message, leaves the goal BLOCKED, and signals the running `diarchy start`. A goal ends on its own when the lead posts DONE: every AC has a passing test, every PR has the other agent's approve, and `chat.md` ends with `## → DONE`.
