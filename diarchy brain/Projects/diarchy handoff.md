# diarchy handoff: start here

Written 2026-10-27, at the v0.3.0 release, so a fresh chat can pick the project up cold. Read this note first, then the hub (`Projects/diarchy.md`) and the latest session note (`Sessions/2026-10-27 diarchy.md`). Paths below are relative to the repository root unless they say otherwise.

## 1. What diarchy is

diarchy is an open-source tool that installs into two AI coding CLIs, Claude Code and OpenAI Codex CLI, and runs each as a product-manager (PM) agent on one shared coding goal. The two PMs are peers from different vendors. One leads and the other challenges, and each delegates the actual coding to its own subagents (planner, implementer, reviewer, designer, security). The PMs never talk directly. They talk only through a chat stored as markdown files in an Obsidian vault, and every message goes through an MCP server that enforces a written protocol in code. Because the rules live in code and not in prompts, the exchange cannot drift into acknowledgements, repetition, or open-ended debate. Every PR one model writes is reviewed by the other model (by default). The human gives the goal and acceptance criteria, reads three rendered files (chat.md, goal.md, decisions.md), and is called in only for a true deadlock, a missing credential, or a spent budget.

- Repository: github.com/f6h4h9j85c-lgtm/diarchy (public, MIT). Default branch `main`. Owner GitHub login: f6h4h9j85c-lgtm.
- Language: TypeScript (ESM, strict), Node 20.3 or later (CI runs Node 20 and 22), vitest, zod 4, commander. Linux and macOS; native Windows is refused by the real driver (use WSL).
- Status: pre-alpha, v0.3.0. Everything is tested with a scripted fake PM and stub CLIs. A live run with both real CLIs and real models has NOT happened yet. That is the most important open item.

## 2. How a run works (one goal)

1. `diarchy init` in a project writes `diarchy.config.json`, creates the vault at `<project> brain/diarchy`, ignores `.diarchy/`, and copies `AGENTS.md` and `.codex/agents/` (commit those two).
2. `diarchy start "<goal>" --ac "<criterion>" --ac "..."` kicks the goal off as the human. It creates `goals/<YYYYMMDD>-<slug>/` in the vault, makes one git worktree per PM (`.diarchy/worktrees/claude`, `.diarchy/worktrees/codex`, branches `diarchy/<goal-id>/<agent>`), spawns `claude -p` and `codex exec` headless, and supervises them until DONE (exit 0) or BLOCKED (exit 2).
3. Phase PLAN: the lead posts PROPOSE plan (2 to 6 tasks mapped to the ACs); the challenger may CHALLENGE with a test that would settle it; the lead DECIDEs plan (by evidence or by lead authority after two silent waits).
4. Phase EXECUTE: the lead ASSIGNs tasks; each PM's subagents do the work; PMs post STATUS with work evidence (commit, pr, test result, review verdict, file). Each PR is assigned for review to the agent that did not write it.
5. DONE when every AC has a passing test, every task is done, and every PR has a non-author approve (unless `review.required` is off). BLOCKED for a deadlock, an external blocker, or a spent budget; then `diarchy reply` answers it.
6. The Codex PM runs sandboxed by default, so it cannot commit or push: the Claude PM commits its work and opens its PR citing only `commit`, and the Codex PM posts the `pr` evidence itself. `diarchy init --codex-full-access` lifts the sandbox.

Protocol vocabulary: message types KICKOFF, PROPOSE, CHALLENGE, DECIDE, ASSIGN, STATUS, ASK_HUMAN, BLOCKED, DONE. Phases PLAN, EXECUTE, DONE, BLOCKED. Seven MCP tools per agent: `read`, `kickoff`, `post`, `decide`, `assign`, `status`, `wait_for_reply`. Budgets (in budget.json): messages_total, plan_messages, talk_work_ratio (talk messages allowed between STATUS posts that carry NEW work evidence), wall_clock_minutes. Rejections have codes (NO_GOAL, SCHEMA, TALK_WORK_RATIO, BUSY_REVIEWING, DONE_PRECONDITION, AGENT_BUSY and more), all listed in docs/ANTI-SLOP.md.

## 3. Current state (2026-10-27)

- `main` on GitHub is at `3229d6b`, version 0.3.0 in package.json, package-lock.json, .claude-plugin/plugin.json and .codex-plugin/plugin.json. CI is green on Node 20 and 22. 539 tests pass. `claude plugin validate .` passes with no warnings.
- **The git tag `v0.3.0` is NOT on GitHub yet.** The build session could push branches but its connection refused tag pushes. Samuel said he would push it himself. To do it (any machine with push access):

```
git clone https://github.com/f6h4h9j85c-lgtm/diarchy && cd diarchy   # or git fetch origin in an existing clone
git tag -a v0.3.0 3229d6b -m "diarchy 0.3.0"
git push origin v0.3.0
git ls-remote origin refs/tags/v0.3.0    # must print 3229d6b...
```

  Or on github.com: Releases, Draft a new release, tag `v0.3.0`, target `main` (commit 3229d6b).
- The v0.3.0 goal file lived only in the build container (it was git-excluded), so this note replaces it. Its only open item was that tag.
- History: v0.1.0 built 2026-10-24/25; v0.2.0 on 2026-10-26 after a two-round audit (115 confirmed findings fixed or deferred with a reason, docs/audit/2026-10-25-audit.md); v0.3.0 on 2026-10-27 closed every deferred item (docs/audit/2026-10-27-v0.3.0-addendum.md), then a post-fix audit and a confirmation audit left no high or medium finding.
- The plugin icon is `.claude-plugin/icon.png` (from `assets/icon.svg`, a half-turn-symmetric "d" for the two PMs). The Claude plugin portal takes the icon only on the first submission, so look at it before submitting.

## 4. Get it running on your own machine

Prerequisites: Node 20.3+, git, Claude Code (logged in), Codex CLI (logged in with an OpenAI account), optionally `gh` logged in, and Obsidian to read the vault.

Claude Code side:

```
claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy
```

(or inside Claude Code: `/plugin marketplace add f6h4h9j85c-lgtm/diarchy` then `/plugin install diarchy@diarchy`).

Codex side (install the CLI first: Codex copies the plugin without its dependencies, so its MCP server and hooks run the `diarchy` on PATH):

```
npm install -g github:f6h4h9j85c-lgtm/diarchy
codex plugin marketplace add f6h4h9j85c-lgtm/diarchy
```

Then add to `~/.codex/config.toml`:

```toml
[plugins."diarchy@diarchy"]
enabled = true

[mcp_servers.diarchy]
command = "diarchy"
args = ["mcp", "--agent", "codex"]
env_vars = ["DIARCHY_PROJECT"]
startup_timeout_sec = 60
tool_timeout_sec = 1800
```

In Codex, trust the project and run `/hooks` to approve the plugin's three diarchy hooks (re-approve after a diarchy update changes them). Full details: docs/INSTALL-CLAUDE.md and docs/INSTALL-CODEX.md.

Check the setup, then do the first live run:

```
diarchy doctor            # offline checks, no model call; every warn or fail prints a fix: line; exit 1 on any fail
diarchy doctor --live     # adds one short real turn per CLI (Claude capped at about 0.25 USD)
diarchy smoke             # the first real two-model run: throwaway repo, 2-criterion goal, about 15 to 25 minutes
```

`diarchy smoke` caps spend and time (`--minutes 20`, `--max-usd 3` per Claude process; Codex has no spend flag and uses your plan), runs `doctor --live` first so a broken setup costs one short turn per CLI, and writes a redacted bundle `diarchy-smoke-<stamp>.tar.gz` in the current directory. Exit 0 = DONE, 2 = BLOCKED after both posted, 130/143 = interrupted, 1 = anything else. `--github owner/repo` (a new empty repo, `gh` logged in) adds the PR and cross-review leg. `--no-transcripts` leaves the CLI transcripts out of the bundle. `--driver fake` runs the whole pipeline with no model calls.

A real goal in your own project:

```
cd /path/to/project
diarchy init
git add AGENTS.md .codex && git commit -m "Add the diarchy Codex files"
diarchy start "Add per-API-key rate limiting to the public API." \
  --ac "Requests over the per-key limit get HTTP 429 with a Retry-After header." \
  --ac "The limit is configurable through RATE_LIMIT_PER_MIN with a documented default."
```

Follow `<project> brain/diarchy/goals/<id>/chat.md` in Obsidian or `diarchy watch` in a terminal. `diarchy status` shows phase, budget and, when you are needed, the exact `diarchy reply "..." --decision <id>` command. `diarchy stop` ends a run. Headless Claude only gets the tools in `--allowedTools` (diarchy tools, git, npm, node, gh); if your checks use another command, add `Bash(make *)` or similar to `agents.claude.args` in diarchy.config.json first. Restart any CLI session that was open before `diarchy init`.

## 5. What to do next, in order

1. Push the `v0.3.0` tag (section 3).
2. On a machine with both CLIs: `diarchy doctor`, fix every fail, then `diarchy smoke`. Bring the `.tar.gz` bundle to a new chat with this note. The bundle's `summary.txt` gives the verdict (L1 both PMs posted, L2 reached EXECUTE, L3 DONE) and per-PM hook and MCP evidence from the diagnostics trail.
3. Fix whatever the live run shows. Likely weak spots, because they were only checked against stubs: Codex's real `plugin list --json` / `mcp get --json` output shapes and hook-trust keys (doctor checks X4, X5, X8, X9), whether 0.25 USD is enough for the Claude live probe turn, how long a real challenger keeps waiting, and the macOS `ps` path for wrapper detection.
4. After a clean live run: change README "Status: pre-alpha" to alpha (test/docs.test.ts pins the Status line to the package version), and consider `smoke --github` for the PR leg.
5. Submit the Claude plugin to the plugin directory (check the icon first).
6. Later threads: upgrade to Node >= 22.12; a third agent adapter; optionally point Codex at the icon with `interface.logo` in .codex-plugin/plugin.json (not done because no real Codex was available to check it).

## 6. How to start a fresh chat

Open a Claude Code session in a clone of the repository and say something like: "Read `diarchy brain/Projects/diarchy handoff.md`, the hub, and the latest session note, then <task>." For a live-run follow-up, attach the smoke bundle and say "Here is the diarchy smoke bundle; diagnose and fix what failed." The PM-harness doctrine (goal files, reviewer before checking boxes, CEO summaries) lives in Samuel's global CLAUDE.md, not in this repo. Goal files go in `.claude/goals/` and are git-excluded, so anything that must survive a session goes in this brain.

## 7. Code map

- `src/protocol/` pure rule engine, no I/O: `schema.ts` (zod schemas for messages, kickoff, budget.json; the stored format), `rules.ts` (every rejection rule and its message text), `engine.ts` (evaluate a message against state; applyWork, applyReview, DONE 9.2 checks via doneMissing), `state.ts` (goal state), `text.ts`, `types.ts`.
- `src/vault/` the file store: `store.ts` (post, reply, stop, read cursors, workSeen derived from committed STATUS files), `lock.ts` and `lease.ts` (one live server per agent per goal), `files.ts` (atomic writes), `kickoff.ts`, `config.ts`, `render/` (chat.md, goal.md, decisions.md as plain text).
- `src/mcp/` `server.ts`, the MCP server (one process per agent) exposing the seven tools; NO_GOAL text is built per call.
- `src/cli/` `index.ts` (commander entry: init, kickoff, start, watch, doctor, smoke, status, reply, stop, mcp, hook commands), `start.ts` (supervisor: spawn, restart with backoff, park an idle PM, lease waits), `brief.ts` (nextStep: what each PM owes; the session brief), `hooks.ts` (Stop gate, inbox-skim, pre-tool guard, gateStep, launch-wrapper detection), `fake-pm.ts` (scripted PM modes good, silent, slop), `drivers.ts` (real and fake launch plans), `doctor.ts`, `smoke.ts`, `diag.ts` (opt-in diagnostics trail in `.diarchy/diag.log`), `init.ts`, `kickoff.ts`, `human.ts` (reply, stop), `status.ts`, `watch.ts`, `worktrees.ts`, `preflight.ts`, `run-record.ts`, `launcher-config.ts`, `common.ts`.
- Plugins: Claude: `.claude-plugin/`, `.mcp.json`, `agents/`, `skills/`, `hooks/hooks.json`. Codex: `.codex-plugin/`, `mcp.json`, `.agents/skills/` (copies of `skills/`), `.codex/agents/`, `hooks/codex-hooks.json`. Skills: `diarchy-pm` (the PM doctrine both PMs load), `diarchy-kickoff`, `diarchy-review`. `templates/AGENTS.md` tells Codex to load diarchy-pm.
- Docs: `docs/PROTOCOL.md` and `docs/ANTI-SLOP.md` are normative (code and tests follow them), `docs/RENDERING.md`, `docs/ARCHITECTURE.md`, `docs/QUICKSTART.md`, `docs/INSTALL-CLAUDE.md`, `docs/INSTALL-CODEX.md`, `docs/samples/` (a rendered sample run), `docs/audit/` (both audit reports). `CONTRIBUTING.md` has the live smoke test section.
- Tests (`test/`, about 539): protocol fixtures (`test/fixtures/protocol/valid|slop/*.yaml`), vault, mcp, e2e (fake-driver runs), supervisor, doctor, diag, smoke-runner, docs parity, codex-config. Stored-vault fixtures `test/fixtures/vault/v0.1.0-goal` and `v0.2.0-goal` (the latter generated by the real 0.2.0 code; `v0.2.0-schema/` holds the 0.2.0 compiled schema for the reverse check). `test/fixtures/vault/sample-run` is the golden sample.

## 8. Rules for working on this repo (each one is enforced by a test or CI)

- `dist/` is committed (plugin installs run no build). After any `src/` change run `npm run build` and commit `dist/`; CI rebuilds and fails on any diff.
- Checks: `npm ci && npm run lint && npm run typecheck && npm test`, plus `claude plugin validate .`. The full suite takes 5 to 10 minutes; under load use `npm test -- --no-file-parallelism`.
- PROTOCOL.md and ANTI-SLOP.md are normative and parsed by tests; change behaviour and docs in the same commit.
- `skills/diarchy-pm/SKILL.md` must stay under 900 words (it is at 899): any addition needs an equal cut. Edit `skills/` then run `npm run sync-skills` to update `.agents/skills/` (a test checks they match).
- `npm run gen-samples` rebuilds docs/samples and the sample-run fixture; it must be a no-op on an unchanged scenario.
- Stored-file compatibility: never add a field to budget.json, chat files, kickoff.md, inbox or lease files. An older plugin copy or global CLI sharing the vault reads any unknown field as corrupt.
- Tests must never start a real model run or touch the real `~/.claude` or `~/.codex` (stub CLIs first on PATH, temp HOME).
- No em-dashes anywhere in prose. Commit messages: an imperative subject, then the session's trailer lines.
- Never `git stash` when several worktrees are in use (the stash is shared).

## 9. How v0.3.0 was built (so the next round can reuse the process)

Each change was made in its own git worktree and branch, reviewed by an independent reviewer agent, then merged with `--no-ff` into an integration branch by one integrator who reran every check after each merge. After integration, an adversarial audit ran one finder per changed area; each high or medium finding went to two independent refuters (reproduce; realism and spec) and each low to one, and a finding survived only with zero refutes. Survivors were fixed the same way, then a confirmation audit checked those fixes. A final reviewer verified every acceptance criterion before release. Full record: docs/audit/2026-10-27-v0.3.0-addendum.md (33 open items closed: 26 fixed with a guard test, 3 closed with a reason, 4 housekeeping or release steps; post-fix audit 4 medium and 14 low survivors, all fixed; confirmation audit 0 high or medium).

## 10. Known limits and decisions worth remembering

- An interrupted `diarchy smoke` exits 128 plus the signal number (changed in v0.3.0 from 1).
- Supervisor parking: a PM that ends its turn with nothing owed is parked (no restart used) and woken by a message or when no PM is running; a lead with a timed duty (the silent CHALLENGE window) or a due DONE is never parked; a parked PM gets one uncounted relaunch after 2 x the wait cap (about 220 s).
- The talk gate resets only on NEW work evidence (a commit, PR, review or test no earlier STATUS carried).
- Review tasks close only through review evidence; `task_status` never changes a review task.
- `diarchy start` and `kickoff` refuse to run without `diarchy init`.
- The Stop gate steps over known launch wrappers (sh -c, npx, npm, pnpm, yarn, bun) up to four hops; an unknown wrapper makes the session's own server look like another session's, and the gate then stays silent for that session.
- Cross-review is the default, enforced when the goal closes (DONE), and `review.required: false` waives it (smoke's local mode does).
- The project brain is this folder, `diarchy brain/`, committed in the repo. No secrets in it, ever.
