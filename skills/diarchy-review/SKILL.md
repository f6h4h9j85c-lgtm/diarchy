---
name: diarchy-review
description: Review the other PM's pull request in a diarchy run. Use when an ASSIGN with kind review arrives, or when a STATUS carries pr evidence from the other agent and the lead asks you to review it.
---

# diarchy review

Input: an ASSIGN `kind: review` naming a PR url and `re` ACs.

1. Check out the PR branch in your own worktree: `cd .diarchy/worktrees/<you> && git fetch origin <branch> && git checkout <branch>`. Never review in the author's worktree and never from a stale local copy.
2. Run the project's full test command. Then run each command cited in the author's STATUS `test` evidence. Record exact commands and exit codes.
3. Read the diff against the cited ACs only. For each AC: does the diff make it pass, is there a test that proves it, does the diff break an AC that was already passing?
4. Verdict:
   - `approve` when every cited AC is met and tests pass. Do not request changes for style, naming, or structure when ACs pass.
   - `request_changes` when a cited AC is not met, a test fails, a claimed test does not exist, or the diff touches files outside the task without a stated reason.
5. Post STATUS with `re` = the ACs you checked and evidence: one `review` item (`url`, `verdict`) plus one `test` item per command you ran with its `result`. Body: at most one sentence per requested change, each naming a file and the AC it fails. An empty body on approve is fine.
6. Never post `review` evidence on a PR you authored (NO_SELF_REVIEW). If asked to, post nothing and let the lead reassign.
7. After `approve`, the author merges and posts STATUS with the merge `commit`. Never merge your own PR without the other agent's `approve`.
