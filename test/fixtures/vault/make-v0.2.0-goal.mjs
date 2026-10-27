/**
 * How test/fixtures/vault/v0.2.0-goal was made: drives a goal through the
 * store of a real diarchy 0.2.0 tree (its committed dist/) on a fake clock
 * and copies the stored goal files out, mid-EXECUTE. Not run by the tests.
 *
 *   git archive 30abe42 | tar -x -C <tree>    (30abe42 is the v0.2.0 release)
 *   ln -s "$PWD/node_modules" <tree>/node_modules
 *   node test/fixtures/vault/make-v0.2.0-goal.mjs <tree> test/fixtures/vault/v0.2.0-goal
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [tree, out] = process.argv.slice(2);
if (tree === undefined || out === undefined) {
  console.error("usage: make-v0.2.0-goal.mjs <v0.2.0 tree> <out dir>");
  process.exit(2);
}
const version = JSON.parse(readFileSync(join(tree, "package.json"), "utf8")).version;
if (version !== "0.2.0") throw new Error(`${tree} is diarchy ${version}, not 0.2.0`);
const { VaultStore, loadConfig, resolveVaultPaths } = await import(pathToFileURL(resolve(tree, "dist", "vault", "index.js")).href);

/** The project path kickoff.md records, as the v0.1.0 fixture has it. */
const PROJECT = "/home/user/api";
const GOAL = "20261025-rate-limit";
const PR_101 = "https://github.com/acme/api/pull/101";
const PR_102 = "https://github.com/acme/api/pull/102";

const root = mkdtempSync(join(tmpdir(), "diarchy-v020-"));
const projectDir = join(root, "api");
const config = { protocol_version: 1, vault: "api brain/diarchy", agents: { claude: { command: "claude" }, codex: { command: "codex" } } };
mkdirSync(projectDir);
writeFileSync(join(projectDir, "diarchy.config.json"), `${JSON.stringify(config, null, 2)}\n`);

let ms = 0;
const store = (agent) =>
  new VaultStore({
    projectDir,
    config: loadConfig(projectDir),
    agent,
    now: () => new Date(ms),
    sleep: async (wait) => {
      ms += wait;
    },
    localTz: "America/New_York",
  });
const human = store("human");
const claude = store("claude");
const codex = store("codex");

/** Post at `ts` and, as a PM's wait_for_reply would, let each reader take delivery. */
async function at(ts, write, readers = []) {
  ms = Date.parse(ts);
  const result = await write();
  if (!result.ok) throw new Error(`${ts}: ${result.rule}: ${result.message}`);
  for (const reader of readers) reader.read();
  return result;
}

await at(
  "2026-10-25T14:00:00Z",
  () =>
    human.kickoff({
      goal: "Add per-API-key rate limiting to the public API.",
      acceptance_criteria: ["Requests over the per-key limit get HTTP 429 with a Retry-After header", "The README documents the per-key limit"],
      lead: "claude",
      slug: "rate-limit",
    }),
  [claude, codex],
);
const propose = await at(
  "2026-10-25T14:01:00Z",
  () =>
    claude.post({
      type: "PROPOSE",
      to: "codex",
      re: ["AC1", "AC2"],
      decision_id: "plan",
      claim: "A token bucket per API key in the router middleware meets AC1, and a README section meets AC2.",
      body: "T1 builds the bucket and the 429 response; T2 documents the limit. Each lands as a reviewed PR.",
    }),
  [codex],
);
const challenge = await at(
  "2026-10-25T14:03:00Z",
  () =>
    codex.post({
      type: "CHALLENGE",
      to: "claude",
      re: ["AC1"],
      reply_to: propose.id,
      decision_id: "plan",
      claim: "A bucket held in process memory resets on every deploy, so a client can exceed its limit across a restart.",
      evidence: [{ kind: "test", test: "npm test -- rate-limit-restart", result: "pending" }],
      body: "The restart test fails until the bucket state survives a deploy.",
    }),
  [claude],
);
await at(
  "2026-10-25T14:05:00Z",
  () =>
    claude.post({
      type: "DECIDE",
      to: "all",
      re: ["AC1", "AC2"],
      decision_id: "plan",
      reply_to: challenge.id,
      basis: "authority",
      claim: "The in-process bucket stands while the API runs one replica.",
      tasks: ["Implement the per-key token bucket and the 429 response with Retry-After", "Document the per-key limit in the README"],
      body: "docs/deploy.md runs one replica, so a deploy is the only reset. Ruling by authority; the restart test joins T1.",
    }),
  [codex],
);
await at("2026-10-25T14:06:00Z", () =>
  claude.post({
    type: "ASSIGN",
    to: "codex",
    re: ["AC1"],
    task: "T1",
    kind: "implement",
    worktree: ".diarchy/worktrees/codex",
    branch: `diarchy/${GOAL}/codex`,
    reason: "availability",
  }),
);
await at(
  "2026-10-25T14:07:00Z",
  () =>
    claude.post({
      type: "ASSIGN",
      to: "claude",
      re: ["AC2"],
      task: "T2",
      kind: "implement",
      worktree: ".diarchy/worktrees/claude",
      branch: `diarchy/${GOAL}/claude`,
      reason: "availability",
    }),
  [codex],
);
await at(
  "2026-10-25T14:31:00Z",
  () =>
    codex.post({
      type: "STATUS",
      to: "claude",
      re: ["AC1"],
      task: "T1",
      task_status: "done",
      evidence: [
        { kind: "commit", sha: "3f9a2c1" },
        { kind: "pr", url: PR_101 },
        { kind: "test", test: "npm test -- rate-limit", result: "pass" },
      ],
      body: `T1 landed on diarchy/${GOAL}/codex: over-limit requests get 429 with Retry-After, and the test passes.`,
    }),
  [claude],
);
await at("2026-10-25T14:33:00Z", () =>
  claude.post({ type: "ASSIGN", to: "claude", re: ["AC1"], new_task: `Review ${PR_101}`, kind: "review", pr: PR_101, reason: "availability" }),
);
await at(
  "2026-10-25T14:41:00Z",
  () =>
    claude.post({
      type: "STATUS",
      to: "codex",
      re: ["AC1"],
      evidence: [{ kind: "review", url: PR_101, verdict: "approve" }],
      body: "Approved pull 101: the bucket keys on the API key and the 429 carries Retry-After.",
    }),
  [codex],
);
await at(
  "2026-10-25T14:50:00Z",
  () =>
    claude.post({
      type: "BLOCKED",
      to: "all",
      re: ["AC2"],
      kind: "external",
      body: "The README needs the production per-key limit and no one has set it. I will not guess a figure ops must own.",
    }),
  [codex],
);
await at("2026-10-25T15:02:00Z", () => human.reply("Document 100 requests per minute per key"), [claude, codex]);
await at(
  "2026-10-25T15:14:00Z",
  () =>
    claude.post({
      type: "STATUS",
      to: "codex",
      re: ["AC2"],
      task: "T2",
      task_status: "done",
      evidence: [
        { kind: "commit", sha: "8b41d07" },
        { kind: "pr", url: PR_102 },
        { kind: "test", test: "npm test -- readme", result: "pass" },
      ],
      body: "T2 landed: the README documents 100 requests per minute per key, as ruled.",
    }),
  [codex],
);
await at(
  "2026-10-25T15:16:00Z",
  () => claude.post({ type: "ASSIGN", to: "codex", re: ["AC2"], new_task: `Review ${PR_102}`, kind: "review", pr: PR_102, reason: "availability" }),
  [codex],
);
// 0.2.0 lets a STATUS mark a review task done without review evidence; the goal stops before claude reads it.
await at("2026-10-25T15:25:00Z", () =>
  codex.post({
    type: "STATUS",
    to: "claude",
    re: ["AC2"],
    task: "T4",
    task_status: "done",
    evidence: [{ kind: "file", path: "README.md" }],
    body: "Read pull 102 against AC2 and the ruling; marking my review task done.",
  }),
);

// The stored files only: chat.md, goal.md, and decisions.md are views every write renders again.
const goalDir = resolveVaultPaths(projectDir, config, GOAL).goal;
for (const name of ["kickoff.md", "budget.json", "chat", "inbox"]) {
  rmSync(join(out, name), { recursive: true, force: true });
  cpSync(join(goalDir, name), join(out, name), { recursive: true });
}
for (const name of readdirSync(out, { recursive: true })) {
  const path = join(out, String(name));
  if (name === "README.md" || (!path.endsWith(".md") && !path.endsWith(".json"))) continue;
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(projectDir, PROJECT));
}
rmSync(root, { recursive: true, force: true });
console.log(`wrote ${out}`);
