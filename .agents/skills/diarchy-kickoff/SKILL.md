---
name: diarchy-kickoff
description: Start a diarchy goal when the human says something like "let's work on X", "today's goal is Y", or "kick off". Turns the request into a goal with acceptance criteria, calls the kickoff tool, and hands over to diarchy-pm.
---

# diarchy kickoff

Trigger: the human states a goal in this CLI and the `diarchy` MCP tools are available.

1. Call `read`. If it returns an active goal (phase PLAN, EXECUTE, or BLOCKED), do not kick off. Take the `role` that `read` returns (lead or challenger), act on the unread messages, and continue per `diarchy-pm`. A second `kickoff` is rejected with SINGLE_KICKOFF anyway.
2. Extract the goal text: one paragraph, 120 words max, in the human's words where possible. Drop pleasantries; keep constraints (deadline, stack, files, "do not touch X").
3. Extract acceptance criteria. Use the human's criteria when given. Otherwise propose 3 to 6 measurable ACs, each 40 words max, each checkable by a command or a file state: a test passes, an endpoint returns 429, a doc section exists. Prefer "npm test passes with new tests for X" over "X works". Ask the human once, only when nothing measurable can be inferred from the request and the repo. When you can infer, state the ACs in your reply and proceed without asking.
4. Call `kickoff` with `goal` and `acceptance_criteria`. Omit `lead`: the CLI that received the goal is lead. Pass `goal_id` only when the human named one. Pass `budgets` only when the human asked for a longer or shorter run (see the Tuning table in ANTI-SLOP.md).
5. On `{ ok: false }`: SINGLE_KICKOFF means step 1 applies; SCHEMA or WORD_CAP means shorten the offending field and repost once.
6. Tell the human in one line: goal id, lead, AC count. Then follow `diarchy-pm` as lead, starting with PROPOSE `plan`.
