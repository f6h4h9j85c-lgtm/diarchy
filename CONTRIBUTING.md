# Contributing

## Checks

```
npm ci
npm run lint && npm run typecheck && npm test
```

CI runs these plus `npm run build` on Node 20 and 22. `npm test -- protocol` (or `vault`, `mcp`, `codex-config`) runs one suite. After editing anything under `skills/`, run `npm run sync-skills` so `.agents/skills/` matches; `test/codex-config.test.ts` fails otherwise. A change to `agents/*.md` needs the same change in `.codex/agents/*.toml`, and a change to `hooks/hooks.json` the same in `hooks/codex-hooks.json`.

## Adding a protocol rule

1. Add a row to the rules table in `docs/ANTI-SLOP.md` (id, rule, enforcement layer, error message with `{placeholders}`, fixture name) and put the id into the evaluation-order table. `test/protocol.test.ts` parses both tables and fails when the code disagrees.
2. Add the id to `RULE_IDS` in `src/protocol/types.ts` at the same position, and a rule function in `src/protocol/rules.ts` that returns `reject(ID, text)` or `null`, registered in `RULES`.
3. Add `test/fixtures/protocol/slop/<rule_id>-<case>.yaml`: a base state from `bases/`, the message, `expect.ok: false`, `expect.rule`. Add a near-miss to `valid/` when the boundary matters.
4. The error text parity test matches the function's text against the doc's template with placeholders as wildcards. Change both or neither.
5. If the rule changes what a tool accepts, update PROTOCOL.md section 10 and the tool description in `src/mcp/server.ts`.

## Changing rendering

Edit `docs/RENDERING.md` first. The samples win over the spec when they disagree, so change `docs/samples/*.md` in the same commit. `test/vault.test.ts` replays `test/fixtures/vault/sample-run/` through a real store and compares bytes; the failing assertion shows the diff. The sample message files are the golden input and are not edited to make a rendering change pass.

## Conventions

- Commit subject in the imperative, under 72 characters, naming the component: `Add BUSY_REVIEWING to the assign path`. The body says why.
- No em dashes in prose, docs, comments, or rendered output. Use a colon, a comma, or ` · `.
- Protocol tokens (`EXECUTE`, `adopted-challenge`, rule ids) are written literally everywhere.
- Keep the line `claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy` in the README; the plugin validator looks for it.
- Lint and typecheck pass clean; no `eslint-disable` without a reason in the comment.
