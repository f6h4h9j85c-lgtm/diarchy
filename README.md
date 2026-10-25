# diarchy

diarchy installs into Claude Code and OpenAI Codex CLI and runs each as a product-manager agent on one goal. The two PMs are peers from different vendors: one leads, the other challenges, and each delegates to its own subagents in private. They talk only through a chat in an Obsidian vault, and every message passes through an MCP server that enforces the protocol in code, so the exchange cannot drift into acknowledgements, repetition, or open-ended debate. The human reads three rendered files and is called in only for a true deadlock, a missing credential, or a spent budget. Every PR is reviewed by the other model before it merges.

Status: pre-alpha, v0.1.0. Requires Node 20 or later.

## How a run works

1. `diarchy start "<goal>" --ac "<criterion>" --ac "<criterion>"` writes `kickoff.md`, creates a git worktree per agent under `.diarchy/worktrees/<agent>`, and spawns both CLIs headless. The agent that receives the goal is the lead; the other is the challenger. Roles swap on the next goal (`--lead` overrides). Nothing routes work by model or by frontend/backend ownership.
2. PLAN. The lead posts one PROPOSE with `decision_id: plan`: one falsifiable claim and 2 to 6 tasks mapped to acceptance criteria.
3. The challenger posts at most one CHALLENGE, which must carry a `test` evidence item naming the cheapest check that settles it. Silence is legal.
4. The lead must DECIDE within 2 messages or 10 minutes: adopt the challenge, reject it on a test it ran, or rule by authority and say why. Deciding `plan` moves the goal to EXECUTE. PLAN is capped at 12 messages.
5. EXECUTE. The lead ASSIGNs tasks by availability. Each PM works on its branch `diarchy/<goal-id>/<agent>` and posts STATUS with commit, test, and PR evidence. After three messages without a STATUS, only STATUS, BLOCKED, and DONE are accepted.
6. Every PR is ASSIGNed for review to the agent that did not write it. An `approve` from a non-author is the only thing that unlocks merge.
7. A PM posts BLOCKED `kind: external` for a credential it lacks, a destructive action, or a product call. The goal moves to BLOCKED, the store posts a system ASK_HUMAN, and the launcher exits 2. A deadlock or a spent budget (80 messages or 240 minutes by default) does the same.
8. The human reads `goal.md`, `chat.md`, and `decisions.md` in Obsidian and answers with `diarchy reply "<text>"`: a DECIDE with `basis: human` that resumes the goal.
9. The lead posts DONE once every AC has a passing test, every PR has a cross-review, and no thread is open. The launcher exits 0.

The plan being settled, from `docs/samples/chat.md` with blank lines removed:

```
○ **claude → all · PROPOSE · plan · re AC1, AC2 · 14:02:10**
*A token-bucket middleware keyed by API key in the existing Redis client satisfies AC1 and AC2.*
Three tasks: middleware, env-driven limit, tests. Redis so all replicas share one counter.
---
▲ **codex → claude · CHALLENGE · plan · re AC1 · 14:04:55**
replying to claude PROPOSE 14:02:10
*An in-process bucket meets AC1 with no network hop if the API runs as one replica.*
- test: `kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1` · pending
---
● **claude → all · DECIDE · plan · re AC1, AC2, AC3 · 14:07:30**
basis: test · replying to codex CHALLENGE 14:04:55
*Use the Redis-backed token bucket because the API runs three replicas.*
Printed 3. In-process buckets would triple the effective limit.
- test: `kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1` · **fail** · log `.diarchy/logs/replicas.txt`
```

## Why it does not turn into slop

| Rule family | What is rejected | Enforced in |
|---|---|---|
| Shape: SCHEMA, TYPED_ONLY, WRITER_OWNED, HUMAN_LAST_RESORT | Unknown types, missing fields, a spoofed `from`, an agent posting ASK_HUMAN | server, validator |
| One claim: ONE_CLAIM, WORD_CAP | A claim over one sentence or 40 words; a body over 120 words | validator |
| No noise: NO_ACK, CITE_AC | "agreed", "thanks", "LGTM"; a STATUS without evidence; a message citing no AC | validator, store |
| Evidence: CHALLENGE_NEEDS_TEST, NEW_EVIDENCE, DECISION_IMMUTABLE | A CHALLENGE without a test; reopening a decision without a failed test, a human message, or an external URL | validator, store |
| Bounded debate: ONE_CHALLENGE, TWO_ROUNDS, DEADLOCK | A second challenge on one decision; a third message before the DECIDE; a lead that does not decide in 2 messages or 10 minutes (the goal blocks) | store |
| Phases and roles: PHASE_GATE, ROLE_GATE, SINGLE_KICKOFF | A PROPOSE in EXECUTE; a challenger deciding; a second kickoff while a goal is active | store |
| Budgets: PLAN_BUDGET, TALK_WORK_RATIO, TOTAL_BUDGET, WALL_CLOCK | A 13th PLAN message other than the lead's DECIDE; a fourth EXECUTE message without a STATUS; anything after 80 messages or 240 minutes | store; launcher kills the CLIs after the clock |
| Work and review: NO_DOMAIN_ROUTING, NO_SELF_REVIEW, BUSY_REVIEWING, DONE_PRECONDITION | An ASSIGN reason other than availability, continuity, or load-balance; self-review; implementation assigned to a busy reviewer; DONE with an untested AC or an unreviewed PR | validator, store |

These are code rather than prompts because prompts cannot be tested and degrade under load. When language-model peers debate, a correct answer is more likely to flip to a wrong one than the reverse (arXiv 2509.05396); most multi-agent failures are specification and coordination problems, not model limits (MAST, arXiv 2503.13657); and Anthropic's multi-agent research system became reliable only after free-form coordination gave way to structured briefs. Error texts and fixtures: `docs/ANTI-SLOP.md`.

## Install

### Claude Code

```
claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy
```

Or, inside Claude Code, `/plugin marketplace add f6h4h9j85c-lgtm/diarchy` then `/plugin install diarchy@diarchy`. To try a checkout, run `npm ci && npm run build` in it and start `claude --plugin-dir /abs/path/to/diarchy`. Verify: `/mcp` lists `diarchy` with seven tools, and asking Claude to call the diarchy `read` tool returns `NO_GOAL` until a goal exists. Details: `docs/INSTALL-CLAUDE.md`.

### Codex CLI

```
codex plugin marketplace add f6h4h9j85c-lgtm/diarchy
```

Then add to `~/.codex/config.toml`:

```toml
[plugins."diarchy@diarchy"]
enabled = true

[mcp_servers.diarchy]
command = "node"
args = ["/abs/path/to/diarchy/bin/diarchy.js", "mcp", "--agent", "codex"]
startup_timeout_sec = 20
tool_timeout_sec = 1800
```

Skills load from `.agents/skills/`. Trust the project (start `codex` in it once and accept the prompt, or add `[projects."/abs/path/to/project"]` with `trust_level = "trusted"`) so `.codex/hooks.json` and `.codex/agents/*.toml` run, and copy `templates/AGENTS.md` to the project root. Verify: `/mcp` lists `diarchy`, and the `read` tool answers `NO_GOAL`. Details: `docs/INSTALL-CODEX.md`.

## Quickstart

```
npx diarchy init
diarchy start "Add per-API-key rate limiting to the public API." \
  --ac "Requests over the per-key limit get HTTP 429 with a Retry-After header." \
  --ac "The limit is configurable through RATE_LIMIT_PER_MIN with a documented default."
```

`init` writes `diarchy.config.json`, creates the vault at `<project> brain/diarchy`, and adds `.diarchy/` to `.gitignore`. `start` creates `goals/<YYYYMMDD>-<slug>/` in the vault: `kickoff.md`, `goal.md`, `chat.md`, `decisions.md`, `budget.json`, and `chat/` with one file per message. Follow `chat.md` in Obsidian or `diarchy watch` in a terminal. `diarchy status` shows phase, roles, budget, open assignments, and the exact `diarchy reply` command when you are needed. `diarchy stop` posts a human BLOCKED message and ends the run. `--driver fake` runs the protocol with scripted PMs and no model calls.

Dev mode: open `claude` and `codex` interactively in the same project and state the goal once to either. The `diarchy-kickoff` skill kicks off, that CLI becomes lead, and the other joins when it calls `read`. See `docs/QUICKSTART.md`.

## Project layout

```
.claude-plugin/  Claude Code plugin and marketplace manifests
.agents/         Codex marketplace manifest and skill copies
.codex/          Codex hooks.json and subagent .toml files
agents/          Claude Code subagents
bin/             diarchy.js, the CLI entry (imports dist/)
docs/            PROTOCOL, ANTI-SLOP, RENDERING, ARCHITECTURE, INSTALL-*, samples/
hooks/           hooks.json and the two hook scripts
scripts/         sync-skills.mjs
skills/          diarchy-pm, diarchy-kickoff, diarchy-review
src/protocol/    pure engine: schema, rules, state, transitions
src/vault/       store: files, lock, cursors, renderers
src/mcp/         the MCP server, one process per agent
src/cli/         launcher, human commands, hook helpers
templates/       AGENTS.md for Codex projects
test/            vitest suites and fixtures
```

## Status and roadmap

v0.1 ships the protocol engine, the vault store and renderers, the MCP server, both plugins, and a launcher with a real driver and a scripted fake PM. Not yet proven: CI runs lint, typecheck, build, and the tests, including an end-to-end run with the fake PM, but no live two-model run, and the Codex side has not been exercised against a real Codex binary. Next: Cursor and other MCP clients as a third agent (everything is already keyed by agent id), store-executed tests so `result: pass` is checked rather than trusted, and hardening of headless session resume.

## Development

```
npm ci && npm run lint && npm run typecheck && npm test
```

`test/protocol.test.ts` runs every fixture under `test/fixtures/protocol/` (`slop/` one rejected message per rule, `valid/` accepted ones, `bases/` starting states, `examples/` the nine PROTOCOL.md messages) and checks that the rule table in `docs/ANTI-SLOP.md` matches the code. `test/vault.test.ts` replays `test/fixtures/vault/sample-run` through a real store and compares `docs/samples/` byte for byte. `test/mcp.test.ts` drives two servers over in-memory and stdio transports. `test/codex-config.test.ts` checks that the Codex copies mirror `skills/` and `agents/`. See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
