import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assignId,
  parseConfig,
  parseGoalState,
  parseKickoffFile,
  parseMessageFile,
  parseMessageId,
  type DiarchyConfig,
  type GoalState,
  type Message,
} from "../src/protocol/index.js";
import {
  GENERATED,
  MAX_WAIT_MS,
  PROGRESS_MS,
  VaultStore,
  defaultVault,
  loadConfig,
  renderChat,
  renderDecisions,
  renderGoal,
  resolveVaultPaths,
  slugify,
  type MessageDraft,
  type PostResult,
} from "../src/vault/index.js";
import { budgetLine, code, escapeBlockStarts, italic, linkText, localHint } from "../src/vault/render/shared.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SAMPLE_RUN = join(FIXTURES, "vault", "sample-run");
const EXAMPLES = join(FIXTURES, "protocol", "examples");
const WRITER = join(FIXTURES, "vault", "concurrent-writer.ts");
const SAMPLES = fileURLToPath(new URL("../docs/samples/", import.meta.url));

/** The samples assume a store host at UTC-4 on 2026-10-25. */
const TZ = "America/New_York";
const T0 = "2026-10-25T14:00:00Z";
const POLL_MS = 10;

const CONFIG: DiarchyConfig = parseConfig({
  protocol_version: 1,
  vault: "api brain/diarchy",
  agents: { claude: { command: "claude" }, codex: { command: "codex" } },
});

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeClock {
  ms: number;

  constructor(iso: string) {
    this.ms = Date.parse(iso);
  }

  now = (): Date => new Date(this.ms);

  /** The store's "sleep until ts" moves the fake clock instead of waiting. */
  sleep = async (ms: number): Promise<void> => {
    this.ms += ms;
  };

  set(iso: string): void {
    this.ms = Date.parse(iso);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

// ---------------------------------------------------------------------------
// Harness: a temp project with one store per writer sharing a fake clock
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  projectDir: string;
  clock: FakeClock;
  human: VaultStore;
  claude: VaultStore;
  codex: VaultStore;
  goalDir(goalId?: string): string;
  file(name: string, goalId?: string): string;
}

function harness(start = T0): Harness {
  const root = mkdtempSync(join(tmpdir(), "diarchy-vault-"));
  temps.push(root);
  const projectDir = join(root, "api");
  mkdirSync(projectDir);
  writeFileSync(
    join(projectDir, "diarchy.config.json"),
    `${JSON.stringify({ protocol_version: 1, vault: CONFIG.vault, agents: CONFIG.agents }, null, 2)}\n`,
  );
  const clock = new FakeClock(start);
  const make = (agent: string) =>
    new VaultStore({ projectDir, config: CONFIG, agent, now: clock.now, sleep: clock.sleep, localTz: TZ, pollIntervalMs: POLL_MS });
  const goalDir = (goalId = "20261025-rate-limit") => resolveVaultPaths(projectDir, CONFIG, goalId).goal;
  return {
    projectDir,
    clock,
    human: make("human"),
    claude: make("claude"),
    codex: make("codex"),
    goalDir,
    file: (name, goalId) => readFileSync(join(goalDir(goalId), name), "utf8"),
  };
}

function ok(result: PostResult): asserts result is Extract<PostResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.rule}: ${result.message}`);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(`${name}/`, ...listFiles(path).map((child) => `${name}/${child}`));
    else out.push(name);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// The sample run behind docs/samples: kickoff.md plus 21 message files
// ---------------------------------------------------------------------------

const RUN_KICKOFF = parseKickoffFile(readFileSync(join(SAMPLE_RUN, "kickoff.md"), "utf8"));
const RUN_FILES = readdirSync(SAMPLE_RUN)
  .filter((name) => name.endsWith(".md") && name !== "kickoff.md")
  .sort();
const RUN: Message[] = RUN_FILES.map((name) => parseMessageFile(readFileSync(join(SAMPLE_RUN, name), "utf8")));

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

/** What the agent handed the store: everything but the store-assigned fields. */
function toDraft(message: Message): MessageDraft {
  const draft: MessageDraft = { type: message.type, to: message.to, re: [...message.re], body: message.body };
  const target = draft as Record<string, unknown>;
  for (const key of DRAFT_KEYS) if (message[key] !== undefined) target[key] = message[key];
  const storeAssigned =
    (message.type === "PROPOSE" && message.decision_id !== "plan") || (message.type === "DECIDE" && message.supersedes !== undefined);
  if (storeAssigned) delete draft.decision_id;
  return draft;
}

type Writer = "human" | "claude" | "codex";

/** Kick off and replay the first `count` run messages; KICKOFF and the system ASK_HUMAN come from the store itself. */
async function replay(h: Harness, count = RUN.length, onStep?: (message: Message) => void): Promise<void> {
  h.clock.set(RUN_KICKOFF.created);
  const kick = await h.human.kickoff({
    goal: RUN_KICKOFF.goal_text,
    acceptance_criteria: RUN_KICKOFF.acceptance_criteria,
    lead: RUN_KICKOFF.lead,
    slug: "rate-limit",
  });
  ok(kick);
  expect(kick.kickoff_id).toBe(RUN[0].id);
  for (const message of RUN.slice(0, count)) {
    if (message.type === "KICKOFF" || message.type === "ASK_HUMAN") continue;
    h.clock.set(message.ts);
    const result =
      message.from === "human"
        ? await h.human.reply(message.claim ?? "", { body: message.body })
        : await h[message.from as Writer].post(toDraft(message));
    ok(result);
    expect(result.id).toBe(message.id);
    onStep?.(message);
  }
}

const BLOCKED_INDEX = RUN.findIndex((message) => message.type === "BLOCKED") + 1;

// ---------------------------------------------------------------------------
// Golden renders
// ---------------------------------------------------------------------------

describe("golden renders", () => {
  it("the sample run has 21 messages in (ts, seq) order with one writer-owned file each", () => {
    expect(RUN).toHaveLength(21);
    expect(RUN_FILES).toEqual(RUN.map((message) => `${message.id}.md`));
    expect(RUN.map((message) => message.ts)).toEqual([...RUN.map((message) => message.ts)].sort());
    expect(new Set(RUN.map((message) => message.ts)).size).toBe(21);
  });

  it("replays the run through a real VaultStore and reproduces chat.md, decisions.md, goal.md byte for byte", async () => {
    const h = harness();
    await replay(h);
    expect(h.file("chat.md")).toBe(readFileSync(join(SAMPLES, "chat.md"), "utf8"));
    expect(h.file("decisions.md")).toBe(readFileSync(join(SAMPLES, "decisions.md"), "utf8"));
    expect(h.file("goal.md")).toBe(readFileSync(join(SAMPLES, "goal.md"), "utf8"));
    const chat = join(h.goalDir(), "chat");
    expect(readdirSync(chat).sort()).toEqual(RUN_FILES);
    for (const name of RUN_FILES) {
      expect(readFileSync(join(chat, name), "utf8"), name).toBe(readFileSync(join(SAMPLE_RUN, name), "utf8"));
    }
    const state = h.claude.state();
    expect(state?.phase).toBe("DONE");
    expect(state?.used).toMatchObject({ messages_total: 18, plan_messages: 5, wall_clock_minutes: 150 });
    expect(state?.seq).toEqual({ claude: 12, codex: 6, human: 2, system: 1 });
  });

  it("reproduces goal-blocked.md after the BLOCKED message, with a WARNING strip in chat.md", async () => {
    const h = harness();
    await replay(h, BLOCKED_INDEX);
    expect(h.file("goal.md")).toBe(readFileSync(join(SAMPLES, "goal-blocked.md"), "utf8"));
    const chat = h.file("chat.md");
    expect(chat).toContain("> [!WARNING]\n> **BLOCKED** from EXECUTE · **human needed** since 14:35:01 UTC · lead claude · challenger codex");
    expect(chat).toContain("> 9 of 80 messages (PLAN 5 of 12) · 35 of 240 min\n");
    expect(chat).toContain("> 2026-10-25 · last 14:35:01 UTC (10:35 local) · system ASK_HUMAN: codex is BLOCKED (external): Integration test needs staging REDIS_URL. Not in…\n");
    expect(chat).toContain("> Question and how to answer: [goal](goal.md) · [decisions (2)](decisions.md)");
    expect(chat.trimEnd().endsWith("codex is BLOCKED (external): Integration test needs staging REDIS_URL. Not in .env.example or the vault; I will not guess a credential. Answer with `diarchy reply \"<text>\"`.")).toBe(true);
    expect(h.claude.state()?.phase).toBe("BLOCKED");
  });

  it("the PROTOCOL.md 3.2 examples are messages of the run (ids re-numbered by the store, ASK_HUMAN body engine-generated)", () => {
    const examples = readdirSync(EXAMPLES).filter((name) => name.endsWith(".md"));
    expect(examples).toHaveLength(9);
    for (const name of examples) {
      const example = parseMessageFile(readFileSync(join(EXAMPLES, name), "utf8"));
      const twin = RUN.find((message) => message.ts === example.ts);
      expect(twin, name).toBeDefined();
      expect(twin).toMatchObject({ from: example.from, to: example.to, type: example.type, re: example.re });
      if (example.claim !== undefined) expect(twin?.claim).toBe(example.claim);
      if (example.evidence !== undefined) expect(twin?.evidence).toEqual(example.evidence);
    }
  });

  it("strip counters come from state, not from the transcript", async () => {
    const h = harness();
    await replay(h);
    const messages = h.claude.listMessages();
    const state = h.claude.state();
    const kickoff = h.claude.readKickoff();
    if (state === null || kickoff === null) throw new Error("no goal");
    const tampered: GoalState = { ...state, used: { ...state.used, messages_total: 99, plan_messages: 7 }, seq: { ...state.seq, claude: 40 } };
    const chat = renderChat(messages, tampered, kickoff, { localTz: TZ });
    expect(chat).toContain("> 99 of 80 messages (PLAN 7 of 12) · 150 of 240 min\n");
    expect(renderChat(messages, state, kickoff, { localTz: TZ })).toBe(h.file("chat.md"));
    expect(renderGoal(messages, tampered, kickoff, { localTz: TZ })).toContain("99 of 80 messages (PLAN 7 of 12)");
  });

  it("renders deterministically regardless of input order and render time", async () => {
    const h = harness();
    await replay(h);
    const messages = h.claude.listMessages();
    const state = h.claude.state();
    const kickoff = h.claude.readKickoff();
    if (state === null || kickoff === null) throw new Error("no goal");
    const shuffled = [...messages].reverse();
    expect(renderChat(shuffled, state, kickoff, { localTz: TZ })).toBe(h.file("chat.md"));
    expect(renderDecisions(shuffled, state, kickoff)).toBe(h.file("decisions.md"));
    expect(renderGoal(shuffled, state, kickoff, { localTz: TZ })).toBe(h.file("goal.md"));
  });
});

// ---------------------------------------------------------------------------
// Renderer details not exercised by the samples
// ---------------------------------------------------------------------------

describe("renderer rules", () => {
  it("escapes block starts, emphasis inside italics, and backticks in code spans", () => {
    expect(escapeBlockStarts("# heading\n> quote\n- item\n* item\n+ item\n| cell\n1. first\n---\n***\nplain # fine")).toBe(
      "\\# heading\n\\> quote\n\\- item\n\\* item\n\\+ item\n\\| cell\n\\1. first\n\\---\n\\***\nplain # fine",
    );
    expect(italic("RATE_LIMIT is *fast*.")).toBe("*RATE\\_LIMIT is \\*fast\\*.*");
    expect(code("npm test")).toBe("`npm test`");
    expect(code("echo `x`")).toBe("`` echo `x` ``");
  });

  it("derives link text from GitHub PR and commit URLs and trims other URLs at 60 characters", () => {
    expect(linkText("https://github.com/acme/api/pull/412")).toBe("acme/api#412");
    expect(linkText("https://github.com/acme/api/commit/1c0ffee42abc")).toBe("acme/api@1c0ffee");
    expect(linkText("https://docs.redis.io/commands/incr/")).toBe("docs.redis.io/commands/incr");
    const long = `https://example.com/${"a".repeat(70)}`;
    expect(linkText(long)).toBe(`example.com/${"a".repeat(48)}…`);
    expect(linkText(long)).toHaveLength(61);
  });

  it("local hint carries the date when the local day differs from the UTC day", () => {
    expect(localHint("2026-10-25T16:30:00Z", TZ)).toBe("(12:30 local)");
    expect(localHint("2026-10-25T03:30:00Z", TZ)).toBe("(23:30 local, 2026-10-24)");
    expect(localHint("2026-10-25T16:30:00Z", "UTC")).toBe("(16:30 local)");
  });

  it("budget line appends spend and the open deadlock, and says so when state is unavailable", async () => {
    const h = harness();
    await replay(h);
    const state = h.claude.state();
    if (state === null) throw new Error("no goal");
    expect(budgetLine(state)).toBe("18 of 80 messages (PLAN 5 of 12) · 150 of 240 min");
    const spending: GoalState = {
      ...state,
      limits: { ...state.limits, spend_usd: 50 },
      used: { ...state.used, spend_usd: 12.5 },
      deadlock_watch: { decision_id: "D1", challenge_id: RUN[16].id, remaining: 2, deadline: "2026-10-25T15:59:12Z" },
    };
    expect(budgetLine(spending)).toBe(
      "18 of 80 messages (PLAN 5 of 12) · 150 of 240 min · 12.50 of 50.00 USD · open D1, DECIDE due by 15:59:12 UTC",
    );
    expect(budgetLine(null)).toBe("budget unavailable");
    const kickoff = h.claude.readKickoff();
    if (kickoff === null) throw new Error("no kickoff");
    const chat = renderChat(h.claude.listMessages(), null, kickoff, { localTz: TZ });
    expect(chat.startsWith(`${GENERATED}\n# Chat: 20261025-rate-limit\n\n> [!NOTE]\n`)).toBe(true);
    expect(chat).toContain("> budget unavailable\n");
  });

  it("the open deadlock shows in the strip while the lead's DECIDE is pending", async () => {
    const h = harness();
    await replay(h, RUN.findIndex((message) => message.id === RUN[16].id) + 1);
    expect(RUN[16].type).toBe("CHALLENGE");
    const chat = h.file("chat.md");
    expect(chat).toContain("> 14 of 80 messages (PLAN 5 of 12) · 109 of 240 min · open D1, DECIDE due by 15:59:12 UTC\n");
    expect(chat).toContain(
      "> 2026-10-25 · last 15:49:12 UTC (11:49 local) · codex CHALLENGE: A default of 100 requests per minute breaks the dashboard, which polls twice a\u2026\n",
    );
  });

  it("day headings mark a UTC date change between messages", async () => {
    const h = harness();
    await replay(h, BLOCKED_INDEX);
    h.clock.set("2026-10-26T00:10:00Z");
    ok(await h.human.reply("Carry on tomorrow.", { budgets: { wall_clock_minutes: 1440 } }));
    const chat = h.file("chat.md");
    expect(chat).toContain("---\n\n## 2026-10-26 UTC\n\n● **human → all · DECIDE · D2 · re AC1 · 00:10:00**\n\nbasis: human · replying to system ASK_HUMAN 14:35:01 · budgets: wall_clock_minutes 1440\n");
    expect(chat.trimEnd().endsWith("---\n\n## → EXECUTE · 00:10:00")).toBe(true);
    expect(h.human.state()).toMatchObject({ phase: "EXECUTE", used: { wall_clock_minutes: 610 } });
    expect(chat).toContain("> 2026-10-26 · last 00:10:00 UTC (20:10 local, 2026-10-25) · human DECIDE: Carry on tomorrow.\n");
    expect(h.file("decisions.md")).toContain("| D2 | [2026-10-26 00:10:00](chat/20261026T001000Z-0002-human-DECIDE.md) | human |");
  });
});

// ---------------------------------------------------------------------------
// Collision-free concurrent writers
// ---------------------------------------------------------------------------

function spawnWriter(projectDir: string, agent: string, count: number, startMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, projectDir, agent, String(count), String(startMs), TZ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(`${agent} writer exited ${status}: ${output}`))));
  });
}

describe("concurrent writers", () => {
  it("two processes posting 20 STATUS messages each never collide and leave no lock or temp files", async () => {
    const h = harness();
    ok(
      await h.human.kickoff({
        goal: "Ship the thing.",
        acceptance_criteria: ["It ships."],
        lead: "claude",
        slug: "ship",
        budgets: { messages_total: 200, wall_clock_minutes: 100_000 },
      }),
    );
    h.clock.advance(1_000);
    ok(await h.claude.post({ type: "PROPOSE", to: "all", re: ["AC1"], decision_id: "plan", claim: "One task ships it.", body: "A single task." }));
    h.clock.advance(1_000);
    ok(
      await h.claude.post({
        type: "DECIDE",
        to: "all",
        re: ["AC1"],
        decision_id: "plan",
        basis: "authority",
        claim: "One task ships it.",
        tasks: ["Ship"],
        body: "Nothing to test before the work starts.",
      }),
    );
    const before = h.claude.state();
    if (before === null) throw new Error("no goal");
    expect(before.phase).toBe("EXECUTE");
    const start = h.clock.ms + 1_000;
    await Promise.all([spawnWriter(h.projectDir, "claude", 20, start), spawnWriter(h.projectDir, "codex", 20, start)]);

    const goalDir = h.goalDir("20261025-ship");
    const files = readdirSync(join(goalDir, "chat")).filter((name) => name.endsWith(".md"));
    expect(files).toHaveLength(before.messages.length + 40);
    const parts = files.map((name) => parseMessageId(name.replace(/\.md$/, ""))).filter((part) => part !== null);
    const statuses = parts.filter((part) => part.type === "STATUS");
    expect(statuses).toHaveLength(40);
    for (const agent of ["claude", "codex"]) {
      const seqs = statuses.filter((part) => part.agent === agent).map((part) => part.seq).sort((a, b) => a - b);
      const first = before.seq[agent] + 1;
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => first + index));
    }
    const stamps = parts.map((part) => part.ts_compact);
    expect(new Set(stamps).size).toBe(stamps.length);

    const after = parseGoalState(JSON.parse(readFileSync(join(goalDir, "budget.json"), "utf8")));
    expect(after.used.messages_total).toBe(before.used.messages_total + 40);
    expect(after.seq).toEqual({ ...before.seq, claude: before.seq.claude + 20, codex: before.seq.codex + 20 });
    expect(after.messages).toHaveLength(before.messages.length + 40);

    const everything = listFiles(goalDir);
    expect(everything.filter((name) => name.includes(".lock") || name.includes(".tmp-"))).toEqual([]);

    const rendered = () => ["chat.md", "decisions.md", "goal.md"].map((name) => readFileSync(join(goalDir, name), "utf8"));
    const first = rendered();
    h.claude.render();
    expect(rendered()).toEqual(first);
    h.codex.render();
    expect(rendered()).toEqual(first);
    expect(first[0]).toContain("> 42 of 200 messages (PLAN 2 of 12)");
  });
});

// ---------------------------------------------------------------------------
// Store-owned files
// ---------------------------------------------------------------------------

describe("store-owned files", () => {
  it("rendered files and budget.json match the store's own render and state after every transaction; chat files never change", async () => {
    const h = harness();
    const seen = new Map<string, string>();
    await replay(h, RUN.length, () => {
      const goalDir = h.goalDir();
      const kickoff = h.claude.readKickoff();
      const state = h.claude.state();
      if (kickoff === null || state === null) throw new Error("no goal");
      const messages = h.claude.listMessages();
      expect(h.file("chat.md")).toBe(renderChat(messages, state, kickoff, { localTz: TZ }));
      expect(h.file("decisions.md")).toBe(renderDecisions(messages, state, kickoff));
      expect(h.file("goal.md")).toBe(renderGoal(messages, state, kickoff, { localTz: TZ }));
      expect(state.messages.map((ref) => ref.id)).toEqual(messages.map((message) => message.id));
      for (const name of readdirSync(join(goalDir, "chat"))) {
        const text = readFileSync(join(goalDir, "chat", name), "utf8");
        const earlier = seen.get(name);
        if (earlier !== undefined) expect(text, `${name} was modified`).toBe(earlier);
        seen.set(name, text);
      }
      expect(listFiles(goalDir).filter((name) => name.includes(".tmp-") || name.includes(".lock"))).toEqual([]);
    });
    expect(seen.size).toBe(21);
  });

  it("no public method takes a path; only kickoff, post, read, waitForReply, reply, stop, and render write", () => {
    const methods = Object.getOwnPropertyNames(VaultStore.prototype).filter((name) => name !== "constructor");
    const publicApi = ["listGoals", "activeGoal", "state", "listMessages", "readKickoff", "render", "kickoff", "post", "read", "waitForReply", "reply", "stop"];
    for (const name of publicApi) expect(methods).toContain(name);
    expect(methods.some((name) => /path|file|write|save|persist/i.test(name) && !publicApi.includes(name) && !name.startsWith("load") && !name.startsWith("read"))).toBe(true);
  });

  it("rejects a message whose from is another agent with WRITER_OWNED and writes nothing", async () => {
    const h = harness();
    await replay(h, 3);
    const chat = join(h.goalDir(), "chat");
    const before = readdirSync(chat);
    const budget = h.file("budget.json");
    const result = await h.claude.post({ type: "STATUS", from: "codex", to: "all", re: ["AC1"], evidence: [{ kind: "commit", sha: "abcdef1" }], body: "Spoofed." });
    expect(result).toEqual({ ok: false, rule: "WRITER_OWNED", message: 'This server posts as "claude". Set from: claude or omit it.' });
    expect(readdirSync(chat)).toEqual(before);
    expect(h.file("budget.json")).toBe(budget);
    expect(existsSync(join(h.goalDir(), ".lock"))).toBe(false);
  });

  it("refuses to overwrite an existing message file", async () => {
    const h = harness();
    await replay(h, 1);
    const state = h.claude.state();
    if (state === null) throw new Error("no goal");
    const next = assignId(state, "claude", "PROPOSE", h.clock.now());
    const path = join(h.goalDir(), "chat", `${next.id}.md`);
    writeFileSync(path, "planted\n");
    await expect(
      h.claude.post({ type: "PROPOSE", to: "all", re: ["AC1"], decision_id: "plan", claim: "Collide.", body: "This must not overwrite." }),
    ).rejects.toThrow(/refusing to overwrite/);
    expect(readFileSync(path, "utf8")).toBe("planted\n");
    expect(existsSync(join(h.goalDir(), ".lock"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

describe("lock", () => {
  const PROPOSE: MessageDraft = { type: "PROPOSE", to: "all", re: ["AC1", "AC2", "AC3"], decision_id: "plan", claim: "Redis it is.", body: "Shared counter across replicas." };

  it("removes a stale lock older than 30 s and posts", async () => {
    const h = harness();
    await replay(h, 1);
    const lock = join(h.goalDir(), ".lock");
    mkdirSync(lock);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    h.clock.advance(1_000);
    ok(await h.claude.post(PROPOSE));
    expect(existsSync(lock)).toBe(false);
  });

  it("waits on a fresh lock instead of failing", async () => {
    const h = harness();
    await replay(h, 1);
    const lock = join(h.goalDir(), ".lock");
    mkdirSync(lock);
    h.clock.advance(1_000);
    let settled = false;
    const pending = h.claude.post(PROPOSE).then((result) => {
      settled = true;
      return result;
    });
    await realSleep(250);
    expect(settled).toBe(false);
    rmSync(lock, { recursive: true });
    ok(await pending);
    expect(existsSync(lock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kickoff
// ---------------------------------------------------------------------------

describe("kickoff", () => {
  const INPUT = { goal: "Add per-API-key rate limiting to the public API.", acceptance_criteria: ["Requests over the limit get 429.", "Limit is configurable."] };

  it("writes kickoff.md atomically, initializes budget.json and inboxes, posts KICKOFF, and renders", async () => {
    const h = harness();
    const result = await h.human.kickoff({ ...INPUT, lead: "codex", budgets: { plan_messages: 6 } });
    ok(result);
    const goalId = "20261025-add-per-api-key-rate-limiting-to-the-pub";
    expect(result).toMatchObject({ goal_id: goalId, lead: "codex", challenger: "claude", kickoff_id: "20261025T140000Z-0001-human-KICKOFF", phase: "PLAN" });
    const files = listFiles(h.goalDir(goalId));
    expect(files).toEqual(["budget.json", "chat.md", "chat/", "chat/20261025T140000Z-0001-human-KICKOFF.md", "decisions.md", "goal.md", "inbox/", "kickoff.md"]);
    const kickoff = parseKickoffFile(h.file("kickoff.md", goalId));
    expect(kickoff).toMatchObject({
      goal: goalId,
      lead: "codex",
      challenger: "claude",
      agents: ["claude", "codex"],
      budgets: { plan_messages: 6 },
      project: h.projectDir,
      vault: join(h.projectDir, "api brain", "diarchy"),
      created: T0,
      by: "human",
      goal_text: INPUT.goal,
      acceptance_criteria: INPUT.acceptance_criteria,
    });
    const state = parseGoalState(JSON.parse(h.file("budget.json", goalId)));
    expect(state).toMatchObject({ phase: "PLAN", lead: "codex", kickoff_id: result.kickoff_id, seq: { claude: 0, codex: 0, human: 1, system: 0 } });
    expect(state.limits.plan_messages).toBe(6);
    expect(h.file("goal.md", goalId).startsWith(`${GENERATED}\n# ${goalId}\n\n${INPUT.goal}\n`)).toBe(true);
    expect(h.file("chat.md", goalId)).toContain("## → PLAN · 14:00:00");
    expect(h.file("decisions.md", goalId)).toContain("2026-10-25 UTC · 0 decisions, 0 superseded");
    expect(h.human.activeGoal()?.goalId).toBe(goalId);
  });

  it("rejects a second kickoff with SINGLE_KICKOFF while a goal is active, from any store", async () => {
    const h = harness();
    ok(await h.human.kickoff(INPUT));
    const again = await h.human.kickoff({ ...INPUT, slug: "another" });
    expect(again).toEqual({
      ok: false,
      rule: "SINGLE_KICKOFF",
      message: "Goal 20261025-add-per-api-key-rate-limiting-to-the-pub is already active (phase PLAN). Call read instead of kickoff.",
    });
    expect((await h.claude.kickoff({ ...INPUT, slug: "third" })).ok).toBe(false);
    expect(h.human.listGoals()).toHaveLength(1);
  });

  it("allows a new goal once the previous one is DONE, alternating the lead", async () => {
    const h = harness();
    await replay(h);
    h.clock.set("2026-10-26T09:00:00Z");
    const next = await h.human.kickoff(INPUT);
    ok(next);
    expect(next.goal_id).toBe("20261026-add-per-api-key-rate-limiting-to-the-pub");
    expect(next.lead).toBe("codex");
    expect(h.human.listGoals().map((goal) => goal.goalId)).toEqual(["20261025-rate-limit", next.goal_id]);
    expect(h.human.activeGoal()?.goalId).toBe(next.goal_id);
  });

  it("derives the slug from the goal text and honours slug and goal_id overrides", async () => {
    expect(slugify("Add per-API-key rate limiting to the public API.")).toBe("add-per-api-key-rate-limiting-to-the-pub");
    expect(slugify("  Hello,   World!! ")).toBe("hello-world");
    expect(slugify("!!!")).toBe("goal");
    expect(slugify(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
    expect(slugify("Ship v2.0")).toBe("ship-v2-0");
    const h = harness();
    expect((await h.human.kickoff({ ...INPUT, goal_id: "bad id" })).ok).toBe(false);
    expect((await h.human.kickoff({ ...INPUT, goal_id: "bad id" }))).toMatchObject({ rule: "SCHEMA" });
    const custom = await h.human.kickoff({ ...INPUT, goal_id: "20261001-custom" });
    ok(custom);
    expect(custom.goal_id).toBe("20261001-custom");
  });

  it("a PM kicking off becomes the lead; naming another lead is ROLE_GATE; word caps apply", async () => {
    const h = harness();
    expect(await h.codex.kickoff({ ...INPUT, lead: "claude" })).toMatchObject({ ok: false, rule: "ROLE_GATE" });
    expect(await h.codex.kickoff({ ...INPUT, acceptance_criteria: [] })).toMatchObject({ ok: false, rule: "SCHEMA" });
    expect(await h.codex.kickoff({ ...INPUT, acceptance_criteria: [Array.from({ length: 41 }, () => "w").join(" ")] })).toMatchObject({ ok: false, rule: "WORD_CAP" });
    expect(await h.codex.kickoff({ ...INPUT, goal: Array.from({ length: 121 }, () => "w").join(" ") })).toMatchObject({ ok: false, rule: "WORD_CAP" });
    expect(h.codex.listGoals()).toEqual([]);
    const result = await h.codex.kickoff(INPUT);
    ok(result);
    expect(result).toMatchObject({ lead: "codex", challenger: "claude", kickoff_id: "20261025T140000Z-0001-codex-KICKOFF" });
    expect(parseKickoffFile(h.file("kickoff.md", result.goal_id)).by).toBe("codex");
    expect(listFiles(h.goalDir(result.goal_id)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rejects with SCHEMA a goal or criterion that would not round-trip through kickoff.md: line breaks, or a goal shaped like an AC line", async () => {
    const h = harness();
    const injected = { goal: "Real goal text\n- AC1: injected criterion", acceptance_criteria: ["the only real criterion"], slug: "inj" };
    expect(await h.human.kickoff(injected)).toMatchObject({ ok: false, rule: "SCHEMA", message: expect.stringMatching(/^Field "goal": must be a single line/) });
    expect(await h.human.kickoff({ ...INPUT, goal: "Line one.\r\nLine two." })).toMatchObject({ ok: false, rule: "SCHEMA" });
    expect(await h.human.kickoff({ ...INPUT, goal: "- AC1: a goal shaped like a criterion" })).toMatchObject({
      ok: false,
      rule: "SCHEMA",
      message: expect.stringContaining("must not start with `- AC<n>: `"),
    });
    expect(await h.human.kickoff({ ...INPUT, acceptance_criteria: ["First line\nsecond line."] })).toMatchObject({
      ok: false,
      rule: "SCHEMA",
      message: expect.stringMatching(/^Field "acceptance_criteria.0": must be a single line/),
    });
    expect(await h.claude.kickoff({ ...INPUT, acceptance_criteria: ["Fine.", "Has a\r\nbreak."] })).toMatchObject({ ok: false, rule: "SCHEMA", message: expect.stringContaining('"acceptance_criteria.1"') });
    expect(h.human.listGoals()).toEqual([]);
    expect(existsSync(h.goalDir("20261025-inj"))).toBe(false);
    // Edge whitespace is trimmed before the check, as it is before writing.
    const result = await h.human.kickoff({ ...INPUT, goal: `${INPUT.goal}\n`, acceptance_criteria: ["Requests over the limit get 429.\n", " Limit is configurable."] });
    ok(result);
    expect(h.human.readKickoff()).toMatchObject({ goal_text: INPUT.goal, acceptance_criteria: INPUT.acceptance_criteria });
  });
});

// ---------------------------------------------------------------------------
// read and waitForReply
// ---------------------------------------------------------------------------

describe("read and waitForReply", () => {
  it("read returns messages after the cursor, excludes own messages, and advances the cursor", async () => {
    const h = harness();
    expect(h.codex.read()).toBeNull();
    await replay(h, 2);
    const first = h.codex.read();
    expect(first?.messages.map((message) => message.type)).toEqual(["KICKOFF", "PROPOSE"]);
    expect(first).toMatchObject({ goal: "20261025-rate-limit", phase: "PLAN", role: "challenger", lead: "claude", challenger: "codex", cursor: RUN[1].id });
    expect(first?.allowed_types).toEqual(["PROPOSE", "CHALLENGE", "STATUS", "BLOCKED"]);
    expect(first?.budgets.used.messages_total).toBe(1);
    expect(h.codex.read()?.messages).toEqual([]);
    expect(JSON.parse(h.file("inbox/codex.json"))).toMatchObject({ protocol_version: 1, agent: "codex", cursor: RUN[1].id });
    const own = h.claude.read();
    expect(own?.messages.map((message) => message.type)).toEqual(["KICKOFF"]);
    expect(own?.role).toBe("lead");
    expect(h.human.read()?.role).toBe("human");
    expect(h.codex.read({ since: null as unknown as string })?.messages).toHaveLength(0);
  });

  it("waitForReply resolves within one poll after the other agent posts", async () => {
    const h = harness();
    await replay(h, 1);
    h.codex.read();
    const waiting = h.codex.waitForReply({ timeoutMs: 5_000 });
    await realSleep(50);
    h.clock.advance(1_000);
    ok(await h.claude.post(toDraft(RUN[1])));
    const result = await waiting;
    if ("timeout" in result) throw new Error("timed out");
    expect(result.messages.map((message) => message.type)).toEqual(["PROPOSE"]);
    expect(result.cursor).toBe(result.messages[0].id);
  });

  it("times out at the 110 s hard cap and reports progress every 15 s", async () => {
    const h = harness();
    await replay(h, 2);
    h.codex.read();
    const onProgress = vi.fn();
    const waiting = h.codex.waitForReply({ timeoutMs: 999_999, onProgress });
    await realSleep(40);
    h.clock.advance(PROGRESS_MS);
    await realSleep(40);
    h.clock.advance(PROGRESS_MS);
    await realSleep(40);
    expect(onProgress.mock.calls).toEqual([[{ elapsedMs: 15_000, phase: "PLAN" }], [{ elapsedMs: 30_000, phase: "PLAN" }]]);
    h.clock.advance(MAX_WAIT_MS);
    expect(await waiting).toEqual({ timeout: true });
  });

  it("a tick-driven DEADLOCK posts a system ASK_HUMAN and renders the deadlock question", async () => {
    const h = harness();
    await replay(h, 5);
    expect(RUN[4].type).toBe("CHALLENGE");
    h.claude.read();
    h.clock.set("2026-10-25T14:14:55Z");
    const result = await h.claude.waitForReply({ timeoutMs: 5_000 });
    if ("timeout" in result) throw new Error("timed out");
    expect(result.messages).toHaveLength(1);
    const ask = result.messages[0];
    expect(ask).toMatchObject({
      id: "20261025T141455Z-0001-system-ASK_HUMAN",
      from: "system",
      to: "human",
      type: "ASK_HUMAN",
      re: ["AC1"],
      reply_to: RUN[4].id,
      decision_id: "plan",
      phase: "BLOCKED",
    });
    expect(result.phase).toBe("BLOCKED");
    expect(existsSync(join(h.goalDir(), "chat", `${ask.id}.md`))).toBe(true);
    expect(h.claude.state()).toMatchObject({ phase: "BLOCKED", blocked_from: "PLAN", deadlock_watch: { decision_id: "plan", remaining: 2 } });
    const goal = h.file("goal.md");
    expect(goal).toContain("> [!WARNING]\n> **Human needed** since 14:14:55 UTC (10:14 local). The run is BLOCKED (from PLAN); nothing moves until you answer.\n>\n");
    expect(goal).toContain("> **Deadlock on plan, re AC1.** claude did not DECIDE within 2 messages or 10 minutes. The two positions:\n>\n");
    expect(goal).toContain("> 1. claude PROPOSE 14:02:10: *A token-bucket middleware keyed by API key in the existing Redis client satisfies AC1 and AC2.*\n");
    expect(goal).toContain("> 2. codex CHALLENGE 14:04:55: *An in-process bucket meets AC1 with no network hop if the API runs as one replica.* (test `kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1` · pending)\n>\n");
    expect(goal).toContain('> **To answer:** run `diarchy reply "<ruling>" --decision plan`. Your ruling closes plan as a DECIDE with basis human and PLAN resumes. `diarchy stop` ends the run.\n');
    expect(goal).toContain("| BLOCKED | claude | codex | 2026-10-25 14:14:55 UTC |");
    const chat = h.file("chat.md");
    expect(chat).toContain("> [!WARNING]\n> **BLOCKED** from PLAN · **human needed** since 14:14:55 UTC · lead claude · challenger codex\n");
    expect(chat).toContain("---\n\n## → BLOCKED · 14:14:55\n\n⚑ **system → human · ASK_HUMAN · plan · re AC1 · 14:14:55**\n\nreplying to codex CHALLENGE 14:04:55\n\n");
    expect(chat).toContain("> 2026-10-25 · last 14:14:55 UTC (10:14 local) · system ASK_HUMAN: Lead did not DECIDE plan within 2 messages or 10 minutes. Goal BLOCKED; human\u2026\n");
    expect(h.codex.read()?.messages.map((message) => message.type)).toEqual(["KICKOFF", "PROPOSE", "DECIDE", "PROPOSE", "ASK_HUMAN"]);
  });

  it("the tick also runs on post, so a late message meets the deadlock instead of landing", async () => {
    const h = harness();
    await replay(h, 5);
    h.clock.set("2026-10-25T14:20:00Z");
    const result = await h.codex.post({ type: "STATUS", to: "all", re: ["AC1"], evidence: [{ kind: "file", path: "docs/replicas.md" }], body: "Replica count written to docs/replicas.md for the record." });
    expect(result).toMatchObject({ ok: false, rule: "PHASE_GATE" });
    expect(h.codex.state()?.phase).toBe("BLOCKED");
    expect(readdirSync(join(h.goalDir(), "chat")).some((name) => name.endsWith("-system-ASK_HUMAN.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reply and stop as human
// ---------------------------------------------------------------------------

describe("reply and stop as human", () => {
  it("reply posts a human DECIDE with the next D<n>, replying to the ASK_HUMAN, and resumes the blocked phase", async () => {
    const h = harness();
    await replay(h, BLOCKED_INDEX);
    h.clock.set("2026-10-25T14:52:10Z");
    const result = await h.human.reply("Read REDIS_URL from .env.staging in the project root.", { body: "Added just now." });
    ok(result);
    expect(result).toMatchObject({ id: "20261025T145210Z-0002-human-DECIDE", decision_id: "D2", phase: "EXECUTE" });
    const message = parseMessageFile(h.file(`chat/${result.id}.md`));
    expect(message).toMatchObject({ basis: "human", decision_id: "D2", re: ["AC1"], reply_to: "20261025T143501Z-0001-system-ASK_HUMAN" });
    expect(h.human.state()).toMatchObject({ phase: "EXECUTE", blocked_from: null, decisions: { D2: { status: "decided", proposer: "human" } } });
    expect(h.file("decisions.md")).toContain("| D2 | [14:52:10](chat/20261025T145210Z-0002-human-DECIDE.md) | human | Read REDIS_URL from .env.staging in the project root. | human | | |");
    expect(h.file("chat.md")).toContain("## → EXECUTE · 14:52:10");
    expect(h.file("goal.md")).not.toContain("[!WARNING]");
  });

  it("reply --decision closes the deadlocked thread and --budget raises a limit", async () => {
    const h = harness();
    await replay(h, 5);
    h.clock.set("2026-10-25T14:14:55Z");
    await h.claude.waitForReply({ timeoutMs: 1_000 });
    expect(h.human.state()?.phase).toBe("BLOCKED");
    h.clock.set("2026-10-25T14:30:00Z");
    const result = await h.human.reply("Use the Redis-backed bucket.", { decision: "plan", budgets: { messages_total: 160 } });
    ok(result);
    expect(result.decision_id).toBe("plan");
    expect(h.human.state()).toMatchObject({ phase: "EXECUTE", limits: { messages_total: 160 }, decisions: { plan: { status: "decided" } }, deadlock_watch: null });
    const chat = h.file("chat.md");
    expect(chat).toContain("basis: human · replying to system ASK_HUMAN 14:14:55 · budgets: messages_total 160");
    expect(chat).toContain("## → EXECUTE · 14:30:00");
  });

  it("reply --decision on a decided thread supersedes it", async () => {
    const h = harness();
    await replay(h, 18);
    expect(RUN[17].decision_id).toBe("D3");
    h.clock.set("2026-10-25T16:00:00Z");
    ok(await h.human.stop("Pausing before the default changes again."));
    h.clock.set("2026-10-25T16:01:00Z");
    const result = await h.human.reply("Keep the default at 300.", { decision: "D3" });
    ok(result);
    expect(result.decision_id).toBe("D4");
    const message = parseMessageFile(h.file(`chat/${result.id}.md`));
    expect(message.supersedes).toBe("D3");
    expect(h.human.state()).toMatchObject({ phase: "EXECUTE", decisions: { D3: { status: "superseded", superseded_by: "D4" } } });
    expect(h.file("decisions.md")).toContain("| ~~D3~~ |");
    expect(h.file("decisions.md")).toContain("| D4 | [16:01:00](chat/20261025T160100Z-0004-human-DECIDE.md) | human | Keep the default at 300. | human | | D3 |");
  });

  it("stop leaves the goal BLOCKED with a human BLOCKED message and shows the reason", async () => {
    const h = harness();
    await replay(h, BLOCKED_INDEX + 2);
    expect(h.human.state()?.phase).toBe("EXECUTE");
    h.clock.set("2026-10-25T15:20:00Z");
    const result = await h.human.stop("Out of time for today.");
    ok(result);
    expect(result).toMatchObject({ id: "20261025T152000Z-0003-human-BLOCKED", phase: "BLOCKED" });
    expect(h.human.state()).toMatchObject({ phase: "BLOCKED", blocked_from: "EXECUTE", updated: "2026-10-25T15:20:00Z" });
    expect(parseMessageFile(h.file(`chat/${result.id}.md`))).toMatchObject({ from: "human", type: "BLOCKED", kind: "external", phase: "EXECUTE", re: ["AC1", "AC2", "AC3"] });
    const goal = h.file("goal.md");
    expect(goal).toContain("> **Human needed** since 15:20:00 UTC (11:20 local). The run is BLOCKED (from EXECUTE); nothing moves until you answer.\n>\n> **human is blocked (external), re AC1, AC2, AC3:**\n>\n> > Out of time for today.\n>\n> **To answer:**");
    const chat = h.file("chat.md");
    expect(chat).toContain("✕ **human → all · BLOCKED · re AC1, AC2, AC3 · 15:20:00**\n\nkind: external · the human is paged\n\nOut of time for today.\n");
    expect(chat.trimEnd().endsWith("## → BLOCKED · 15:20:00")).toBe(true);
    expect(h.claude.read()?.allowed_types).toEqual([]);
    h.clock.advance(1_000);
    ok(await h.human.stop("Still stopped."));
    expect(h.human.state()).toMatchObject({ phase: "BLOCKED", blocked_from: "EXECUTE" });
    expect(await h.human.stop("   ")).toMatchObject({ ok: false, rule: "SCHEMA" });
  });

  it("stop is rejected after DONE; reply and stop throw for agent stores", async () => {
    const h = harness();
    await replay(h);
    expect(await h.human.stop("Too late.")).toMatchObject({ ok: false, rule: "PHASE_GATE" });
    await expect(h.claude.reply("No.")).rejects.toThrow(/human/);
    await expect(h.codex.stop("No.")).rejects.toThrow(/human/);
    expect(await h.human.reply("Still not allowed.")).toMatchObject({ ok: false, rule: "PHASE_GATE" });
  });

  it("stop and reply survive a kickoff.md that will not parse or is missing, so the human can retire a wedged goal", async () => {
    const h = harness();
    ok(await h.human.kickoff({ goal: "Real goal text.", acceptance_criteria: ["The only real criterion."], slug: "inj" }));
    // A hand-edited file: a second AC1 line in the criteria block.
    const path = join(h.goalDir("20261025-inj"), "kickoff.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("- AC1:", "- AC1: injected criterion\n- AC1:"));
    expect(() => parseKickoffFile(h.file("kickoff.md", "20261025-inj"))).toThrowError(/AC1 is out of order/);
    h.clock.advance(60_000);
    const propose: MessageDraft = { type: "PROPOSE", to: "all", re: ["AC1"], decision_id: "plan", claim: "One step does it.", body: "Nothing to split." };
    await expect(h.claude.post(propose)).rejects.toThrowError(/AC1 is out of order/);
    h.clock.advance(60_000);
    const stopped = await h.human.stop("Retiring the wedged goal.");
    ok(stopped);
    expect(h.human.state()).toMatchObject({ phase: "BLOCKED", blocked_from: "PLAN" });
    const goal = h.file("goal.md", "20261025-inj");
    expect(goal).toContain("# 20261025-inj\n\n> [!WARNING]");
    expect(goal).toContain("\nReal goal text.\n");
    expect(goal).toContain("| AC1 | The only real criterion. | open |");
    h.clock.advance(60_000);
    const replied = await h.human.reply("Carry on with the plan.");
    ok(replied);
    expect(h.human.state()).toMatchObject({ phase: "PLAN", blocked_from: null });
    expect(h.file("chat.md", "20261025-inj")).toContain("# Chat: 20261025-inj");
    rmSync(path);
    h.clock.advance(60_000);
    ok(await h.human.stop("Even without kickoff.md."));
    expect(h.human.state()).toMatchObject({ phase: "BLOCKED", blocked_from: "PLAN" });
    expect(h.file("goal.md", "20261025-inj")).toContain("\nReal goal text.\n");
  });

  it("budget exhaustion blocks with the budget question and reply --budget resumes", async () => {
    const h = harness();
    ok(await h.human.kickoff({ goal: "Tiny goal.", acceptance_criteria: ["Done."], lead: "claude", slug: "tiny", budgets: { messages_total: 2 } }));
    h.clock.advance(60_000);
    ok(await h.claude.post({ type: "PROPOSE", to: "all", re: ["AC1"], decision_id: "plan", claim: "One step does it.", body: "Nothing to split." }));
    h.clock.advance(60_000);
    const decide = await h.claude.post({ type: "DECIDE", to: "all", re: ["AC1"], decision_id: "plan", basis: "authority", claim: "One step does it.", tasks: ["Do it"], body: "No test exists before the work." });
    ok(decide);
    expect(decide.phase).toBe("BLOCKED");
    const goal = h.file("goal.md", "20261025-tiny");
    expect(goal).toContain("> **Budget reached:** messages_total 2 of 2. Both agents are stopped.\n>\n");
    expect(goal).toContain('> **To answer:** run `diarchy reply "continue" --budget messages_total=4` to raise the limit and resume EXECUTE, or `diarchy stop` to end the run.\n');
    const chat = h.file("chat.md", "20261025-tiny");
    expect(chat).toContain("⚑ **system → human · ASK_HUMAN · re AC1 · 14:02:01**\n\nbudget: messages_total 2 of 2\n\n");
    expect(chat).toContain("---\n\n## → EXECUTE · 14:02:00\n\n## → BLOCKED · 14:02:01\n\n⚑");
    h.clock.advance(60_000);
    ok(await h.human.reply("continue", { budgets: { messages_total: 10 } }));
    expect(h.human.state()).toMatchObject({ phase: "EXECUTE", limits: { messages_total: 10 } });
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("config", () => {
  it("loadConfig defaults the vault to '<basename> brain/diarchy' and merges diarchy.config.json", () => {
    const root = mkdtempSync(join(tmpdir(), "diarchy-config-"));
    temps.push(root);
    const projectDir = join(root, "my-app");
    mkdirSync(projectDir);
    expect(defaultVault(projectDir)).toBe(join("my-app brain", "diarchy"));
    const defaults = loadConfig(projectDir);
    expect(defaults).toEqual({
      protocol_version: 1,
      vault: join("my-app brain", "diarchy"),
      agents: { claude: { command: "claude" }, codex: { command: "codex" } },
      budgets: {},
      worktrees: { root: ".diarchy/worktrees", branch_prefix: "diarchy" },
      review: { required: true },
    });
    writeFileSync(join(projectDir, "diarchy.config.json"), JSON.stringify({ protocol_version: 1, vault: "notes/diarchy", budgets: { plan_messages: 6 }, review: { required: false } }));
    const loaded = loadConfig(projectDir);
    expect(loaded).toMatchObject({ vault: "notes/diarchy", budgets: { plan_messages: 6 }, review: { required: false }, agents: { claude: { command: "claude" } } });
    writeFileSync(join(projectDir, "diarchy.config.json"), JSON.stringify({ protocol_version: 2 }));
    expect(() => loadConfig(projectDir)).toThrow();
  });

  it("resolveVaultPaths lays out the goal directory under the vault", () => {
    const paths = resolveVaultPaths("/work/api", CONFIG, "20261025-rate-limit");
    const goal = "/work/api/api brain/diarchy/goals/20261025-rate-limit";
    expect(paths).toMatchObject({
      vault: "/work/api/api brain/diarchy",
      goals: "/work/api/api brain/diarchy/goals",
      goalId: "20261025-rate-limit",
      goal,
      kickoff: `${goal}/kickoff.md`,
      goalMd: `${goal}/goal.md`,
      chatDir: `${goal}/chat`,
      chatMd: `${goal}/chat.md`,
      decisionsMd: `${goal}/decisions.md`,
      budget: `${goal}/budget.json`,
      inboxDir: `${goal}/inbox`,
      lock: `${goal}/.lock`,
    });
    expect(paths.inbox("codex")).toBe(`${goal}/inbox/codex.json`);
  });
});
