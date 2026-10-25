---
name: diarchy-review
description: Review the other PM's pull request in a diarchy run. Use when an ASSIGN with kind review arrives, or when a STATUS carries pr evidence from the other agent and the lead asks you to review it.
---

# diarchy review

Input: an ASSIGN `kind: review` naming a PR url and `re` ACs. Below, `.diarchy/worktrees/<you>` and `diarchy/<goal-id>/<you>` are the defaults: your own worktree and branch are `<worktrees.root>/<you>` and `<branch_prefix>/<goal-id>/<you>` from `diarchy.config.json`.

1. Check out the PR head detached in your own worktree; a plain `git checkout <branch>` fails there because the author's worktree holds that branch. With a remote: `cd .diarchy/worktrees/<you> && git fetch origin <branch> && git checkout --detach FETCH_HEAD`. Without one: `cd .diarchy/worktrees/<you> && git checkout --detach <branch>`. If either fails with `Read-only file system` (the Codex sandbox), review a copy instead: `d=$(mktemp -d) && git archive <branch> | tar -x -C "$d"`, run step 2 in `"$d"` (link `node_modules` or other untracked dependencies from your worktree if the tests need them), and read the change with `git diff main...<branch>`. Never review in the author's worktree and never from a stale local copy. When done, return to your branch with `git checkout diarchy/<goal-id>/<you>`.
2. Run the project's full test command. Then run each command cited in the author's STATUS `test` evidence. Record exact commands and exit codes.
3. Read the diff against the cited ACs only. For each AC: does the diff make it pass, is there a test that proves it, does the diff break an AC that was already passing?
4. Verdict:
   - `approve` when every cited AC is met and tests pass. Do not request changes for style, naming, or structure when ACs pass.
   - `request_changes` when a cited AC is not met, a test fails, a claimed test does not exist, or the diff touches files outside the task without a stated reason.
5. Post STATUS with one `review` item (`url`, `verdict`) plus `test` items. Every `pass` or `fail` item sets the status of every AC in `re`, whatever the verdict, so:
   - `approve`: `re` = the ACs you checked; one `test` item per command you ran, with its `result`.
   - `request_changes`: `re` = only the unmet ACs, each backed by a `test` item with `result: fail` naming the failing command or the missing check; no `pass` items. When no AC is unmet (scope only), `re` = the ACs you checked and no `test` items.
   Body: at most one sentence per requested change, each naming a file and the AC it fails. An empty body on approve is fine.
6. Never post `review` evidence on a PR you authored (NO_SELF_REVIEW). The author is the first agent to cite it as `pr` evidence, which is always the implementer: a PM that commits or opens the PR for a sandboxed implementer cites only `commit` and passes the url in its STATUS body, so it can still review that PR. If asked to review your own, post nothing and let the lead reassign.
7. After `approve`, the author merges and posts STATUS with the merge `commit` (for a sandboxed author, the PM that opened the PR merges it). Never merge your own PR without the other agent's `approve`.
