// Rebuilds the sample run behind docs/samples from its message files:
//
//   npm run gen-samples
//
// The files in test/fixtures/vault/sample-run/ are the scenario. To change it,
// edit, add, or delete message files there (a new file needs a parseable id;
// any seq will do), then run this. It replays kickoff.md and the messages, in
// ts order, through a real VaultStore on a fake clock, exactly as
// test/vault.test.ts does, so every id comes from the store; reply_to is
// remapped to the new ids. The human posts through its own commands: a
// DECIDE through reply (with its decision, tasks, budgets, and body) and a
// BLOCKED through stop; a human field those cannot carry stops the run with an
// error instead of being dropped. It then rewrites:
//
//   test/fixtures/vault/sample-run/*.md      one file per message, store-written
//   docs/samples/chat.md, decisions.md, goal.md   the views at DONE
//   docs/samples/goal-blocked.md             goal.md right after the first BLOCKED
//   test/fixtures/protocol/bases/execute-ready.yaml   engine state before DONE
//
// A rendering change needs only the rerun; review the diff, since the message
// files must not change for one. The counts pinned in test/vault.test.ts and
// the strips quoted in docs/RENDERING.md and docs/RENDERING-DESIGN-NOTES.md
// are not rewritten: the failing tests name them.
//
// `tsx scripts/gen-samples.ts <dir>` reads and rewrites those paths under <dir>
// instead of this checkout (test/vault.test.ts runs it on a copy).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { stringify } from "yaml";

import {
  evaluate,
  initialState,
  parseConfig,
  parseKickoffFile,
  parseMessageFile,
  workEvidenceKeys,
  type GoalState,
  type Message,
} from "../src/protocol/index.js";
import { VaultStore, resolveVaultPaths, type MessageDraft, type PostResult } from "../src/vault/index.js";

const ROOT = process.argv[2] === undefined ? dirname(dirname(fileURLToPath(import.meta.url))) : resolve(process.argv[2]);
const SAMPLE_RUN = join(ROOT, "test", "fixtures", "vault", "sample-run");
const SAMPLES = join(ROOT, "docs", "samples");
const EXECUTE_READY = join(ROOT, "test", "fixtures", "protocol", "bases", "execute-ready.yaml");
/** The samples assume a store host at UTC-4 on 2026-10-25, as test/vault.test.ts does. */
const TZ = "America/New_York";
const CONFIG = parseConfig({ protocol_version: 1, vault: "api brain/diarchy", agents: { claude: { command: "claude" }, codex: { command: "codex" } } });
const GOAL_ID = "20261025-rate-limit";

const DRAFT_KEYS = [
  "reply_to",
  "claim",
  "evidence",
  "decision_id",
  "basis",
  "supersedes",
  "tasks",
  "ac_add",
  "budgets",
  "task",
  "new_task",
  "kind",
  "worktree",
  "branch",
  "pr",
  "reason",
  "task_status",
] as const;

/** What the agent handed the store: everything but the store-assigned fields (test/vault.test.ts toDraft). */
function toDraft(message: Message): MessageDraft {
  const draft: MessageDraft = { type: message.type, to: message.to, re: [...message.re], body: message.body };
  const target = draft as Record<string, unknown>;
  for (const key of DRAFT_KEYS) if (message[key] !== undefined) target[key] = message[key];
  const storeAssigned =
    (message.type === "PROPOSE" && message.decision_id !== "plan") || (message.type === "DECIDE" && message.supersedes !== undefined);
  if (storeAssigned) delete draft.decision_id;
  return draft;
}

/**
 * Post a human message through the human's own commands, as test/vault.test.ts
 * replays it: BLOCKED is `diarchy stop`, DECIDE is `diarchy reply`. A decision_id
 * the store assigns (no supersedes, no open thread of that id) is left to it.
 */
async function postHuman(store: VaultStore, message: Message): Promise<{ result: PostResult; storeAssigned: boolean }> {
  if (message.type === "BLOCKED") return { result: await store.stop(message.body), storeAssigned: false };
  if (message.type !== "DECIDE") throw new Error(`${message.id}: the human posts only DECIDE (reply) and BLOCKED (stop), not ${message.type}`);
  const thread = message.decision_id !== undefined && store.state()?.decisions[message.decision_id]?.status === "open" ? message.decision_id : undefined;
  const decision = message.supersedes ?? thread;
  const options = { decision, tasks: message.tasks, budgets: message.budgets, body: message.body };
  return { result: await store.reply(message.claim ?? "", options), storeAssigned: decision === undefined };
}

/** What VaultStore.stop does to the goal state: `diarchy stop` goes in without the engine's gates (PROTOCOL.md 6). */
function humanStop(state: GoalState, message: Message): GoalState {
  const next = structuredClone(state);
  if (next.phase !== "BLOCKED") {
    next.blocked_from = next.phase;
    next.phase = "BLOCKED";
  }
  next.messages.push({ id: message.id, from: message.from, type: message.type, decision_id: null, re: [...message.re] });
  next.used.wall_clock_minutes = Math.floor((Date.parse(message.ts) - Date.parse(next.created)) / 60_000);
  next.updated = message.ts;
  return next;
}

function ok(result: PostResult, label: string): string {
  if (!result.ok) throw new Error(`${label}: ${result.rule}: ${result.message}`);
  return result.id;
}

const kickoff = parseKickoffFile(readFileSync(join(SAMPLE_RUN, "kickoff.md"), "utf8"));
const scenario = readdirSync(SAMPLE_RUN)
  .filter((name) => name.endsWith(".md") && name !== "kickoff.md")
  .map((name) => ({ name, message: parseMessageFile(readFileSync(join(SAMPLE_RUN, name), "utf8")) }))
  .sort((a, b) => a.message.ts.localeCompare(b.message.ts) || a.name.localeCompare(b.name))
  .map((entry) => entry.message);
if (new Set(scenario.map((message) => message.ts)).size !== scenario.length) throw new Error("two sample-run messages share a ts");

const root = mkdtempSync(join(tmpdir(), "diarchy-gen-samples-"));
try {
  // The store: a temp project, one store per writer, one fake clock.
  const projectDir = join(root, "api");
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, "diarchy.config.json"), `${JSON.stringify({ protocol_version: 1, vault: CONFIG.vault, agents: CONFIG.agents }, null, 2)}\n`);
  let clock = Date.parse(kickoff.created);
  const make = (agent: string) =>
    new VaultStore({
      projectDir,
      config: CONFIG,
      agent,
      now: () => new Date(clock),
      sleep: async (ms: number) => {
        clock += ms;
      },
      localTz: TZ,
      pollIntervalMs: 10,
    });
  const stores: Record<string, VaultStore> = { human: make("human"), claude: make("claude"), codex: make("codex") };
  const goalDir = resolveVaultPaths(projectDir, CONFIG, GOAL_ID).goal;

  const kick = await stores.human.kickoff({ goal: kickoff.goal_text, acceptance_criteria: kickoff.acceptance_criteria, lead: kickoff.lead, slug: "rate-limit" });
  if (!kick.ok) throw new Error(`kickoff: ${kick.rule}: ${kick.message}`);
  const ids = new Map<string, string>();
  let systemSeen = 0;
  let goalBlocked: string | null = null;
  for (const message of scenario) {
    if (message.type === "KICKOFF") {
      ids.set(message.id, kick.kickoff_id);
      continue;
    }
    if (message.from === "system") {
      // The store writes system messages itself; pair them with the scenario's in order.
      const written = stores.human.listMessages().filter((entry) => entry.from === "system");
      const twin = written[systemSeen++];
      if (twin === undefined || twin.type !== message.type) throw new Error(`${message.id}: the store wrote no matching system ${message.type}`);
      ids.set(message.id, twin.id);
      continue;
    }
    clock = Date.parse(message.ts);
    const draft = toDraft(message);
    if (draft.reply_to !== undefined) {
      const target = ids.get(draft.reply_to);
      if (target === undefined) throw new Error(`${message.id}: reply_to ${draft.reply_to} is not an earlier message of the run`);
      draft.reply_to = target;
    }
    const writer = stores[message.from];
    if (writer === undefined) throw new Error(`${message.id}: no store posts as ${message.from}`);
    if (message.from === "human") {
      const { result, storeAssigned } = await postHuman(writer, message);
      const id = ok(result, message.id);
      // reply and stop set some fields themselves (re, reply_to, to, kind): a scenario value they did not write is an error, not a silent drop.
      const posted = writer.listMessages().find((entry) => entry.id === id);
      if (posted === undefined) throw new Error(`${message.id}: the store did not write ${id}`);
      const written: MessageDraft = toDraft(posted);
      const expected: MessageDraft = { ...draft };
      if (storeAssigned) {
        delete written.decision_id;
        delete expected.decision_id;
      }
      if (!isDeepStrictEqual(written, expected)) {
        throw new Error(`${message.id}: the human's reply or stop cannot post this message as written; it posted ${JSON.stringify(written)}`);
      }
      ids.set(message.id, id);
    } else {
      ids.set(message.id, ok(await writer.post(draft), message.id));
    }
    if (message.type === "BLOCKED" && goalBlocked === null) goalBlocked = readFileSync(join(goalDir, "goal.md"), "utf8");
  }
  const state = stores.human.state();
  if (state?.phase !== "DONE") throw new Error(`the run ends in ${state?.phase ?? "no state"}, not DONE`);
  if (goalBlocked === null) throw new Error("the run has no BLOCKED message for goal-blocked.md");

  // Write the run back: the store's own message files replace the scenario's.
  const chatDir = join(goalDir, "chat");
  const written = readdirSync(chatDir).filter((name) => name.endsWith(".md")).sort();
  for (const name of readdirSync(SAMPLE_RUN)) if (name.endsWith(".md") && name !== "kickoff.md") rmSync(join(SAMPLE_RUN, name));
  for (const name of written) writeFileSync(join(SAMPLE_RUN, name), readFileSync(join(chatDir, name), "utf8"));
  for (const name of ["chat.md", "decisions.md", "goal.md"]) writeFileSync(join(SAMPLES, name), readFileSync(join(goalDir, name), "utf8"));
  writeFileSync(join(SAMPLES, "goal-blocked.md"), goalBlocked);

  // execute-ready.yaml: the engine replays the written files up to the DONE, as test/protocol.test.ts does,
  // each STATUS evaluated against the work evidence the earlier ones carried, as the store does.
  let engine: GoalState = initialState(kickoff, CONFIG, new Date(kickoff.created));
  let beforeDone: GoalState | null = null;
  const workSeen: string[] = [];
  for (const name of written) {
    const message = parseMessageFile(readFileSync(join(SAMPLE_RUN, name), "utf8"));
    // A human DECIDE keeps its decision_id only when it closes an open thread (VaultStore.reply).
    const humanAssigned = message.from === "human" && (message.decision_id === undefined || engine.decisions[message.decision_id]?.status !== "open");
    const storeAssigned =
      (message.type === "PROPOSE" && message.decision_id !== "plan") || (message.type === "DECIDE" && (message.supersedes !== undefined || humanAssigned));
    if (storeAssigned) delete message.decision_id;
    if (message.type === "DONE") {
      beforeDone = engine;
      break;
    }
    if (message.type === "BLOCKED" && message.from === "human") {
      engine = humanStop(engine, message);
      continue;
    }
    const result = evaluate(message, engine, { now: new Date(message.ts), callerAgent: message.from, workSeen });
    if (!result.ok) throw new Error(`engine: ${message.id}: ${result.rule} ${result.message}`);
    engine = result.state;
    workSeen.push(...workEvidenceKeys(message));
  }
  if (beforeDone === null) throw new Error("the run has no DONE for execute-ready.yaml");
  const header = readFileSync(EXECUTE_READY, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .join("\n");
  writeFileSync(EXECUTE_READY, `${header}\n${stringify(beforeDone, { lineWidth: 0 })}`);

  console.log(
    `gen-samples: ${written.length} messages; messages_total ${state.used.messages_total}, plan_messages ${state.used.plan_messages}, ` +
      `wall_clock_minutes ${state.used.wall_clock_minutes}; seq ${JSON.stringify(state.seq)}`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
