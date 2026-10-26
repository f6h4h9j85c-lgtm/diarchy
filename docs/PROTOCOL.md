# diarchy PROTOCOL (protocol_version: 1)

## 1. Purpose and scope

diarchy runs two product-manager agents, Claude Code (`claude`) and Codex CLI (`codex`), against one goal. Each PM delegates to its own subagents privately. PM-to-PM coordination happens only through markdown files in an Obsidian vault, and a PM reads or writes those files only through the MCP server `diarchy-mcp`, which enforces this document and ANTI-SLOP.md. The human writes through the launcher (`diarchy reply` and `diarchy stop`, section 10), which uses the same store as `human`; that identity is configuration, not a credential (ANTI-SLOP.md, What this does NOT prevent). This spec defines the files, messages, state machine, budgets, and MCP contracts; it does not define prompts or subagent behaviour inside either CLI.

Terms: the **store** is the file layer inside `diarchy-mcp` (one process per agent, both sharing the vault); the **validator** is its stateless message checker; the **server** is its MCP tool layer; the **launcher** is the `diarchy` CLI. MUST, MUST NOT, and MAY are normative.

## 2. Vault layout

```
<project>/
  diarchy.config.json
  .diarchy/worktrees/<agent>/              git worktrees, gitignored
  <project> brain/diarchy/                 vault root (config key: vault)
    goals/.lock/         vault lock: one kickoff at a time (mkdir-atomic); store-internal
    goals/<goal-id>/
      kickoff.md         start signal; written once, atomically
      goal.md            goal, ACs, tasks, status; store-rendered
      chat/              one file per accepted message; writer-owned; never edited or deleted
        20261025T143012Z-0007-claude-PROPOSE.md
        .orphans/        files a crash left uncommitted (2.2); store-internal
      chat.md            merged transcript; store-rendered
      decisions.md       decision ledger; store-rendered
      budget.json        counters and machine state; store-owned
      inbox/<agent>.json read cursor per agent; store-owned
      inbox/<agent>.lock/ held by the one live MCP server acting as <agent> (10); store-internal
      .lock/             transaction lock (mkdir-atomic); store-internal
```

`<goal-id>` is `<YYYYMMDD>-<slug>`, slug `[a-z0-9-]{1,40}` derived from the goal text (accents dropped; `goal-<HHMMSS>` from `created` when the text has no Latin letter or digit), overridable at kickoff. kickoff never overwrites a committed goal (2.2). Under the vault lock no goal is active, so one that already holds `<YYYYMMDD>-<slug>` is finished: a slug derived from the goal text gets the first free `-2`, `-3`, ... suffix, shortened to stay within 40 characters, while a `slug` the caller passed names the id it asked for and is never renamed: SINGLE_KICKOFF refuses it (the id of a DONE goal is not reused; kick off with another slug), and a taken `goal_id` fails SCHEMA. A directory an interrupted kickoff left does not hold the id. At most one goal per vault is active (PLAN, EXECUTE, or BLOCKED); kickoff holds `goals/.lock/` from its active-goal check to the KICKOFF commit, so two kickoffs cannot both start a goal.

### 2.1 Message filename

`chat/<ts-compact>-<seq>-<agent>-<type>.md`

| Part | Format | Example |
|---|---|---|
| ts-compact | `YYYYMMDDTHHMMSSZ`, UTC, store-assigned | `20261025T143012Z` |
| seq | 4 digits, zero-padded, per-agent monotonic (`budget.json.seq[<agent>]`) | `0007` |
| agent | sender id | `claude` |
| type | message type | `PROPOSE` |

`id` is the filename without `.md`. The store assigns `ts` and `seq` under the goal lock and guarantees `ts` strictly exceeds the previous accepted message's `ts` (sleeping to the next second if needed), so `(ts, seq)` is a total order. Writers cannot collide: every filename carries the writer's id and the writer's own seq.

### 2.2 Transaction

One accepted message is one transaction: acquire `.lock/` by `mkdir` (a stale lock MAY be taken over, see Locks below); run validator, then store checks against `budget.json`; write `chat/<id>.md` via temp file plus rename; update `budget.json`, `goal.md`, `chat.md`, `decisions.md`; release.

Writing `budget.json` commits the transaction. Rendering the three views follows the commit and cannot undo it: a render failure is logged to stderr and the caller still gets the committed result, and the next transaction or `diarchy render` renders again. A `chat/` file whose id `budget.json` does not record was never accepted: reads and renders skip it, a store that fails before the commit removes the files it wrote, and the next transaction moves any file a crash left this way to `chat/.orphans/` before it reads anything. Kickoff holds the new goal's lock from its first write and writes `budget.json` only with the KICKOFF recorded, so a goal exists once that write lands. A goal directory without such a `budget.json` is what an interrupted kickoff left: it is ignored as a goal (`read` returns NO_GOAL only if no other committed goal exists), and the next kickoff of that goal id clears it under the lock and starts over.

Locks (`.lock/`, `goals/.lock/`, `inbox/<agent>.lock/`) are directories made with `mkdir`. The creator writes `owner` inside (pid, host, random token) and refreshes the directory's mtime every 10 s while it holds it. A lock is stale when its mtime is older than 30 s, or when its owner is a dead process on the same host and pid namespace. Taking over a stale lock MUST be exclusive: the store takes `<lock>.reap/` by `mkdir`, checks that the same lock is still stale, renames it aside, and deletes it. A store releases a lock only while `owner` still carries its token, so a holder that lost its lock never removes its successor's.

### 2.3 Store-owned files

`goal.md`: `# <goal-id>`, goal text, then tables `## Status` (phase, lead, challenger, updated), `## Acceptance Criteria` (id, criterion, status `open|passing|failing`, set by the latest `test` evidence citing it in a STATUS accepted in EXECUTE; `test` items in CHALLENGE, DECIDE, DONE, or a PLAN STATUS are probes or attestations and never change AC status, and a `pass` item in a STATUS that carries a `request_changes` review leaves AC status as it was), `## Tasks` (id `T<n>`, task, assignee, branch, status `todo|assigned|in_progress|done`). A budget line (`<used> of <limit> messages (PLAN <used> of <limit>) · <used> of <limit> min`) follows the Status table. The exact layout, including the question callout shown while BLOCKED, is docs/RENDERING.md.

`chat.md`: `# Chat: <goal-id>`, then one block per message sorted by `(ts, seq)`, separated by `---`: header `**<from> → <to> · <TYPE> · <decision_id> · re <AC list> · HH:MM:SS**` (decision segment omitted when absent), claim in italics if present, body, evidence as bullets `- <kind>: <key fields>`. The renderer MAY place one header block between the title and the first message, and MAY insert `## → <PHASE> · HH:MM:SS` headings after the `---` that follows a phase-changing message; a glyph MAY precede the bold header. The exact layout is docs/RENDERING.md.

`decisions.md`: table `id | ts | by | claim | basis | evidence | supersedes`, one row per accepted DECIDE.

All three start with `<!-- generated by diarchy; do not edit -->`.

`kickoff.md`: frontmatter `protocol_version, goal, lead, challenger, agents, budgets` (overrides, may be `{}`), `project` and `vault` (absolute paths), `created`, `by` (`human|claude|codex`); body is the goal text on one line, a blank line, then one `- AC<n>: <criterion>` line per criterion, numbered from 1. The format is line based, so the store rejects (SCHEMA) a goal or criterion containing a line terminator (CR, LF, VT, FF, U+0085, U+2028, U+2029) or an unpaired surrogate, and a goal that starts with `- AC<n>: `, so whatever it accepts parses back unchanged. The parser takes the unbroken run of AC lines that ends the body as the criteria and everything above it as the goal text. A body that does not parse that way is read as diarchy 0.1.0 wrote a criterion holding a line break: the criteria start at the first AC line, and a line that is not an AC line continues the criterion above it (section 12). Written to `kickoff.md.tmp-<pid>-<random>`, then renamed.

`budget.json`: `protocol_version, goal, created, lead, challenger, agents, kickoff_id, phase, blocked_from, limits{...}, used{plan_messages, messages_total, talk_since_work, wall_clock_minutes, spend_usd}, seq{<agent>: n}, last_ts, decisions{<id>: {status, proposer, messages, challenges, supersedes, superseded_by, evidence, challenge}}, prs{<url>: {author, reviews: [{by, verdict}]}}, deadlock_watch{decision_id, challenge_id, remaining, deadline} | null, acs{<AC id>: {criterion, status}}, tasks{<task id>: {id, task, kind, assignee, branch, worktree, pr, status}}, messages[{id, from, type, decision_id, re}], review_required, updated`. `seq` has one entry per writer, including `human` and `system`. A decision's `status` is `open|decided|superseded`, `evidence` lists the evidence keys already cited on it (NEW_EVIDENCE), and `challenge` is its unanswered CHALLENGE `{id, from, new_evidence}` or null. `messages` indexes every accepted message in `(ts, seq)` order. The store loads the file strictly (`goalStateSchema` in src/protocol/schema.ts): a missing or unlisted key fails the load.

`inbox/<agent>.json`: `{protocol_version, agent, cursor: <last delivered id> | null, updated}`. The cursor only spares re-delivery, so a file that will not parse, or is not that agent's protocol_version 1 inbox, reads as cursor null with one warning naming it: `read` and `wait_for_reply` deliver from the start of the goal again, the Stop gate and session brief count from there, and the next delivery rewrites the file.

Every store write goes to `<file>.tmp-<pid>-<random>` in the same directory, then a rename. `kickoff.md`, `budget.json`, and `chat/` files are flushed to disk before the rename, and their directory after it, so a power loss leaves the old file or the new one. A goal whose `budget.json` does not parse, or carries another `protocol_version`, is left out of goal listings with a warning naming the file, and the store fails closed on it, since it may be the active goal: while it exists, kickoff is refused (SINGLE_KICKOFF naming the file), and unless a readable goal started after it (`created` from its kickoff.md), every tool and `diarchy status` report the file as corrupt instead of NO_GOAL or an older goal. An older unreadable goal behind a newer readable one leaves that goal working. Repairing the file, or moving the goal directory out of the vault, clears it.

## 3. Message file format

YAML frontmatter, then body.

| Field | Type | Required on | Rule |
|---|---|---|---|
| protocol_version | int | all | `1` |
| id | string | all | filename stem; store-assigned |
| goal | string | all | goal-id |
| from | agent id | all | equals the posting server's configured identity |
| to | string | all | an agent id, `all`, or `human` |
| type | enum | all | one of the nine types |
| re | list | all | AC ids; non-empty; each exists in goal.md |
| reply_to | message id | optional | must exist in `chat/` |
| phase | enum | all | phase at acceptance, before any transition the message causes; store-assigned |
| claim | string | PROPOSE, CHALLENGE, DECIDE | one sentence: 1 to 40 whitespace-split words, last character `.` `!` or `?`, no other `.` `!` `?` followed by whitespace |
| evidence | list | STATUS, DONE, CHALLENGE | items per 3.1 |
| decision_id | string | PROPOSE, CHALLENGE, DECIDE; optional on ASK_HUMAN | `plan` or `D<n>`; store-assigned on PROPOSE, on a superseding DECIDE, and on a human DECIDE that names none; a deadlock ASK_HUMAN carries the stalled decision's id |
| ts | ISO 8601 UTC | all | `2026-10-25T14:30:12Z`; store-assigned; readers MUST treat it as a string (no YAML timestamp coercion) |

Type-specific fields. DECIDE: `basis` (`test|authority|adopted-challenge|human`), `supersedes` (decision_id), `tasks` (list; `plan` only; each one line, 40 words max), `ac_add` (list; `plan` only; 40 words max each; appended as `AC<n+1>..`, never removed or reworded), `budgets` (partial limits; human only). ASSIGN: exactly one of `task` (task id) or `new_task` (string; one line, 40 words max); `kind` (`implement|review`); `worktree` (one line, 200 characters max) and `branch` (a name `git check-ref-format --branch` accepts: letters, digits, `.` `_` `/` `-`; 200 characters max; no `..`, `//`, `/.`, or `.lock/`; no leading `-`, `/`, or `.`; no trailing `/`, `.`, or `.lock`; not `HEAD`) (implement); `pr` (review); `reason` (`availability|continuity|load-balance`, optional). STATUS: `task`, `task_status` (`in_progress|done`), optional; `done` does not close a review task (section 5). BLOCKED: `kind` (`external|internal`).

One line: no line break and no other control character (C0, DEL, C1, U+2028, U+2029). These fields reach goal.md, chat.md, the SessionStart brief, and the Stop-hook reason, so the store rejects a value over its cap or spanning lines with SCHEMA. These caps apply to posts; a stored `chat/` file is read with the rules it was written under (section 12).

Body: free text, at most 120 whitespace-split tokens. MAY be empty except on KICKOFF, BLOCKED, ASK_HUMAN.

### 3.1 Evidence items

| kind | Required fields | Optional | New evidence? |
|---|---|---|---|
| commit | `sha` (7 to 40 hex) | | no |
| pr | `url` | | no |
| test | `test` (command or check, 40 words max), `result` (`pass|fail|pending`) | `log` (path; one line, 200 characters max) | only when `result: fail` |
| file | `path` (one line, 200 characters max) | | no |
| review | `url` (PR), `verdict` (`approve|request_changes`) | | no |
| human | `id` (message id with `from: human`) | | yes |
| external | `url` | `note` (20 words max) | yes |

"New evidence" relative to decision D: an item whose kind qualifies above and whose key `(kind, test|url|id)` appears in no accepted message carrying `decision_id` D or any decision D supersedes.

"Work evidence": a `commit`, `pr`, or `review` item, or a `test` item with `result` pass or fail. It is new when no earlier STATUS on the goal carried the same key: `commit` by `sha` (a sha that is a prefix of an earlier one, or that an earlier one is a prefix of, is the same commit), `pr` by `url`, `review` by sender, `verdict`, and `url` (a re-review that changes the verdict is new), `test` by `result` and `test`. Only a STATUS carrying new work evidence resets `talk_since_work` (section 8); one carrying only work evidence seen before, or only `file`, `human`, `external`, or pending `test` items, is accepted and leaves the counter as it was. `budget.json` does not record these keys: the store reads them from the goal's committed `chat/` files and leaves out a file that will not parse.

Word-limited text (`test`, `note`, each `ac_add` item) needs at least one word: a blank or whitespace-only value fails SCHEMA.

### 3.2 Examples (goal `20261025-rate-limit`, lead `claude`, ACs AC1 to AC3)

`chat/20261025T140000Z-0001-human-KICKOFF.md`
```yaml
---
protocol_version: 1
id: 20261025T140000Z-0001-human-KICKOFF
goal: 20261025-rate-limit
from: human
to: all
type: KICKOFF
re: [AC1, AC2, AC3]
phase: PLAN
ts: 2026-10-25T14:00:00Z
---
Add per-API-key rate limiting to the public API.
```

`chat/20261025T140210Z-0001-claude-PROPOSE.md`
```yaml
---
protocol_version: 1
id: 20261025T140210Z-0001-claude-PROPOSE
goal: 20261025-rate-limit
from: claude
to: all
type: PROPOSE
re: [AC1, AC2]
decision_id: plan
phase: PLAN
claim: A token-bucket middleware keyed by API key in the existing Redis client satisfies AC1 and AC2.
ts: 2026-10-25T14:02:10Z
---
Three tasks: middleware, env-driven limit, tests. Redis so all replicas share one counter.
```

`chat/20261025T140455Z-0001-codex-CHALLENGE.md`
```yaml
---
protocol_version: 1
id: 20261025T140455Z-0001-codex-CHALLENGE
goal: 20261025-rate-limit
from: codex
to: claude
type: CHALLENGE
re: [AC1]
reply_to: 20261025T140210Z-0001-claude-PROPOSE
decision_id: plan
phase: PLAN
claim: An in-process bucket meets AC1 with no network hop if the API runs as one replica.
evidence:
  - kind: test
    test: "kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1"
    result: pending
ts: 2026-10-25T14:04:55Z
---
```

`chat/20261025T140730Z-0002-claude-DECIDE.md`
```yaml
---
protocol_version: 1
id: 20261025T140730Z-0002-claude-DECIDE
goal: 20261025-rate-limit
from: claude
to: all
type: DECIDE
re: [AC1, AC2, AC3]
reply_to: 20261025T140455Z-0001-codex-CHALLENGE
decision_id: plan
phase: PLAN
claim: Use the Redis-backed token bucket because the API runs three replicas.
basis: test
evidence:
  - kind: test
    test: "kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1"
    result: fail
    log: .diarchy/logs/replicas.txt
tasks:
  - Token-bucket middleware in src/middleware/rateLimit.ts
  - RATE_LIMIT_PER_MIN config, default 100
  - Tests for 429 and config override; full suite green
ts: 2026-10-25T14:07:30Z
---
Printed 3. In-process buckets would triple the effective limit.
```

`chat/20261025T140800Z-0003-claude-ASSIGN.md`
```yaml
---
protocol_version: 1
id: 20261025T140800Z-0003-claude-ASSIGN
goal: 20261025-rate-limit
from: claude
to: codex
type: ASSIGN
re: [AC1]
task: T1
kind: implement
worktree: .diarchy/worktrees/codex
branch: diarchy/20261025-rate-limit/codex
reason: availability
phase: EXECUTE
ts: 2026-10-25T14:08:00Z
---
```

`chat/20261025T151200Z-0003-codex-STATUS.md`
```yaml
---
protocol_version: 1
id: 20261025T151200Z-0003-codex-STATUS
goal: 20261025-rate-limit
from: codex
to: all
type: STATUS
re: [AC1]
task: T1
task_status: done
phase: EXECUTE
evidence:
  - kind: commit
    sha: 9f3c2ab
  - kind: pr
    url: https://github.com/acme/api/pull/412
  - kind: test
    test: npm test -- rateLimit
    result: pass
ts: 2026-10-25T15:12:00Z
---
PR 412 ready for review.
```

`chat/20261025T143500Z-0002-codex-BLOCKED.md`
```yaml
---
protocol_version: 1
id: 20261025T143500Z-0002-codex-BLOCKED
goal: 20261025-rate-limit
from: codex
to: all
type: BLOCKED
re: [AC1]
kind: external
phase: EXECUTE
ts: 2026-10-25T14:35:00Z
---
Integration test needs staging REDIS_URL. Not in .env.example or the vault; I will not guess a credential.
```

`chat/20261025T143501Z-0001-system-ASK_HUMAN.md`
```yaml
---
protocol_version: 1
id: 20261025T143501Z-0001-system-ASK_HUMAN
goal: 20261025-rate-limit
from: system
to: human
type: ASK_HUMAN
re: [AC1]
reply_to: 20261025T143500Z-0002-codex-BLOCKED
phase: BLOCKED
ts: 2026-10-25T14:35:01Z
---
codex is BLOCKED (external): Integration test needs staging REDIS_URL. Not in .env.example or the vault; I will not guess a credential. The human has been paged; goal.md says how to answer.
```

`chat/20261025T163000Z-0009-claude-DONE.md`
```yaml
---
protocol_version: 1
id: 20261025T163000Z-0009-claude-DONE
goal: 20261025-rate-limit
from: claude
to: all
type: DONE
re: [AC1, AC2, AC3]
phase: EXECUTE
evidence:
  - kind: commit
    sha: 1c0ffee42
  - kind: test
    test: npm test
    result: pass
ts: 2026-10-25T16:30:00Z
---
PRs 412 and 413 merged to main.
```

## 4. Message types

| Type | Sender | Required beyond common fields | Allowed phases | State effect | Expected reply |
|---|---|---|---|---|---|
| KICKOFF | `human` via launcher, or a PM via `kickoff` | body (goal text); `re` = all ACs | none → PLAN | creates goal dir, goal.md, budget.json, inboxes; opens decision `plan` | lead: PROPOSE `plan` |
| PROPOSE | any PM; `decision_id: plan` lead only | `claim`, `decision_id` | PLAN | opens thread (round 1) | challenger: CHALLENGE, or lead: DECIDE |
| CHALLENGE | challenger only | `claim`, `decision_id` (not superseded), `reply_to`, `evidence` with a `test` item | PLAN; EXECUTE and decided threads only with new evidence; not while another decision's deadlock watch is set | round 2; starts deadlock watch | lead: DECIDE (mandatory) |
| DECIDE | lead; `human` (`basis: human`) in BLOCKED | `claim`, `basis`, `decision_id` or `supersedes`; `evidence` when `basis: test` | PLAN; EXECUTE only replying to an open CHALLENGE or with `supersedes` plus new evidence; BLOCKED human only | closes thread, appends decisions.md, clears deadlock watch; `plan` → EXECUTE and writes `tasks`/`ac_add`; human DECIDE restores `blocked_from`, applies `budgets` | none |
| ASSIGN | lead | `to` = agent id; `task` or `new_task`; `kind`; `worktree` + `branch` (implement) or `pr` (review) | EXECUTE | task assignee, branch, status `assigned`; review assignee busy until review evidence for that PR lands | assignee: STATUS |
| STATUS | any PM | `evidence` non-empty | PLAN, EXECUTE | with new work evidence (3.1) resets `talk_since_work`; updates PR registry, task status, and (in EXECUTE) AC status, where beside a `request_changes` review only `fail` items count (2.3) | none |
| DONE | lead | `evidence` non-empty; 9.2 holds | EXECUTE | EXECUTE → DONE; its evidence changes no AC, PR, or task; launcher stops both CLIs | none |
| BLOCKED | any PM; `human` via `diarchy stop` (`kind: external`) | `kind`, body | PLAN, EXECUTE; `human` also BLOCKED | `external`: → BLOCKED, system posts ASK_HUMAN quoting the body (its first 100 words, ending `...` when cut); `internal`: none; `human`: → BLOCKED with no ASK_HUMAN (section 6) | lead: ASSIGN or DECIDE; after `human`: human DECIDE via `diarchy reply` |
| ASK_HUMAN | `system` only | body; `reply_to` unless budget-triggered | written at every transition into BLOCKED except `diarchy stop` | launcher notifies human, exits non-zero | human: DECIDE via `diarchy reply` |

The store writes the ASK_HUMAN body from one template per trigger; none carries the reply command (section 10):

- BLOCKED `kind: external`: `<agent> is BLOCKED (external): <summary> The human has been paged; goal.md says how to answer.` where `<summary>` is the BLOCKED body's first 100 words, closed with a period, or ending with `...` when it was cut
- deadlock: `Lead did not DECIDE <decision_id> within 2 messages or 10 minutes. Goal BLOCKED; human paged.`
- `messages_total`: `Goal used <used> of <limit> messages and is BLOCKED. The human has been paged; goal.md says how to answer.`
- `wall_clock_minutes`: `Wall clock <limit> min exceeded; goal is BLOCKED. The human has been paged; goal.md says how to answer.`
- `spend_usd`: `Spend <used> of <limit> USD reached; goal is BLOCKED. The human has been paged; goal.md says how to answer.`

## 5. Roles

| Role | Definition | May post |
|---|---|---|
| lead | `lead` in kickoff.md: the agent that received the goal from the human (launcher alternates from the previous goal's lead, `--lead` overrides; a goal typed into a CLI makes that CLI's agent lead) | PROPOSE, DECIDE, ASSIGN, STATUS, DONE, BLOCKED |
| challenger | every other PM | PROPOSE (not `plan`), CHALLENGE, STATUS, BLOCKED |

Roles are per goal and swap on the next goal unless the human says otherwise. No rule routes work by model identity or frontend/backend ownership; ASSIGN `reason` is limited to availability-style values. An agent holding a review assignment MUST NOT be assigned implementation until it posts `review` evidence on that PR, which closes the review task; a re-review ASSIGNed after an earlier review is held until the next one (BUSY_REVIEWING). A review task closes only when its assignee's `review` evidence on that PR lands; a STATUS with `task_status: done` on it leaves it as it was. The lead MAY assign itself.

## 6. Phases

| From | Event | To |
|---|---|---|
| (none) | KICKOFF accepted | PLAN |
| PLAN | lead DECIDE `decision_id: plan` accepted (rejected while another thread is open, and before PROPOSE `plan` unless PLAN_BUDGET is spent) | EXECUTE |
| EXECUTE | DONE accepted | DONE (terminal) |
| PLAN, EXECUTE | BLOCKED `kind: external`; deadlock; `messages_total` reached; `wall_clock_minutes` reached | BLOCKED (`blocked_from` recorded; system ASK_HUMAN) |
| PLAN, EXECUTE, BLOCKED | human BLOCKED (`diarchy stop`) | BLOCKED (`blocked_from` recorded, or kept when already BLOCKED; no ASK_HUMAN) |
| BLOCKED | human DECIDE accepted | `blocked_from` |

`diarchy stop` is the one message the store writes without the role and phase gates: it is checked for shape, counts toward no PM budget, and pages nobody, since the human is the one stopping. It is the block's trigger in goal.md and chat.md when it is later than the latest ASK_HUMAN (RENDERING.md 2.1 and 4.1), and `diarchy reply` resumes from it like from any block.

Allowed PM types per phase. PLAN: PROPOSE, CHALLENGE, DECIDE, STATUS, BLOCKED. EXECUTE: STATUS, ASSIGN, BLOCKED, DONE; CHALLENGE with new evidence; DECIDE replying to an open CHALLENGE or carrying `supersedes` with new evidence. BLOCKED and DONE: none (`read` and `wait_for_reply` keep working). In PLAN and EXECUTE, while `deadlock_watch` is set, a CHALLENGE on any other decision is rejected (PHASE_GATE): the watch tracks one CHALLENGE, so the lead DECIDEs that one first.

Deadlock: when a CHALLENGE is accepted, `deadlock_watch` is set with `remaining: 2`, `deadline: ts + 10 min`. Each accepted message that is not the lead's DECIDE on that `decision_id` decrements `remaining`. When `remaining` reaches 0 or `deadline` passes (checked on every accepted message and every `wait_for_reply` tick) the store sets BLOCKED and posts a system ASK_HUMAN with `reply_to` the CHALLENGE and its `decision_id`.

## 7. Disagreement resolution

A thread (`decision_id`) is `open` from PROPOSE until DECIDE, then `decided`, then `superseded` if a later DECIDE names it in `supersedes`. A superseded thread is closed for good: a CHALLENGE on it is rejected (SCHEMA) and names the decision that superseded it, which is the one to challenge. The only legal sequences on an open thread:

1. PROPOSE → DECIDE
2. PROPOSE → CHALLENGE → DECIDE

Anything else on an open thread is rejected (TWO_ROUNDS), a DECIDE before any PROPOSE included; only the human's DECIDE, and the lead's once PLAN_BUDGET is spent (section 8), may skip the PROPOSE. One CHALLENGE per `decision_id`, ever (ONE_CHALLENGE). A CHALLENGE MUST carry a `test` item naming the cheapest check that settles it. A `pending` test is not new evidence (3.1), so on its own it satisfies a CHALLENGE only in PLAN on an open thread; anywhere else the CHALLENGE also carries a new evidence item (NEW_EVIDENCE).

The lead's DECIDE does exactly one of: adopt (`basis: adopted-challenge`; claim restates the challenger's position); reject on evidence (`basis: test`; `evidence` includes a `test` item with `result` pass or fail); rule by authority (`basis: authority`; only when the test cannot be run, body says why).

In EXECUTE every thread is already decided, so an EXECUTE DECIDE is always a superseding one. Reopening a decided thread: a CHALLENGE on it needs new evidence; the lead replies with a DECIDE carrying `supersedes: <old id>` and no `decision_id` (store assigns the next `D<n>`). It MAY restate the old claim (challenge rejected) or change it. DECISION_IMMUTABLE requires new evidence in the DECIDE's own `evidence` or in the CHALLENGE it `reply_to`s. A human DECIDE never requires evidence.

## 8. Budgets and configuration

| Config key (`budgets.*`) | Default | Counter | Enforcement |
|---|---|---|---|
| plan_messages | 12 | PM messages accepted in PLAN, excluding KICKOFF | at limit only lead DECIDE (any id) and BLOCKED are accepted (PLAN_BUDGET) |
| messages_total | 80 | PM messages accepted, all phases | `used >= limit` after an acceptance in PLAN/EXECUTE: → BLOCKED, system ASK_HUMAN (TOTAL_BUDGET) |
| challenges_per_decision | 1 | per `decision_id` | ONE_CHALLENGE |
| rounds_per_decision | 2 | per open thread | TWO_ROUNDS |
| talk_work_ratio | 3 | `talk_since_work`: EXECUTE messages since the last STATUS with new work evidence (3.1), which resets it; BLOCKED, DONE, every STATUS, and a DECIDE replying to an open CHALLENGE neither count nor are gated | `talk_since_work >= limit`: reject all but STATUS, BLOCKED, DONE, exempt DECIDE (TALK_WORK_RATIO) |
| wall_clock_minutes | 240 | minutes since `kickoff.created`, checked every tick | at limit in PLAN/EXECUTE: → BLOCKED, system ASK_HUMAN (WALL_CLOCK) |
| spend_usd | null | `used.spend_usd`; reserved: nothing writes it in diarchy 0.1 (the launcher does not meter cost), so it stays 0 | none in 0.1: a limit set here never trips; once metered, at limit same as WALL_CLOCK |

The `allowed_types` a tool returns (section 10) apply these gates: at the `talk_work_ratio` limit they list DECIDE to the lead only while some decision has an open CHALLENGE.

`diarchy.config.json` (project root):

```json
{
  "protocol_version": 1,
  "vault": "<project> brain/diarchy",
  "agents": {
    "claude": { "command": "claude",
                "args": ["-p", "--permission-mode", "acceptEdits", "--permission-prompts", "none",
                         "--allowedTools", "mcp__plugin_diarchy_diarchy__*,Bash(git *),Bash(npm *),Bash(node *),Bash(gh *)"] },
    "codex": { "command": "codex", "args": ["exec", "--sandbox", "workspace-write", "--dangerously-bypass-hook-trust"] }
  },
  "budgets": { "plan_messages": 12, "messages_total": 80, "challenges_per_decision": 1,
               "rounds_per_decision": 2, "talk_work_ratio": 3, "wall_clock_minutes": 240, "spend_usd": null },
  "worktrees": { "root": ".diarchy/worktrees", "branch_prefix": "diarchy" },
  "review": { "required": true },
  "launcher": { "poll_ms": 1000, "max_restarts": 3, "restart_backoff_ms": 5000,
                "stop_grace_ms": 10000, "wall_clock_grace_ms": 300000 }
}
```

This is the file `diarchy init` writes, with `<project>` standing for the project directory's name.

`worktrees.branch_prefix` follows the section 3 `branch` rules, 133 characters max, and `worktrees.root` is one line of 183 characters max, so the default ASSIGN `branch` (`<branch_prefix>/<goal-id>/<agent>`) and `worktree` (`<worktrees.root>/<agent>`) the `assign` tool fills in always pass section 3, and git accepts the branch. Loading a config that breaks either fails with an error naming the file and the key, and `diarchy start` loads the config before kickoff, so a bad key starts no goal.

`vault` is relative to the project root. `kickoff.budgets` overrides config per goal; a human DECIDE `budgets` overrides for the rest of the goal (without it, an exhausted budget re-blocks on the next accepted message). `review.required: false` waives 9.2(c) and (f) only; NO_SELF_REVIEW still applies.

`agents.<id>.command` and `args` are the executable and the flags the launcher puts before the prompt (with `args` absent, a `command` with spaces is split on whitespace). Headless `claude -p` has nobody to answer a permission prompt, so the Claude PM runs with `--permission-prompts none` and an allow list: `mcp__plugin_diarchy_diarchy__*`, the diarchy tools under the server name a plugin install gives them (a server registered with `claude mcp add diarchy` is `mcp__diarchy__*` instead), plus `Bash(git *)`, `Bash(npm *)`, `Bash(node *)`, and `Bash(gh *)`. The list is one comma-joined argument. A project whose checks run through another command adds it (`Bash(make *)`) before the first run; a tool outside the list is denied and the PM stalls at that step. The Codex PM runs `codex exec` in the `workspace-write` sandbox with `--dangerously-bypass-hook-trust`: `codex exec` never shows the `/hooks` review prompt and skips untrusted hooks silently, so the flag is what runs the inbox brief, the Stop gate, and the guard headless (INSTALL-CODEX.md section 5, Hook trust); without it they run only once trusted in `/hooks`.

`launcher` tunes the `diarchy start` supervisor; a missing key takes the default shown above.

- `poll_ms`: how often the supervisor re-reads `budget.json`, in ms, at most 1000.
- `max_restarts`: restarts per agent between two messages. Past it the agent stays dead until the next message lands, which respawns it with a fresh count.
- `restart_backoff_ms`: the wait before each restart.
- `stop_grace_ms`: after DONE or a block other than WALL_CLOCK, how long the PMs get to exit on their own before SIGTERM, and again before SIGKILL.
- `wall_clock_grace_ms`: after a WALL_CLOCK block, how long the CLIs may run on before SIGKILL.

## 9. Code flow

### 9.1 Worktrees, branches, PRs

Each PM works only in `<worktrees.root>/<agent>` on `<branch_prefix>/<goal-id>/<agent>`; ASSIGN carries both and the launcher creates the worktrees at kickoff. Work ships as a PR: the implementer posts STATUS with `pr` evidence; the lead ASSIGNs `kind: review` (with `pr`) to the other agent; the reviewer posts STATUS with `review` evidence, the only thing that counts as review. A `verdict: approve` from a non-author unlocks merge; the author merges and posts STATUS with the merge `commit`.

### 9.2 DONE preconditions (DONE_PRECONDITION)

(a) phase EXECUTE, sender lead; (b) every AC's status in goal.md is `passing`, which only a STATUS accepted in EXECUTE sets (2.3): the DONE's own `test` items do not count; (c) every url in `budget.json.prs` has a `review` with `verdict: approve` from an agent other than its author, and every `pr` url the DONE cites is one of them (waived by `review.required: false`); (d) no thread is open, no decision has an unanswered CHALLENGE (a human DECIDE that names no decision clears the watch but answers none), and `deadlock_watch` is null; (e) every task in goal.md has status `done`; (f) at least one PR is registered, and every task other than a review was done by an assignee who introduced a PR with `pr` evidence (waived by `review.required: false`).

The store checks recorded state only, so a DONE cannot certify itself: (b) needs a STATUS per AC, (e) a STATUS per task, and (c) with (f) a PR plus the other agent's review.

## 10. MCP tools

All tools act on the vault's current goal (the active one, else the newest); no tool takes a goal id. One server posts as the one agent it was started for, so no tool takes `from` or `lead`: the caller of `kickoff` is the lead. The server drops input fields a tool does not declare and checks the declared ones itself before the store sees them: a declared field of the wrong shape is a SCHEMA rejection like any other (below). A call whose `arguments` is not a JSON object (`null`, a string, an array, a number, or a boolean) never reaches a tool: the MCP SDK rejects it with JSON-RPC error -32603 before any tool runs. An omitted `arguments` is treated as `{}`.

A posting tool (`kickoff`, `post`, `decide`, `assign`, `status`) answers `{ ok: true, id, ts, seq, phase, allowed_types, budgets: { used, limits }, decision_id? }`; `kickoff` adds `goal_id, lead, challenger, kickoff_id`. `read` answers `{ goal, goal_text, acs, phase, role, allowed_types, budgets: { used, limits }, lead, challenger, messages, cursor }`, with no `ok`. Every store or server rejection answers `{ ok: false, rule: "<RULE_ID>", message: "<what to do instead>" }` with `isError` set; `rule` is a rule id from ANTI-SLOP.md or one of these server codes, which are not protocol rules:

| Code | When | Message |
|---|---|---|
| NO_GOAL | any tool but `kickoff` before the first goal in this vault is kicked off | No goal in this vault. Call kickoff first. |
| WRONG_TOOL | `post` with type KICKOFF, DECIDE, or ASSIGN | {type} goes through the {tool} tool, not post. Call {tool} with the same fields. |
| AGENT_BUSY | any tool but `kickoff` while another live server acts as the same agent on the goal (below) | Another diarchy server already acts as {agent} on this goal (pid {pid}). One session per agent: end that session, or stop here; once it exits, the next call as {agent} takes over. |
| INTERNAL | an unexpected exception, also logged to stderr | {error} |

A stored vault file that will not parse (kickoff.md, a `chat/` message file) surfaces as a rejection too, not as INTERNAL: rule SCHEMA, or TYPED_ONLY for a message file whose `type` is unknown, with a message that names the file as corrupt instead of the rule's usual text. The PM then posts BLOCKED `kind: external`, which goes through even when kickoff.md is corrupt. `diarchy stop` and `diarchy reply` still work from budget.json, and the rendered views leave out a message file that will not parse, so the human can always fix the file or retire the goal. A `budget.json` that will not parse surfaces the same way (SCHEMA naming the file, 2.3), but nothing can post to that goal, so the message tells the PM to stop and tell the human, who repairs the file or moves the goal directory out of the vault.

| Tool | Input (field: type) | Output | Typical errors |
|---|---|---|---|
| kickoff | goal: string (120 words max, one line: no CR, LF, VT, FF, U+0085, U+2028, U+2029); acceptance_criteria: string[] (1+, 40 words each, one line each); budgets?: object; slug?: `[a-z0-9-]{1,40}`, default derived from the goal text | posting result plus goal_id, lead, challenger, kickoff_id | SINGLE_KICKOFF, SCHEMA, WORD_CAP |
| post | type: message type; to?: agent id or all (default all); re?: string[]; body?; claim?; evidence?: item[]; reply_to?; decision_id?; kind? | posting result | WRONG_TOOL, any rule |
| read | since?: id (default: inbox cursor) | read result: goal_text (the KICKOFF body); acs: { AC<n>: { criterion, status } } for every AC; messages [{frontmatter..., body}] excluding the caller's own; cursor | NO_GOAL |
| wait_for_reply | timeout_ms?: int (default and hard cap 110000) | read result, or `{ timeout: true }` (also when cancelled or overtaken by a later call); MCP progress notification every 15 s; runs the store tick | NO_GOAL |
| decide | claim; basis; re?; decision_id?; supersedes?; evidence?; reply_to?; tasks?; ac_add?; body? | posting result (type DECIDE) | ROLE_GATE, DECISION_IMMUTABLE, PHASE_GATE |
| assign | to; kind; task? (exactly one of task and new_task); new_task?; worktree?; branch?; pr?; re?; reason?; body? | posting result (type ASSIGN); worktree/branch default from config | ROLE_GATE, NO_DOMAIN_ROUTING, BUSY_REVIEWING, NO_SELF_REVIEW |
| status | re?; evidence; task?; task_status?; body? | posting result (type STATUS) | NO_ACK, NO_SELF_REVIEW, CITE_AC |

`re` is optional in every input schema only so that an empty one reaches the store and is rejected with CITE_AC and its guidance.

`read` and `wait_for_reply` advance `inbox/<agent>.json.cursor` to the last delivered id, `wait_for_reply` only when it hands messages to a live call: a wait cancelled through MCP `notifications/cancelled`, or still running when the same agent's next tool call arrives (a client-side tool timeout that sends no cancel), returns `{ timeout: true }` and leaves the cursor alone, so the reply reaches that agent's next `read` or `wait_for_reply` instead of a call nobody is reading. `to` is addressing, not access control. The launcher uses the store library as `human`: `diarchy reply "<text>" [--decision <id>] [--budget key=value]` posts a DECIDE with `basis: human` (without `--decision` the store assigns the next `D<n>`); `diarchy stop` kills both CLIs and leaves the goal BLOCKED with a human BLOCKED (section 6). `human` is the identity a store is configured with, not a credential: any process that can run the CLI against the project posts as the human. Two things narrow that. A system ASK_HUMAN body names the trigger and says the human has been paged; it never carries the reply command, which a run shows only in the goal.md callout (RENDERING.md 4.1), `diarchy status`, and the launcher's output. The plugins' PreToolUse hook denies a PM's shell call to `diarchy reply` or `diarchy stop`. What remains is a documented limit (ANTI-SLOP.md, What this does NOT prevent).

One live server per agent and goal. The inbox cursor has one reader, so the first server to call a tool on a goal holds `inbox/<agent>.lock/` until it exits (2.2); a successful `kickoff` claims the new goal for its caller. Another live server started for the same agent, for example a second Claude Code session in the project, answers every tool except `kickoff` with `{ ok: false, rule: "AGENT_BUSY", message: "Another diarchy server already acts as <agent> on this goal (pid <pid>). One session per agent: end that session, or stop here; once it exits, the next call as <agent> takes over." }`, a server code like NO_GOAL, and takes over once the holder exits or goes stale. `diarchy start` does not spawn a PM while another live session holds that agent's lease: it logs the holder's pid once, waits without using up a restart, and spawns the PM once the lease is free or stale. The plugins' Stop hook does not keep a second session's turn open while another session's server holds the lease; it counts its blocks per session, so that session cannot use up the holder's. When the hook cannot tell whether the holder is its own session's server (the holder's parent is pid 1, as when the CLI itself runs as pid 1 in a container; a parent pid cannot be read; or the holder runs in another pid namespace on the same machine), it keeps the turn open as it would with no lease. Run one session per agent while a goal is active.

The server, not the MCP SDK, checks every call's arguments against the input schema that `tools/list` advertises, before the store sees them. A missing required field, a wrong type or enum value, a malformed evidence item, or a `timeout_ms` that is not a positive integer is rejected the same way as a rule: `{ ok: false, rule: "SCHEMA", message }` naming the field, or TYPED_ONLY for a `post` whose `type` is not a message type. No tool answers a bad field in an object `arguments` with an MCP protocol error.

## 11. Extensibility

Agent ids are strings `[a-z][a-z0-9-]{1,15}` declared in `config.agents`. protocol_version 1 runs exactly two agents, one lead and one challenger: loading a `diarchy.config.json` that declares more than two fails, `diarchy init --agents` accepts exactly two ids, and `kickoff` fails with fewer than two. Every per-agent artefact is already keyed by id (filename segment, `seq`, inbox file, worktree, branch), so a third agent (`cursor`, `grok`) needs no new file layout. Adding one is reserved for a later protocol_version, with a list-valued `challenger` in kickoff.md, `challenges_per_decision` counted per challenger, cross-review requiring reviewer not equal to author, and deadlock on any unanswered CHALLENGE.

## 12. Versioning

Every frontmatter, `kickoff.md`, `budget.json`, inbox file, and `diarchy.config.json` carries `protocol_version: 1`. The validator rejects any other value (SCHEMA); an inbox file with another value reads as no cursor instead (2.3). Breaking changes increment the version; stores never migrate goal directories in place.

A field rule tightened within a version applies to new posts only, so a goal started under diarchy 0.1.0 stays readable after an upgrade. The store reads a stored `chat/` file with the field rules 0.1.0 wrote it under: `tasks` items, `new_task`, `worktree`, `branch`, `path`, and `log` are any non-empty string, and `test`, `note`, and each `ac_add` item hold at least one character within their word cap. kickoff.md reads as 2.3 says.
