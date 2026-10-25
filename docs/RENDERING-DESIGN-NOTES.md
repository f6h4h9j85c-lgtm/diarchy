# Design notes: diarchy rendered files

A design review written alongside RENDERING.md on 2026-10-25. RENDERING.md, PROTOCOL.md, and `samples/` are normative; where they and these notes differ, the notes are out of date.

## Intent

The reader is a human on a phone, in Obsidian, who did not watch the run. In the first three seconds they need, in this order: do I have to do something; what phase is it in; who is leading; how much of the budget is gone; what happened last. Everything else is scrolling.

- **One world.** A flight recorder. Terse, chronological, nothing restated, nothing explained twice. Not a chat client, not a dashboard with widgets.
- **Signature artifact.** The strip: one callout under the `chat.md` title, four short paragraphs, one per triage question. Its callout type carries exactly one bit, `NOTE` (no action) or `WARNING` (human needed). That bit is the only colour in the whole system and it means one thing.
- **One palette.** None beyond that bit. Rank is typographic: bold for the one mandated header line per message, italic for the one falsifiable claim, code for data (sha, branch, command, path), plain for prose. The negative outcome of every pair (`fail`, `request_changes`, `failing`) is the bold one, so the eye lands on the problem.
- **One type voice.** The reader's own Obsidian theme. Weight hierarchy is carried by nine monochrome glyphs chosen from code points outside the emoji list: light open shapes for routine traffic (▸ KICKOFF, ○ PROPOSE, ↦ ASSIGN, ◇ STATUS), filled or crossed shapes for the five moments that matter (▲ CHALLENGE, ● DECIDE, ■ DONE, ✕ BLOCKED, ⚑ ASK_HUMAN).
- **Why it is not a template.** Phase transitions are the only H2s in the transcript, so Obsidian's outline pane becomes the run's timeline (`→ PLAN`, `→ EXECUTE`, `→ BLOCKED`, `→ EXECUTE`, `→ DONE`) and the last line of a finished run is always `## → DONE`. The transcript never duplicates itself; the strip's third paragraph is the "latest". Protocol tokens are rendered verbatim so a reader can search the file for the exact word an MCP error used.

## Evidence: the three-second test, line by line

`samples/chat.md`, lines 1 to 11, is the whole first phone screen:

```
# Chat: 20261025-rate-limit
> **DONE** · no action needed · lead claude · challenger codex
> 18 of 80 messages (PLAN 5 of 12) · 150 of 240 min
> 2026-10-25 · last 16:30:00 UTC (12:30 local) · claude DONE: PRs 412 and 413 merged to main.
> [goal](goal.md) · [decisions (4)](decisions.md)
```

Goal (title), human slot, phase, lead, budget, recency, last event, two links. Nothing else above the fold.

`samples/goal-blocked.md`, lines 4 to 10: the first thing after the title is a `WARNING` callout whose first words are `**Human needed** since 14:35:01 UTC (10:35 local)`. The agent's own words are a nested quote, so the reader sees exactly what codex said rather than a paraphrase. The last paragraph tells them the one command to run and what it does.

Scanning for disagreement in `chat.md`: the two ▲ lines (14:04:55 and 15:49:12), the three agent ● lines, and codex's ✕ BLOCKED (14:35:00) are the only heavy glyphs in the PLAN and EXECUTE sections besides the terminal ■, and a thumb-scroll at speed stops on them. The human's ● DECIDE (14:52:10) and the ⚑ ASK_HUMAN sit under `## → BLOCKED`.

Finding what was decided: `samples/decisions.md` has one struck id (`~~D1~~`), and the last row's `supersedes` cell says `D1`, so the chain reads downward without a legend. All four bases (`authority`, `test`, `human`, `adopted-challenge`) appear once, which is why the scenario was extended the way it was.

## Review against the doctrine

Violations found and fixed:

- **Double-backtick example mangled by GFM.** The spec's own escaping example (`` `` a`b `` ``) parsed as two empty code spans when run through pandoc. Rewritten with a triple-backtick delimiter and re-parsed.
- **Miscounted budgets in the spec's strip examples.** The BLOCKED example said 8 messages; a BLOCKED message is a PM message and counts, so it is 9. The EXECUTE example said 93 minutes and 12 messages; it is 109 and 14. Both corrected from the scenario, not by hand.
- **Trailing-sentence navigation line.** The BLOCKED strip's last paragraph read as a sentence that ran into the decisions link. Replaced with a labelled list: `Question and how to answer: [goal] · [decisions (2)]`.
- **Adjacent lists merging.** A `plan` DECIDE has an evidence list followed by a task list; in markdown two bullet lists separated by a blank line are one list. The `Tasks:` lead-in paragraph exists only to keep them apart; confirmed in the parsed HTML (`</ul><p>Tasks:</p><ul>`).

Consciously kept:

- **A callout at all.** It is the one "decorated" element. Kept because the callout type is the only channel that reaches a phone reader before they have read a word, and it carries a real bit. Two types only, never a third.
- **Glyphs before the bold header.** The brief allows a leading glyph. Kept because bold alone cannot distinguish nine types at scroll speed, and the glyph set is checked against the Unicode emoji list so no phone will colour it in.
- **Strikethrough on superseded ids.** The doctrine's "off-centre strike" tell is about drawn CSS lines; markdown strikethrough on a dead identifier is the semantic convention and the only portable one.
- **Literal protocol tokens** (`in_progress`, `adopted-challenge`, `request_changes`). Uglier than English, but the file and the error messages must agree word for word.
- **Code spans for shas, branches, commands, paths only.** Monospace is data here, not a house voice; prose, labels, and the fields line stay in the body face.
- **Mandated 7-column decisions table and 5-column tasks table.** Both will scroll horizontally on a phone. Kept because the columns are mandated; proposed changes are listed below.
- **No "latest" section.** Duplicating blocks breaks "one block per message", doubles every search hit, and costs a screen; the strip's third paragraph plus the outline headings do the job.
- **Faithful AC statuses in `goal-blocked.md`.** All three ACs read `open` at 14:35 even though the plan DECIDE's replica-count test failed. The first draft of PROTOCOL 2.3 set AC status from any `test` evidence citing the AC, which would have shown `**failing**` before any code existed; proposed change 1 below limited it to STATUS and DONE, so a probe test in a CHALLENGE or DECIDE never moves an AC (PROTOCOL 2.3, RENDERING 4.3).

## Proposed changes to PROTOCOL.md 2.3

Changes 1, 2, 3, 5, and 6 were applied in protocol_version 1. Change 4 is still open: the Tasks table keeps its `branch` column.

1. **AC status should come from work evidence, not debate evidence.** Limit the "latest `test` evidence citing it" rule to STATUS and DONE messages. Without it, a CHALLENGE's or DECIDE's probe test (replica count, a grep) flips every cited AC to `failing` or `passing` before any code exists, as the first draft of the blocked sample showed.
2. **Give the human DECIDE a defined `decision_id`.** `diarchy reply` without `--decision` must still produce a DECIDE with a `decision_id` or `supersedes`; the samples assume the store assigns the next `D<n>`. Say so, or decisions.md cannot have "one row per accepted DECIDE".
3. **Allow the Status table to carry the budget.** Add `messages` and `clock` columns (or allow a budget line under the table, which is what the samples do). The reader's fourth question has no mandated home in `goal.md`.
4. **Drop or shorten the Tasks `branch` column.** Every branch is `<prefix>/<goal-id>/<agent>`, so the column repeats the assignee at 33 characters and forces horizontal scroll on a phone. Keep it in the raw ASSIGN; show it in `goal.md` only when it differs from the default.
5. **Say `chat.md` MAY contain phase headings and a header block.** 2.3 reads as "title, then blocks". The samples add a callout before the first block and H2 headings between blocks; both should be permitted explicitly so a strict implementer does not strip them.
6. **Clarify the ASK_HUMAN `seq`.** System messages carry a `seq`; 2.1 says `seq` is per-agent monotonic. Confirm `system` is an agent for that purpose, since the DONE example's `0009` will not hold in any run where the lead posts more than nine messages.

## Open for the CEO

- **Local time zone.** The samples assume the store host runs at UTC−4 and show `(12:30 local)`. If the vault syncs to a phone in another zone, "local" is the host's, not the reader's. Alternative: drop the hint and show UTC only.
- **Strip summary length.** Cut at 80 characters. A 40-word claim will truncate; the full claim is one scroll away. Could be 120 if the strip is allowed a fifth line on a phone.
- **Review assignments are invisible in `goal.md`.** They live only in `chat.md` and as `review` evidence. A `## Reviews` table would make 9.2(c) visible but is outside 2.3.
