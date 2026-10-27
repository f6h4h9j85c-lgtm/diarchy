# v0.2.0-goal

A goal directory written by the diarchy 0.2.0 store (release commit 30abe42),
used by `test/vault.test.ts` and `test/protocol.test.ts` to check that a goal
0.2.0 left mid-EXECUTE loads and continues to DONE under the current store,
and that what the current store writes still parses under 0.2.0's schema
(`../v0.2.0-schema/`: 0.2.0's `dist/protocol/schema.js`, `text.js`, and
`types.js`, less their `sourceMappingURL` comments, since the maps are not
copied; CI checks out one commit, so the tests cannot read them from git).

It is not hand-written. `../make-v0.2.0-goal.mjs` drove the goal through the
0.2.0 tree's own `dist/` on a fake clock and copied the stored files out:

```sh
git archive 30abe42 | tar -x -C <tree>
ln -s "$PWD/node_modules" <tree>/node_modules
node test/fixtures/vault/make-v0.2.0-goal.mjs <tree> test/fixtures/vault/v0.2.0-goal
```

Rerunning it reproduces these files byte for byte (this README aside). It keeps
what a store reads (`kickoff.md`, `budget.json`, `chat/`, `inbox/`) and leaves
out `chat.md`, `goal.md`, and `decisions.md`, which every write renders again.
As in `../v0.1.0-goal`, `kickoff.md` records the project as `/home/user/api`
(and the vault under it); nothing else is changed.

The run: kickoff, a plan challenged with a pending test and decided by
authority, T1 and T2 assigned, codex's STATUS with commit, pr, and test
evidence, claude's review task T3 closed by its approve review, claude
BLOCKED external, the system ASK_HUMAN, the human's ruling, claude's STATUS
for T2, and review task T4 for codex. It stops after codex's STATUS marks T4
done with no review evidence. 0.2.0 recorded that; the current engine
ignores `task_status` on a review task (ANTI-SLOP.md BUSY_REVIEWING), so
PR 102 still owes codex's review.
