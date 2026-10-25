#!/usr/bin/env node
// Copies skills/* to .agents/skills/ so Codex CLI discovers the same skills
// Claude Code loads from skills/. Real copies, not symlinks: symlinks break on
// Windows checkouts and in plugin installers that archive the repo.
// Run `npm run sync-skills` after editing a skill; test/codex-config.test.ts
// fails when the two trees drift.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "skills");
const dst = join(root, ".agents", "skills");

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

let count = 0;
for (const entry of readdirSync(src, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  cpSync(join(src, entry.name), join(dst, entry.name), { recursive: true });
  count += 1;
}
console.log(`sync-skills: copied ${count} skill(s) to .agents/skills/`);
