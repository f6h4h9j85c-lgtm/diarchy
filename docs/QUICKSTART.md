# Quickstart: a first diarchy run in ten minutes

You need Claude Code and Codex CLI installed and signed in, Node 20.3 or later on Linux or macOS (native Windows is untested and `diarchy start --driver real` refuses to run there; use WSL), and a git repository with at least one commit.

## 1. Install the plugin in both CLIs

Install the diarchy CLI first. Codex installs a plugin without its dependencies, so the Codex plugin's MCP server and hooks run the `diarchy` on `PATH`:

```
npm install -g github:f6h4h9j85c-lgtm/diarchy
```

Claude Code 2.1.292 or later, from a shell:

```
claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy
```

On Claude Code 2.1.275 to 2.1.291, `--marketplace` is an unknown option; add the marketplace first, then install by plugin id:

```
claude plugin marketplace add f6h4h9j85c-lgtm/diarchy
claude plugin install diarchy@diarchy
```

Codex CLI: `codex plugin marketplace add f6h4h9j85c-lgtm/diarchy`, then `codex plugin add diarchy@diarchy`, and register the `diarchy` MCP server in `~/.codex/config.toml` with `command = "diarchy"` and `args = ["mcp", "--agent", "codex"]` as shown in [INSTALL-CODEX.md](INSTALL-CODEX.md); then approve the plugin's three diarchy hooks in `/hooks`, or they are skipped silently. In each CLI, `/mcp` must list `diarchy`, and asking for the diarchy `read` tool must answer `NO_GOAL`: nothing is kicked off yet.

Then check the wiring from a shell in the project, without a model call:

```
diarchy doctor
```

It checks Node, git, the global `diarchy`, each CLI's version and launch flags, that both plugins are enabled, the `[mcp_servers.diarchy]` entry Codex reports, and the hook and project trust in `~/.codex/config.toml`, then starts each CLI's diarchy MCP server and runs its guard hook against a throwaway project. Each `warn` or `fail` line has a `fix:` line under it, and any `fail` exits 1. Before step 2 it warns that `diarchy.config.json` is missing; run it again after step 2 for the project checks. `diarchy doctor --live` then runs one short real turn per CLI against a throwaway project, a prompt that only calls `read`, which proves the login, the headless launch flags, `env_vars`, and the hooks. It spends a little quota: Claude's turn is capped with `--max-budget-usd 0.25` when the installed `claude` lists that flag, and Codex's comes out of your plan. To see the whole loop work before your own goal, `diarchy smoke` runs both PMs on a small goal in a throwaway repository in 15 to 25 minutes and writes a diagnostics bundle to send back ([CONTRIBUTING.md](../CONTRIBUTING.md), Live smoke test).

## 2. Initialise the project

```
cd /path/to/api
diarchy init
git add AGENTS.md .codex && git commit -m "Add the diarchy Codex files"
```

`init` writes `diarchy.config.json` (vault path, both agents' launch commands, default budgets; `diarchy start` and `diarchy kickoff` refuse to run without it), creates `api brain/diarchy/`, adds `.diarchy/` to `.gitignore`, and copies Codex's project files: `AGENTS.md`, which tells the Codex PM to call `read` and load `diarchy-pm` at session start, and the five subagents in `.codex/agents/`. An existing `AGENTS.md` is kept; append `templates/AGENTS.md` to it. Commit both: each PM works in a git worktree cut from HEAD, and Codex reads them only from its own worktree. Open `api brain` as a vault in Obsidian. The Codex PM runs sandboxed and cannot commit, push, or open a PR, so the Claude PM commits its work and opens its PR, citing only the commit and passing the url in its STATUS body. The Codex PM then posts the `pr` evidence itself, because the first agent to cite a PR is its author and the other agent reviews it. `diarchy init --codex-full-access` lifts the sandbox and gives it your full OS permissions ([INSTALL-CODEX.md](INSTALL-CODEX.md) section 5).

## 3. Kick off

```
diarchy start "Add per-API-key rate limiting to the public API." \
  --slug rate-limit \
  --ac "Requests over the per-key limit get HTTP 429 with a Retry-After header, and the count is shared across all API replicas." \
  --ac "The limit is configurable through RATE_LIMIT_PER_MIN with a documented default." \
  --ac "Tests cover the 429 path and the config override, and the full suite is green on main."
```

Each criterion is one checkable statement of at most 40 words; they become AC1, AC2, AC3 and are never reworded. The launcher prints the goal id (`20261025-rate-limit` for this goal on that date; without `--slug` the slug is derived from the goal text), the lead and the challenger, creates `.diarchy/worktrees/claude` and `.diarchy/worktrees/codex` on branches `diarchy/<goal-id>/<agent>`, and spawns `claude -p` and `codex exec` with a one-line prompt each. The lead alternates from the previous goal; `--lead claude` forces it.

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

For a deadlock: `diarchy reply "<ruling>" --decision plan` (or `D<n>`), unless another thread is still open: then `--decision plan` is refused (PHASE_GATE decides plan last), so answer with the plain `diarchy reply "<ruling>"` that goal.md shows, and the lead DECIDEs that thread, then plan. For a spent budget: `diarchy reply "continue" --budget messages_total=160`. The reply is posted as a DECIDE with `basis: human`, recorded in `decisions.md`, and the phase returns to where it was. A ruling on an open `plan` (the run blocked from PLAN) is the exception: it closes PLAN, so EXECUTE begins with the tasks you name, one `--task "<task>"` each (`diarchy reply "<ruling>" --decision plan --task "<task>" --task "<task>"`), as todo for the lead to ASSIGN; without `--task` it begins with none and the lead ASSIGNs each one with `new_task`. A reopened `plan` is already decided, so a ruling on it supersedes it and EXECUTE resumes with the tasks already set. Then run `diarchy start` with no goal text: it attaches to the active goal and respawns both PMs.

## 7. Stop

```
diarchy stop --reason "Out of time today."
```

This posts a human BLOCKED message, leaves the goal BLOCKED, and signals the running `diarchy start`. A goal ends on its own when the lead posts DONE, which the store accepts only when every task is done, every AC has a passing test from a STATUS, each implementer has introduced a PR with its own `pr` evidence and every PR has the other agent's approve (unless `review.required` is false), no thread is open, no CHALLENGE is unanswered, and no deadlock watch is active (PROTOCOL.md 9.2). `chat.md` then ends with `## → DONE`.
