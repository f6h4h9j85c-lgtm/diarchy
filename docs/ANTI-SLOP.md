# diarchy ANTI-SLOP rules (protocol_version: 1)

## Why these are enforced in code

Two language models talking to each other do not converge on truth by default. When peers debate, a correct answer is measurably more likely to flip to a wrong one than the reverse (arXiv 2509.05396): social pressure, not evidence, moves the position. The MAST taxonomy of multi-agent failures (arXiv 2503.13657) finds that most failures are specification problems and inter-agent misalignment, such as ignoring the task, losing context, or acknowledging without acting, rather than limits of the underlying models. Anthropic's multi-agent research system became reliable only after replacing free-form coordination with explicit effort tiers and structured task briefs. Prompt instructions like "be concise" or "push back" degrade under load and cannot be tested. The rules below are therefore checked by `diarchy-mcp` on every message. A message that fails is never written to the vault; the caller receives `{ ok: false, rule, message }` naming the next legal action. Rule IDs are stable and are referenced by error payloads, tests, and PROTOCOL.md.

## Evaluation order

Checks run in this order; the first failure is returned.

| Layer | Rules, in order |
|---|---|
| server | WRITER_OWNED |
| validator (stateless) | SCHEMA, TYPED_ONLY, HUMAN_LAST_RESORT, ONE_CLAIM, WORD_CAP, CHALLENGE_NEEDS_TEST, NO_DOMAIN_ROUTING, NO_ACK |
| store (needs goal state) | SINGLE_KICKOFF, TOTAL_BUDGET, WALL_CLOCK, PHASE_GATE, ROLE_GATE, PLAN_BUDGET, TALK_WORK_RATIO, CITE_AC, NEW_EVIDENCE, ONE_CHALLENGE, TWO_ROUNDS, DECISION_IMMUTABLE, NO_SELF_REVIEW, BUSY_REVIEWING, DONE_PRECONDITION |
| store trigger (not a rejection) | DEADLOCK |

The MCP server also answers `{ ok: false, rule, message }` with three codes that are not protocol rules: NO_GOAL (nothing kicked off yet), WRONG_TOOL (`post` used for a type that has its own tool), and INTERNAL (an unexpected exception). PROTOCOL.md section 10 lists their messages.

## Rules

Placeholders in braces are filled by the store at rejection time.

| Rule ID | Rule | Enforcement | Error message | Fixture |
|---|---|---|---|---|
| TYPED_ONLY | `type` is one of KICKOFF, PROPOSE, CHALLENGE, DECIDE, ASSIGN, STATUS, DONE, BLOCKED, ASK_HUMAN. | validator | Unknown type "{type}". Use one of KICKOFF, PROPOSE, CHALLENGE, DECIDE, ASSIGN, STATUS, DONE, BLOCKED, ASK_HUMAN. | `slop/typed_only-unknown.yaml` |
| SCHEMA | Frontmatter parses; `protocol_version` is 1; every field required for the type (PROTOCOL.md section 3) is present with the right shape and enum value; `to` is an agent id, `all`, or `human`; `reply_to` exists; ASSIGN has exactly one of `task`/`new_task`. | validator (shape); store (`reply_to` existence) | Field "{field}": {problem}. Fix it per PROTOCOL.md section 3 and post again. | `slop/schema-missing-basis.yaml`, `slop/schema-reply-to-missing.yaml` |
| CITE_AC | `re` is non-empty and every id exists in goal.md. | store | Set `re` to acceptance criteria that exist in goal.md ({known}). Unknown: {unknown}. | `slop/cite_ac-missing-re.yaml`, `slop/cite_ac-unknown-id.yaml` |
| ONE_CLAIM | PROPOSE, CHALLENGE, DECIDE carry exactly one `claim`: 1 to 40 whitespace-split words, last character `.` `!` or `?`, no other `.` `!` `?` followed by whitespace. | validator | Put exactly one falsifiable sentence in `claim` (40 words max, one terminal punctuation mark). Move everything else to the body. | `slop/one_claim-41-words.yaml`, `slop/one_claim-two-sentences.yaml` |
| WORD_CAP | Body has at most 120 whitespace-split tokens; the kickoff goal text has the same cap. | validator | Body is {n} words; cut to 120 or fewer. Put detail in a file and cite it as `file` evidence. | `slop/word_cap-121-words.yaml` |
| NO_ACK | Reject a message that adds nothing: (a) empty body on KICKOFF, BLOCKED, ASK_HUMAN; (b) a body of 8 words or fewer (a body identical to the claim counts as empty) that, lowercased and matched on whole words, contains any of: agreed, sounds good, great point, makes sense, +1, thanks, thank you, i agree, good idea, noted, will do, ack, ok, okay, lgtm; (c) STATUS with empty `evidence`. | validator | This message adds nothing. Post STATUS with evidence, a CHALLENGE with a test, or post nothing. | `slop/no_ack-sounds-good.yaml`, `slop/no_ack-status-without-evidence.yaml` |
| CHALLENGE_NEEDS_TEST | A CHALLENGE includes at least one evidence item `kind: test` with a non-empty `test` field. | validator | Add an evidence item `kind: test` whose `test` names the cheapest check that would settle this claim. | `slop/challenge_needs_test-no-test.yaml` |
| ONE_CHALLENGE | At most one CHALLENGE per `decision_id`, counting superseded ancestors. | store | Decision {id} was already challenged once. Wait for the lead's DECIDE; reopening needs new evidence. | `slop/one_challenge-second-challenge.yaml` |
| TWO_ROUNDS | On an open thread only PROPOSE, then optionally one CHALLENGE, then DECIDE is legal; a second PROPOSE or any third message before the DECIDE is rejected. | store | Decision {id} already has a PROPOSE and a CHALLENGE. Only the lead's DECIDE may follow. | `slop/two_rounds-third-message.yaml` |
| DECISION_IMMUTABLE | A DECIDE on a decided thread carries `supersedes` and new evidence (its own, or in the CHALLENGE it replies to). | store | Decision {id} is decided. To supersede it, cite new evidence: a `test` with result fail, a `human` message, or an `external` URL. | `slop/decision_immutable-supersede-without-new-evidence.yaml` |
| PHASE_GATE | Type is allowed in the current phase (PROTOCOL.md section 6): nothing before kickoff or in BLOCKED/DONE; no `plan` DECIDE while another thread is open. | store | {type} is not allowed in phase {phase}. Allowed now: {allowed_types}. | `slop/phase_gate-propose-in-execute.yaml` |
| ROLE_GATE | Sender's role may post this type: DECIDE, ASSIGN, DONE and PROPOSE `plan` lead only; CHALLENGE challenger only; DECIDE in BLOCKED human only. | store | {type} may only be posted by the {role} ({agent}). You are the {your_role}. | `slop/role_gate-challenger-decide.yaml` |
| NEW_EVIDENCE | A CHALLENGE in EXECUTE, or on a decided thread, carries new evidence as defined in PROTOCOL.md section 3.1. | store | This CHALLENGE needs new evidence: a `test` with result fail, a `human` message, or an `external` URL not cited before on decision {id}. | `slop/new_evidence-pending-test.yaml` |
| PLAN_BUDGET | After `plan_messages` PM messages in PLAN, only lead DECIDE and BLOCKED are accepted. | store | PLAN budget ({limit} messages) is spent. Lead: post DECIDE with decision_id plan now. Challenger: wait. | `slop/plan_budget-13th-message.yaml` |
| TALK_WORK_RATIO | In EXECUTE, after `talk_work_ratio` messages without a STATUS, only STATUS, BLOCKED, DONE, and a DECIDE answering an open CHALLENGE are accepted. | store | {n} messages since the last STATUS with evidence. Post STATUS with evidence, BLOCKED, or DONE before anything else. | `slop/talk_work_ratio-fourth-message.yaml` |
| TOTAL_BUDGET | When `messages_total` is reached the store sets BLOCKED and posts a system ASK_HUMAN; later posts are rejected. | store | Goal used {used} of {limit} messages and is BLOCKED. The human has been paged; stop posting and wait. | `slop/total_budget-80th-message-blocks.yaml` |
| WALL_CLOCK | When `wall_clock_minutes` (or `spend_usd`, if set) is reached the store sets BLOCKED and posts a system ASK_HUMAN; later posts are rejected. The launcher kills both CLIs 5 minutes after. | store; launcher | Wall clock {limit} min exceeded; goal is BLOCKED. The human has been paged; stop posting and wait. | `slop/wall_clock-240-minutes.yaml` |
| NO_SELF_REVIEW | A `review` item's `url` must have been introduced (first `pr` evidence) by a different agent; ASSIGN `kind: review` must not target the author. | store | You authored {url}. Review evidence must come from the other agent; ask the lead to ASSIGN a review. | `slop/no_self_review-own-pr.yaml` |
| NO_DOMAIN_ROUTING | ASSIGN `reason`, if present, is one of `availability`, `continuity`, `load-balance`. No other rationale field exists. | validator | `reason` must be availability, continuity, or load-balance. Do not route work by model or by frontend/backend ownership. | `slop/no_domain_routing-backend.yaml` |
| BUSY_REVIEWING | ASSIGN `kind: implement` may not target an agent holding a review assignment whose PR has no `review` evidence from that agent yet. | store | {agent} is reviewing {url}. Assign implementation to another agent or wait for the review evidence. | `slop/busy_reviewing-implement-while-reviewing.yaml` |
| SINGLE_KICKOFF | `kickoff` is rejected when kickoff.md exists for the goal or any goal in the vault is active. | store | Goal {id} is already active (phase {phase}). Call read instead of kickoff. | `slop/single_kickoff-second.yaml` |
| WRITER_OWNED | `from` equals the server's configured agent id, and the store writes message files only with that id in the filename (system files excepted). | server; store | This server posts as "{agent}". Set from: {agent} or omit it. | `slop/writer_owned-spoof.yaml` |
| HUMAN_LAST_RESORT | Only `system` posts ASK_HUMAN. | validator | Agents do not post ASK_HUMAN. Post BLOCKED with kind: external and the store pages the human. | `slop/human_last_resort-agent-ask-human.yaml` |
| DONE_PRECONDITION | DONE satisfies PROTOCOL.md section 9.2 (a) to (d). | store | Not done: {missing}. Post STATUS with passing tests for each AC and get the other agent's approve review on each PR. | `slop/done_precondition-ac-without-test.yaml` |
| DEADLOCK | After a CHALLENGE, if two further messages are accepted or 10 minutes pass without the lead's DECIDE on it, the store sets BLOCKED and posts a system ASK_HUMAN. | store (trigger) | Lead did not DECIDE {id} within 2 messages or 10 minutes. Goal BLOCKED; human paged. (ASK_HUMAN body) | `valid/deadlock-two-messages.yaml` |

### Fixture convention

Fixtures live in `test/fixtures/protocol/`: `slop/*.yaml` (one or more per rejecting rule, named `<rule_id>-<case>.yaml` in lowercase), `valid/*.yaml` (accepted messages, including near-misses such as `word_cap-120-words-ok.yaml`), `bases/*.yaml` (GoalState snapshots derived by replaying the PROTOCOL.md examples through the engine), and `examples/*.md` (the nine PROTOCOL.md 3.2 messages verbatim). A fixture holds `description`, `state` (a base name plus shallow overrides), optional `caller`, `now`, and `prior` messages, the `message` under test, and `expect` (`ok`, `rule`, `phase_after`, partial `effects` and `state` matchers). `test/protocol.test.ts` runs every fixture and also checks that the rule table above and the evaluation order match the code.

## What this does NOT prevent

- A wrong but well-formed claim. The validator checks shape, not truth. The challenger's test is the only truth check, and it settles nothing until someone runs it.
- Fabricated evidence. A `test` item with `result: pass` is taken on faith in v1; the store does not execute commands. Cross-review and the `log` path make fabrication auditable, not impossible.
- Silent agreement. ONE_CHALLENGE caps challenges; nothing forces one. Two models sharing a bias will agree and pass.
- Authority abuse. A lead may rule `basis: authority` every time. It is visible in decisions.md, not blocked.
- Counter resets with trivial STATUS. Any STATUS with any evidence item resets `talk_since_work`.
- Density gaming. 120 words of compressed jargon still fit the cap.
- Work done outside the protocol. Subagent chatter inside a CLI, PR comments on GitHub, and direct file edits are invisible to the store. Only vault messages are governed.
- Bad acceptance criteria. If the ACs are vague, DONE can be legitimately reached on a goal the human did not want.

## Tuning

Defaults fit a goal of roughly one afternoon with two to four PRs. For larger goals, change `budgets` in `diarchy.config.json`, or per goal in `kickoff.budgets`.

| Budget | Loosen when | Suggested |
|---|---|---|
| plan_messages | goal statement is ambiguous or has 6 or more ACs | 20 |
| messages_total | more than 4 PRs are expected | 160 |
| talk_work_ratio | builds or test suites take over 20 minutes, so STATUS lands slowly | 5 |
| wall_clock_minutes | full-day goals | 480 |
| spend_usd | the launcher can report cost | goal-dependent |

Do not loosen `challenges_per_decision` or `rounds_per_decision`; they are the anti-flip controls, not sizing knobs. If a goal needs more than twice any default, split it into two goals: the roles swap and the second goal starts with a clean budget. For single-PR goals, tighten `plan_messages` to 6 and `messages_total` to 40.
