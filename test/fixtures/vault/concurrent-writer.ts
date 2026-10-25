/**
 * Child process for the collision test: posts `count` STATUS messages as
 * `agent` against the vault in `projectDir`, using a fake clock that starts at
 * `startMs` and advances instead of sleeping. Exits non-zero on any rejection.
 *
 *   node --import tsx test/fixtures/vault/concurrent-writer.ts <projectDir> <agent> <count> <startMs> [localTz]
 */
import { loadConfig, VaultStore } from "../../../src/vault/index.js";

const [projectDir, agent, countArg, startArg, localTz] = process.argv.slice(2);
if (projectDir === undefined || agent === undefined || countArg === undefined || startArg === undefined) {
  console.error("usage: concurrent-writer.ts <projectDir> <agent> <count> <startMs>");
  process.exit(2);
}

let ms = Number(startArg);
const store = new VaultStore({
  projectDir,
  config: loadConfig(projectDir),
  agent,
  now: () => new Date(ms),
  sleep: async (wait) => {
    ms += wait;
  },
  ...(localTz === undefined ? {} : { localTz }),
});

for (let step = 1; step <= Number(countArg); step += 1) {
  const sha = `${agent === "claude" ? "a" : "b"}${String(step).padStart(6, "0")}`;
  const result = await store.post({
    type: "STATUS",
    to: "all",
    re: ["AC1"],
    body: `${agent} step ${step}.`,
    evidence: [{ kind: "commit", sha }],
  });
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
}
