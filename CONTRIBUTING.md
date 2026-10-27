# Contributing

## Checks

```
npm ci
npm run lint && npm run typecheck && npm test
```

CI runs these on Node 20 and 22, plus the `dist/` check below. `npm test -- protocol` (or `vault`, `mcp`, `codex-config`, `install`) runs one suite. After editing anything under `skills/`, run `npm run sync-skills` so `.agents/skills/` matches; `test/codex-config.test.ts` fails otherwise. A change to `agents/*.md` needs the same change in `.codex/agents/*.toml`, and a change to `hooks/hooks.json` the same in `hooks/codex-hooks.json`.

## Diagnostics

`diarchy doctor` checks a machine's setup without a model call, and `diarchy doctor --live` runs one short real turn per CLI; `test/doctor.test.ts` drives both against stub CLIs in `test/fixtures/doctor/`. To see what a real run does, create an empty `.diarchy/diag` in the project (or set `DIARCHY_DIAG=1`, which Codex does not pass to an MCP server): every MCP server start, hook run, and MCP tool result then appends a JSON line to `.diarchy/diag.log` saying which binary ran, how it found the project, and what it decided, never an environment value or the text of a command. `DIARCHY_DIAG=0` keeps the trail off despite the marker in every process it reaches; like `=1`, it never reaches a server Codex starts, so remove the marker to silence the Codex PM's server. `diarchy doctor` sets it for `claude mcp list`, whose health check starts the server in the project, and runs its own MCP and hook probes in a throwaway project, so its checks stay out of the trail. `diarchy doctor --live` drops any `DIARCHY_DIAG` you exported from its turns, whose checks read the probe project's trail.

## Live smoke test

`diarchy smoke` runs both PMs for real on a small goal in a throwaway git repository and writes a diagnostics bundle to send back. The goal asks for a `greet.mjs` with two acceptance criteria, each checked by a node:test test, so the lead has work to split.

Prerequisites: Claude Code and Codex CLI installed and logged in, the diarchy plugin installed in both at user scope with Codex's `[mcp_servers.diarchy]` entry (docs/INSTALL-CLAUDE.md, docs/INSTALL-CODEX.md), and the global CLI (`npm install -g github:f6h4h9j85c-lgtm/diarchy`). Then, from any directory:

```
diarchy smoke
```

It makes the project under the temp directory (its vault path has a space in it), runs `diarchy init`, and checks the setup with `diarchy doctor --live` first: any fail stops the run before a goal exists, so a broken setup costs one short turn per CLI. Then it kicks the goal off with Claude as lead, runs `diarchy watch` and `diarchy start`, and prints every line prefixed with the seconds since it began. Expect 15 to 25 minutes.

Cost caps: `--minutes` (default 20) is the goal's wall clock; then the CLIs get 60 s to finish, and a watchdog stops `diarchy start` 3 minutes past the wall clock. Each Claude process runs with `--max-budget-usd` set to `--max-usd` (default 3) when the installed `claude` lists that flag; a restarted Claude is a new process with its own cap. Codex has no spend flag; its turns come out of your plan.

Review is off (`review.required: false`), so no GitHub repository is needed. `--github owner/repo` adds the PR leg: create a new empty repository first (`gh repo create <name> --private`) and have `gh` logged in. Smoke pushes `main` there and turns review on, so the Claude PM opens the PRs (the sandboxed Codex PM cannot push) and each PM reviews the other's. Use a new repository for each run.

Exit codes: 0 when the goal is DONE, 2 when it is BLOCKED after both PMs posted, 128 plus the signal's number when a signal stopped the run (130 for Ctrl-C, 143 for SIGTERM; the step running gets the signal too, the bundle is still written, and no further step starts), 1 otherwise (aborted, stalled, or blocked before both posted). The verdict is tiered: L1 both PMs posted, L2 the goal reached EXECUTE, L3 DONE.

The bundle is `diarchy-smoke-<stamp>/` and `diarchy-smoke-<stamp>.tar.gz` in the current directory (`--out <dir>` puts them elsewhere):

- `summary.txt` and `summary.json`: the verdict, and per PM its posts, spawns, restarts, session id, and the hook and MCP evidence from the diagnostics trail
- `doctor.json` and `ping/`, `init.log`, `kickoff.json`, `start.log`, `watch.log`, `status.json`
- `vault/`: the goal's directory (`chat.md`, `goal.md`, `budget.json`, `chat/`, `inbox/`)
- `runtime/`: saved sessions, Stop gate records, and `diag.log`
- `git/`: the log of every branch, the worktrees, and each PM branch's diff against main
- `diarchy.config.json` and `versions.txt`
- `transcripts/`: both CLIs' transcripts of the run

Every file is redacted: the home directory becomes `~`, emails `[email]`, and tokens (`sk-`, `ghp_`, `xox`, `AKIA`, `Bearer`) keep only their prefix. A transcript can still quote your global CLAUDE.md or AGENTS.md; `--no-transcripts` leaves the transcripts out. Send back the `.tar.gz`.

The throwaway project stays in the temp directory for a look (`--clean` deletes it), and each CLI keeps its own transcript of it as usual. `--no-ping` skips the live doctor turn. Codex has not been told to trust the temp project, so the subagents in `.codex/agents` may not load there. `--driver fake` runs the same pipeline with the scripted PM and no model calls; `test/smoke-runner.test.ts` runs it that way, and runs `--driver real` only against `claude` and `codex` stubs that exit 127, with a temp `HOME`, so the doctor stops it before a goal exists.

## Built output

`dist/` is committed. Claude Code installs a marketplace plugin by copying the git tree into its cache and running `npm install --ignore-scripts`, so nothing builds after checkout, and `.mcp.json`, the three hooks, and the npm `bin` all start through `bin/diarchy.js`, which imports `dist/cli/index.js`. Codex copies the git tree and installs no dependencies at all, so in its plugin cache the import fails and `bin/diarchy.js` hands the call to the `diarchy` on `PATH` (the global install docs/INSTALL-CODEX.md section 1 requires); keep `bin/diarchy.js` free of dependencies. After changing anything under `src/`, run `npm run build` and commit `dist/` in the same commit. If you removed or renamed a source file, run `rm -rf dist && npm run build` so the stale output goes too. CI rebuilds from a clean `dist/` and fails on `git diff --exit-code -- dist`; `test/install.test.ts` extracts `git archive HEAD` and runs `node bin/diarchy.js --version`, so a commit without `dist/` fails the suite. The build is deterministic (`tsc` at the locked TypeScript version, `newLine: lf`, no absolute paths), so a correct `dist/` never shows as modified.

## Adding a protocol rule

1. Add a row to the rules table in `docs/ANTI-SLOP.md` (id, rule, enforcement layer, error message with `{placeholders}`, fixture name) and put the id into the evaluation-order table. `test/protocol.test.ts` parses both tables and fails when the code disagrees.
2. Add the id to `RULE_IDS` in `src/protocol/types.ts` at the same position, and a rule function in `src/protocol/rules.ts` that returns `reject(ID, text)` or `null`, registered in `RULES`.
3. Add `test/fixtures/protocol/slop/<rule_id>-<case>.yaml`: a base state from `bases/`, the message, `expect.ok: false`, `expect.rule`. Add a near-miss to `valid/` when the boundary matters.
4. The error text parity test matches the function's text against the doc's template with placeholders as wildcards. Change both or neither.
5. If the rule changes what a tool accepts, update PROTOCOL.md section 10 and the tool description in `src/mcp/server.ts`.

## Changing rendering

Edit `docs/RENDERING.md` first. The samples win over the spec when they disagree, so change `docs/samples/*.md` in the same commit. `test/vault.test.ts` replays `test/fixtures/vault/sample-run/` through a real store and compares bytes; the failing assertion shows the diff. The sample message files are the golden input and are not edited to make a rendering change pass. `npm run gen-samples` replays them through the store and rewrites `docs/samples/*.md`, the message files, and `test/fixtures/protocol/bases/execute-ready.yaml`; after a rendering change only the samples may move. To change the scenario itself, edit, add, or delete message files (any parseable id; ts sets the order) and rerun it: the store assigns the ids and `reply_to` follows them. Then update the counts the tests pin and the strips `docs/RENDERING.md` quotes.

## Conventions

- Commit subject in the imperative, under 72 characters, naming the component: `Add BUSY_REVIEWING to the assign path`. The body says why.
- No em dashes in prose, docs, comments, or rendered output. Use a colon, a comma, or ` · `.
- Protocol tokens (`EXECUTE`, `adopted-challenge`, rule ids) are written literally everywhere.
- Keep the line `claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy` in the README; the plugin validator looks for it.
- Lint and typecheck pass clean; no `eslint-disable` without a reason in the comment.
