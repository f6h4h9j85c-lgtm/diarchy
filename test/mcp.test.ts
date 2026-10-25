import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  ErrorCode,
  LoggingMessageNotificationSchema,
  type JSONRPCMessage,
  type Progress,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SERVER_ERRORS, TOOL_NAMES, createMcpServer } from "../src/mcp/index.js";
import { RULE_IDS } from "../src/protocol/index.js";
import {
  CONFIG_FILENAME,
  GENERATED,
  MAX_WAIT_MS,
  PROGRESS_MS,
  VaultStore,
  loadConfig,
  resolveVaultPaths,
  type KickoffOk,
  type PostOk,
  type ReadResult,
} from "../src/vault/index.js";
import { ASSIGN_KINDS, BLOCKED_KINDS, DECISION_BASES, MESSAGE_TYPES, STATUS_TASK_STATUSES } from "../src/protocol/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STDIO_SERVER = fileURLToPath(new URL("./fixtures/mcp/stdio-server.ts", import.meta.url));
const T0 = "2026-10-25T14:00:00Z";
const POLL_MS = 10;
const GOAL_ID = "20261025-rate-limit";
const GOAL = "Add per-API-key rate limiting to the public API.";
const ACS = ["Requests over the limit get 429.", "The limit is configurable by env.", "The full suite is green."];
const KICKOFF_ARGS = { goal: GOAL, acceptance_criteria: ACS, slug: "rate-limit" };
const PR = "https://github.com/acme/api/pull/412";
const SORTED_TOOLS = [...TOOL_NAMES].sort();
const NO_GOAL = { ok: false, rule: "NO_GOAL", message: "No goal in this vault. Call kickoff first." };
const PLAN_PROPOSAL = {
  type: "PROPOSE",
  decision_id: "plan",
  claim: "A token-bucket middleware keyed by API key in Redis satisfies AC1 and AC2.",
  body: "Three tasks: middleware, env-driven limit, tests. Redis so all replicas share one counter.",
};
const PROPOSE = { ...PLAN_PROPOSAL, re: ["AC1", "AC2"] };

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

  advance(ms: number): void {
    this.ms += ms;
  }
}

// ---------------------------------------------------------------------------
// Harness: two servers (claude, codex) on one vault, each behind an in-memory client
// ---------------------------------------------------------------------------

const temps: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(agents: string[] = ["claude", "codex"]): string {
  const root = mkdtempSync(join(tmpdir(), "diarchy-mcp-"));
  temps.push(root);
  const projectDir = join(root, "api");
  mkdirSync(projectDir);
  const config = {
    protocol_version: 1,
    vault: "api brain/diarchy",
    agents: Object.fromEntries(agents.map((agent) => [agent, { command: agent }])),
  };
  writeFileSync(join(projectDir, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`);
  return projectDir;
}

async function connect(projectDir: string, agent: string, clock: FakeClock | null): Promise<Client> {
  const store = new VaultStore({
    projectDir,
    config: loadConfig(projectDir),
    agent,
    pollIntervalMs: POLL_MS,
    ...(clock === null ? {} : { now: clock.now, sleep: clock.sleep }),
  });
  const server = createMcpServer({ projectDir, agent, store });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: `test-${agent}`, version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

interface Harness {
  projectDir: string;
  clock: FakeClock;
  claude: Client;
  codex: Client;
  kickoff(): Promise<KickoffOk>;
}

async function harness(options: { realClock?: boolean } = {}): Promise<Harness> {
  const projectDir = tempProject();
  const clock = new FakeClock(T0);
  const shared = options.realClock ? null : clock;
  const claude = await connect(projectDir, "claude", shared);
  const codex = await connect(projectDir, "codex", shared);
  return { projectDir, clock, claude, codex, kickoff: () => accepted<KickoffOk>(claude, "kickoff", KICKOFF_ARGS) };
}

interface ToolCall<T> {
  isError: boolean;
  body: T;
}

interface ErrorBody {
  ok: false;
  rule: string;
  message: string;
}

/** Call a tool; the text content and structuredContent must carry the same JSON. */
async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}, options?: RequestOptions): Promise<ToolCall<T>> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, options));
  const [first] = result.content;
  if (first?.type !== "text") throw new Error(`${name}: expected text content`);
  const body = JSON.parse(first.text) as T;
  expect(result.structuredContent).toEqual(body);
  return { isError: result.isError === true, body };
}

async function accepted<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { isError, body } = await call<T>(client, name, args);
  if (isError) throw new Error(`${name} rejected: ${JSON.stringify(body)}`);
  return body;
}

async function rejected(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ErrorBody> {
  const { isError, body } = await call<ErrorBody>(client, name, args);
  expect(isError, `${name} should set isError`).toBe(true);
  expect(body.ok).toBe(false);
  return body;
}

function resourceText(result: ReadResourceResult): string {
  const [first] = result.contents;
  if (first === undefined || !("text" in first)) throw new Error("expected text contents");
  return first.text;
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  it("lists exactly the seven tools, each with an object input schema and a description", async () => {
    const h = await harness();
    const { tools } = await h.claude.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(SORTED_TOOLS);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(Object.keys(tool.inputSchema.properties ?? {}).length, tool.name).toBeGreaterThan(0);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(0);
      expect(tool.description, tool.name).not.toContain("—");
    }
  });

  it("the read description and the PROTOCOL.md section 10 read row name goal_text and acs", async () => {
    const h = await harness();
    const { tools } = await h.claude.listTools();
    const read = tools.find((tool) => tool.name === "read");
    const row = readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| read |"));
    for (const field of ["goal_text", "acs"]) {
      expect(read?.description, field).toContain(field);
      expect(row, field).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL.md section 10 is the wire contract: parsed so the doc and the server cannot drift
// ---------------------------------------------------------------------------

const PROTOCOL = readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8");
const SECTION_10 = PROTOCOL.slice(PROTOCOL.indexOf("## 10. MCP tools"), PROTOCOL.indexOf("## 11."));

function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

const TOOL_ROWS = new Map(tableRows(SECTION_10).filter(([name]) => (TOOL_NAMES as readonly string[]).includes(name)).map((cells) => [cells[0], cells]));
const CODE_ROWS = tableRows(SECTION_10).filter((cells) => cells.length === 3 && /^[A-Z_]+$/.test(cells[0]));

interface Shape {
  required: string[];
  optional: string[];
}

/** `name: type; other?: type` or `{ a, b: { c }, d? }`: top-level names, `?` marking the optional ones. */
function fields(list: string, separator: string): Shape {
  const shape: Shape = { required: [], optional: [] };
  for (const part of list.split(separator)) {
    const match = /^\s*([a-z_]+)(\?)?/.exec(part);
    if (match === null) throw new Error(`no field name in "${part}"`);
    (match[2] === "?" ? shape.optional : shape.required).push(match[1]);
  }
  return shape;
}

function documentedShape(pattern: RegExp): Shape {
  const match = pattern.exec(SECTION_10);
  if (match === null) throw new Error(`PROTOCOL.md section 10 has no shape matching ${pattern.source}`);
  let inner = match[1].trim().replace(/^\{|\}$/g, "");
  while (/\{[^{}]*\}/.test(inner)) inner = inner.replace(/\{[^{}]*\}/g, "");
  return fields(inner, ",");
}

function expectShape(result: object, shape: Shape, label: string): void {
  const keys = Object.keys(result);
  for (const key of shape.required) expect(keys, `${label} has ${key}`).toContain(key);
  for (const key of keys) expect([...shape.required, ...shape.optional], `${label} documents ${key}`).toContain(key);
}

describe("PROTOCOL.md section 10", () => {
  it("documents each tool's input fields exactly, with ? on the optional ones", async () => {
    const h = await harness();
    const { tools } = await h.claude.listTools();
    expect([...TOOL_ROWS.keys()].sort()).toEqual(SORTED_TOOLS);
    for (const tool of tools) {
      const row = TOOL_ROWS.get(tool.name) ?? [];
      const doc = fields(row[1] ?? "", ";");
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      const required = tool.inputSchema.required ?? [];
      expect([...doc.required, ...doc.optional].sort(), tool.name).toEqual([...properties].sort());
      expect([...doc.required].sort(), `${tool.name} required`).toEqual([...required].sort());
    }
  });

  it("lists the server codes with the server's messages, and every typical error is a known code", async () => {
    expect(CODE_ROWS.map(([code]) => code).sort()).toEqual([...SERVER_ERRORS].sort());
    const message = (code: string): string => CODE_ROWS.find(([name]) => name === code)?.[2] ?? "";
    expect(message("NO_GOAL")).toBe(NO_GOAL.message);
    const h = await harness();
    await h.kickoff();
    const wrong = await rejected(h.claude, "post", { ...PROPOSE, type: "DECIDE" });
    expect(wrong.rule).toBe("WRONG_TOOL");
    const template = message("WRONG_TOOL").split(/\{[a-z_]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    expect(wrong.message).toMatch(new RegExp(`^${template.join(".+?")}$`));

    const known = new Set<string>([...RULE_IDS, ...SERVER_ERRORS]);
    for (const [name, , , errors] of TOOL_ROWS.values()) {
      for (const code of errors.split(",").map((part) => part.trim())) {
        if (code !== "any rule") expect(known.has(code), `${name} lists ${code}`).toBe(true);
      }
    }
    // TWO_ROUNDS gates only PROPOSE and CHALLENGE (rules.ts twoRounds); the happy path decides after both.
    expect(TOOL_ROWS.get("decide")?.[3]).not.toContain("TWO_ROUNDS");
  });

  it("posting and read results carry exactly the documented keys", async () => {
    const posting = documentedShape(/answers `(\{ ok: true[^`]*\})`/);
    const kickoffExtras = fields(/`kickoff` adds `([^`]+)`/.exec(SECTION_10)?.[1] ?? "", ",");
    const read = documentedShape(/`read` answers `(\{[^`]*\})`/);
    expect(read.required).not.toContain("ok");

    const h = await harness();
    const kick = await h.kickoff();
    expectShape(kick, { required: [...posting.required, ...kickoffExtras.required], optional: posting.optional }, "kickoff");
    expectShape(await accepted(h.claude, "post", PROPOSE), posting, "post");
    expectShape(await accepted(h.codex, "read"), read, "read");
    await accepted(h.claude, "status", { re: ["AC1"], evidence: [{ kind: "file", path: "docs/plan.md" }], body: "Plan notes written down." });
    expectShape(await accepted(h.codex, "wait_for_reply", { timeout_ms: 1_000 }), read, "wait_for_reply");
  });
});

// ---------------------------------------------------------------------------
// kickoff and read
// ---------------------------------------------------------------------------

describe("kickoff and read", () => {
  it("the caller becomes lead; the other agent reads challenger, PLAN, and the KICKOFF; a second kickoff is SINGLE_KICKOFF", async () => {
    const h = await harness();
    const kick = await h.kickoff();
    expect(kick).toMatchObject({ ok: true, goal_id: GOAL_ID, lead: "claude", challenger: "codex", phase: "PLAN" });
    expect(kick.allowed_types).toEqual(["PROPOSE", "STATUS", "BLOCKED"]);
    expect(kick.kickoff_id).toBe(kick.id);

    const read = await accepted<ReadResult>(h.codex, "read");
    expect(read).toMatchObject({ goal: GOAL_ID, phase: "PLAN", role: "challenger", lead: "claude", challenger: "codex", cursor: kick.id });
    expect(read.allowed_types).toEqual(["PROPOSE", "CHALLENGE", "STATUS", "BLOCKED"]);
    expect(read.messages.map((message) => message.type)).toEqual(["KICKOFF"]);
    expect(read.messages[0]).toMatchObject({ id: kick.id, from: "claude", to: "all", re: ["AC1", "AC2", "AC3"], body: `${GOAL}\n` });
    expect((await accepted<ReadResult>(h.codex, "read")).messages).toEqual([]);

    const again = await rejected(h.claude, "kickoff", KICKOFF_ARGS);
    expect(again).toEqual({ ok: false, rule: "SINGLE_KICKOFF", message: `Goal ${GOAL_ID} is already active (phase PLAN). Call read instead of kickoff.` });
    const asCodex = await rejected(h.codex, "kickoff", KICKOFF_ARGS);
    expect(asCodex.rule).toBe("SINGLE_KICKOFF");
  });

  it("read and wait_for_reply carry the goal text and every AC with its criterion and live status, ac_add included", async () => {
    const h = await harness();
    await h.kickoff();
    const read = await accepted<ReadResult>(h.codex, "read");
    expect(read.goal_text).toBe(GOAL);
    expect(read.acs).toEqual(Object.fromEntries(ACS.map((criterion, index) => [`AC${index + 1}`, { criterion, status: "open" }])));

    await accepted<PostOk>(h.claude, "post", PROPOSE);
    await accepted<PostOk>(h.claude, "decide", {
      claim: "A token-bucket middleware keyed by API key satisfies AC1 and AC2.",
      re: ["AC1", "AC2", "AC3"],
      basis: "authority",
      decision_id: "plan",
      tasks: ["Token-bucket middleware", "Env-driven limit", "Tests"],
      ac_add: ["Responses carry X-RateLimit-Remaining."],
      body: "No challenge arrived and there is nothing to test before code exists.",
    });
    await accepted<ReadResult>(h.codex, "read");
    const waiting = call<ReadResult>(h.codex, "wait_for_reply", { timeout_ms: 5_000 });
    await realSleep(50);
    await accepted<PostOk>(h.claude, "status", { re: ["AC1"], evidence: [{ kind: "test", test: "npm test -- rate-limit", result: "pass" }] });
    const { body } = await waiting;
    expect(body.goal_text).toBe(GOAL);
    expect(body.acs).toEqual({
      AC1: { criterion: ACS[0], status: "passing" },
      AC2: { criterion: ACS[1], status: "open" },
      AC3: { criterion: ACS[2], status: "open" },
      AC4: { criterion: "Responses carry X-RateLimit-Remaining.", status: "open" },
    });
  });

  it("a second live server for the same agent gets AGENT_BUSY and takes nothing until the first one closes", async () => {
    const h = await harness();
    const kick = await h.kickoff();
    expect((await accepted<ReadResult>(h.codex, "read")).messages.map((message) => message.id)).toEqual([kick.kickoff_id]);
    const second = await connect(h.projectDir, "codex", h.clock);
    const busy = await rejected(second, "read");
    expect(busy).toEqual({
      ok: false,
      rule: "AGENT_BUSY",
      message: `Another diarchy server already acts as codex on this goal (pid ${process.pid}). One session per agent: end that session, or stop here; this server takes over once that one exits.`,
    });
    // PROTOCOL.md section 10 quotes the same message.
    const spec = /rule: "AGENT_BUSY", message: "([^"]+)"/.exec(readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8"))?.[1];
    expect(spec?.replace("<agent>", "codex").replace("<pid>", String(process.pid))).toBe(busy.message);
    expect((await rejected(second, "status", { re: ["AC1"], evidence: [{ kind: "commit", sha: "abcdef1" }] })).rule).toBe("AGENT_BUSY");
    expect((await rejected(second, "wait_for_reply", { timeout_ms: 100 })).rule).toBe("AGENT_BUSY");

    // The lead's PROPOSE reaches the server that holds the goal; the second one cannot take it.
    const propose = await accepted<PostOk>(h.claude, "post", PROPOSE);
    expect((await rejected(second, "read")).rule).toBe("AGENT_BUSY");
    expect((await accepted<ReadResult>(h.codex, "read")).messages.map((message) => message.id)).toEqual([propose.id]);

    // Once the holder closes, the next server takes over with the same cursor.
    await h.codex.close();
    const takeover = await accepted<ReadResult>(second, "read");
    expect(takeover).toMatchObject({ role: "challenger", messages: [], cursor: propose.id });
    const third = await connect(h.projectDir, "codex", h.clock);
    expect((await rejected(third, "read")).rule).toBe("AGENT_BUSY");
  });

  it("read, wait_for_reply, and post before any kickoff return NO_GOAL instead of throwing", async () => {
    const h = await harness();
    expect(await rejected(h.codex, "read")).toEqual(NO_GOAL);
    expect(await rejected(h.codex, "wait_for_reply", { timeout_ms: 100 })).toEqual(NO_GOAL);
    expect(await rejected(h.claude, "post", PROPOSE)).toEqual(NO_GOAL);
  });

  it("a kickoff that would not round-trip through kickoff.md is SCHEMA, and a vault file that will not parse surfaces as SCHEMA naming the file, not INTERNAL", async () => {
    const h = await harness();
    const multiLine = await rejected(h.claude, "kickoff", { ...KICKOFF_ARGS, goal: "Real goal text\n- AC1: injected criterion" });
    expect(multiLine).toMatchObject({ rule: "SCHEMA", message: expect.stringMatching(/^Field "goal": must be a single line/) });
    const multiLineAc = await rejected(h.claude, "kickoff", { ...KICKOFF_ARGS, acceptance_criteria: ["First line\nsecond line."] });
    expect(multiLineAc).toMatchObject({ rule: "SCHEMA", message: expect.stringContaining('Field "acceptance_criteria.0": must be a single line') });
    expect(await rejected(h.codex, "read")).toEqual(NO_GOAL);
    const kick = await h.kickoff();
    const path = resolveVaultPaths(h.projectDir, loadConfig(h.projectDir), kick.goal_id).kickoff;
    writeFileSync(path, readFileSync(path, "utf8").replace("- AC1:", "- AC1: injected criterion\n- AC1:"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await rejected(h.claude, "post", PROPOSE);
      expect(result).toEqual({
        ok: false,
        rule: "SCHEMA",
        message: `Vault file ${path} is corrupt: Field "body": AC1 is out of order. The vault is damaged, not your draft, so do not retry. Post BLOCKED with kind external naming that file so the human can fix it or run diarchy stop.`,
      });
      expect(result.message).not.toContain("post again");
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0][0]).toContain(`diarchy-mcp: CorruptVaultFileError: Vault file ${path} is corrupt: Field "body": AC1 is out of order`);
    } finally {
      log.mockRestore();
    }
    const blocked = await accepted<PostOk>(h.claude, "post", { type: "BLOCKED", re: ["AC1"], kind: "external", body: `kickoff.md is corrupt: ${path}` });
    expect(blocked.phase).toBe("BLOCKED");
  });

  it("kickoff rejects every Unicode line terminator in the goal or a criterion with SCHEMA, and its input schema says so", async () => {
    const h = await harness();
    const terminators = { CR: "\r", LF: "\n", VT: "\v", FF: "\f", NEL: "\u0085", LS: "\u2028", PS: "\u2029" };
    for (const [name, terminator] of Object.entries(terminators)) {
      const goal = await rejected(h.claude, "kickoff", { ...KICKOFF_ARGS, goal: `Add rate limiting${terminator}to the public API.` });
      expect(goal, name).toMatchObject({ rule: "SCHEMA", message: expect.stringMatching(/^Field "goal": must be a single line/) });
      const criterion = await rejected(h.claude, "kickoff", { ...KICKOFF_ARGS, acceptance_criteria: [ACS[0], `First half${terminator}second half.`] });
      expect(criterion, name).toMatchObject({ rule: "SCHEMA", message: expect.stringMatching(/^Field "acceptance_criteria.1": must be a single line/) });
    }
    expect(await rejected(h.codex, "read")).toEqual(NO_GOAL);
    const { tools } = await h.claude.listTools();
    const properties = tools.find((tool) => tool.name === "kickoff")?.inputSchema.properties as Record<string, { description?: string }> | undefined;
    for (const field of ["goal", "acceptance_criteria"]) {
      expect(properties?.[field]?.description, field).toMatch(/CR, LF, VT, FF, U\+0085, U\+2028, or U\+2029.*\(SCHEMA\)/);
    }
    expect((await h.kickoff()).ok).toBe(true);
  });

  it("a chat file that will not parse surfaces on read as TYPED_ONLY naming the file, and BLOCKED kind external still goes through", async () => {
    const h = await harness();
    const kick = await h.kickoff();
    const chatDir = resolveVaultPaths(h.projectDir, loadConfig(h.projectDir), kick.goal_id).chatDir;
    const corrupt = join(chatDir, readdirSync(chatDir)[0]);
    writeFileSync(corrupt, readFileSync(corrupt, "utf8").replace("type: KICKOFF", "type: HELLO"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await rejected(h.codex, "read")).toEqual({
        ok: false,
        rule: "TYPED_ONLY",
        message: `Vault file ${corrupt} is corrupt: Unknown type "HELLO". The vault is damaged, not your draft, so do not retry. Post BLOCKED with kind external naming that file so the human can fix it or run diarchy stop.`,
      });
    } finally {
      log.mockRestore();
    }
    const blocked = await accepted<PostOk>(h.codex, "post", { type: "BLOCKED", re: ["AC1"], kind: "external", body: `A chat file is corrupt: ${corrupt}` });
    expect(blocked.phase).toBe("BLOCKED");
  });

  it("an unexpected exception becomes INTERNAL and is logged to stderr", async () => {
    const projectDir = tempProject(["claude"]);
    const claude = await connect(projectDir, "claude", null);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await rejected(claude, "kickoff", KICKOFF_ARGS);
      expect(result).toEqual({ ok: false, rule: "INTERNAL", message: "diarchy.config.json must declare at least two agents" });
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0][0]).toContain("diarchy-mcp: Error: diarchy.config.json must declare at least two agents");
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("runs PROPOSE, CHALLENGE, DECIDE, ASSIGN, STATUS, review, DONE through the tools with allowed_types shrinking", async () => {
    const h = await harness();
    await h.kickoff();

    const propose = await accepted<PostOk>(h.claude, "post", PROPOSE);
    expect(propose).toMatchObject({ ok: true, phase: "PLAN", decision_id: "plan" });
    expect(propose.allowed_types).toEqual(["PROPOSE", "DECIDE", "STATUS", "BLOCKED"]);

    const challenge = await accepted<PostOk>(h.codex, "post", {
      type: "CHALLENGE",
      to: "claude",
      re: ["AC1"],
      reply_to: propose.id,
      decision_id: "plan",
      claim: "An in-process bucket meets AC1 with no network hop if the API runs as one replica.",
      evidence: [{ kind: "test", test: "kubectl -n prod get deploy api -o jsonpath='{.spec.replicas}' prints 1", result: "pending" }],
    });
    expect(challenge).toMatchObject({ phase: "PLAN", decision_id: "plan" });

    const decide = await accepted<PostOk>(h.claude, "decide", {
      claim: "An in-process bucket meets AC1 with no network hop if the API runs as one replica.",
      re: ["AC1", "AC2", "AC3"],
      basis: "adopted-challenge",
      decision_id: "plan",
      reply_to: challenge.id,
      tasks: ["Token-bucket middleware, RATE_LIMIT_PER_MIN config, and tests for 429 and the override"],
      body: "The deploy runs one replica, so no shared counter is needed.",
    });
    expect(decide.phase).toBe("EXECUTE");
    expect(decide.allowed_types).toEqual(["STATUS", "ASSIGN", "BLOCKED", "DONE", "DECIDE"]);

    const assign = await accepted<PostOk>(h.claude, "assign", { to: "codex", task: "T1", kind: "implement", reason: "availability", re: ["AC1"] });
    expect(assign.phase).toBe("EXECUTE");
    const inbox = await accepted<ReadResult>(h.codex, "read");
    expect(inbox).toMatchObject({ phase: "EXECUTE", role: "challenger" });
    expect(inbox.allowed_types).toEqual(["STATUS", "BLOCKED", "CHALLENGE"]);
    expect(inbox.messages.map((message) => message.type)).toEqual(["KICKOFF", "PROPOSE", "DECIDE", "ASSIGN"]);
    expect(inbox.messages[3]).toMatchObject({
      to: "codex",
      task: "T1",
      kind: "implement",
      worktree: ".diarchy/worktrees/codex",
      branch: `diarchy/${GOAL_ID}/codex`,
      reason: "availability",
    });

    const status = await accepted<PostOk>(h.codex, "status", {
      re: ["AC1", "AC2", "AC3"],
      task: "T1",
      task_status: "done",
      evidence: [
        { kind: "commit", sha: "9f3c2ab" },
        { kind: "pr", url: PR },
        { kind: "test", test: "npm test", result: "pass" },
      ],
      body: "PR 412 ready for review.",
    });
    expect(status.allowed_types).toEqual(["STATUS", "BLOCKED", "CHALLENGE"]);

    await accepted<PostOk>(h.claude, "assign", { to: "claude", new_task: "Review PR 412", kind: "review", pr: PR, re: ["AC3"] });
    await accepted<PostOk>(h.claude, "status", {
      re: ["AC3"],
      task: "T2",
      task_status: "done",
      evidence: [{ kind: "review", url: PR, verdict: "approve" }],
      body: "Middleware, config, and tests match the plan.",
    });

    const done = await accepted<PostOk>(h.claude, "post", {
      type: "DONE",
      re: ["AC1", "AC2", "AC3"],
      evidence: [
        { kind: "commit", sha: "1c0ffee42" },
        { kind: "test", test: "npm test", result: "pass" },
      ],
      body: "PR 412 merged to main.",
    });
    expect(done.phase).toBe("DONE");
    expect(done.allowed_types).toEqual([]);

    const final = await accepted<ReadResult>(h.codex, "read");
    expect(final).toMatchObject({ phase: "DONE", allowed_types: [] });
    expect(final.messages.map((message) => message.type)).toEqual(["ASSIGN", "STATUS", "DONE"]);
    expect(final.budgets.used).toMatchObject({ messages_total: 9, plan_messages: 3, talk_since_work: 0 });

    // The branch default comes from the newest goal even after DONE, so the engine answers with the phase, not a missing branch.
    const late = await rejected(h.claude, "assign", { to: "codex", new_task: "One more pass", kind: "implement", re: ["AC1"] });
    expect(late).toEqual({ ok: false, rule: "PHASE_GATE", message: expect.stringMatching(/^ASSIGN is not allowed in phase DONE\./) as unknown });

    // After DONE, read answers phase DONE, never NO_GOAL again; kickoff starts the next goal and its description must say so.
    const kickoffTool = (await h.codex.listTools()).tools.find((tool) => tool.name === "kickoff");
    expect(kickoffTool?.description).toContain("Use when read returns NO_GOAL or a goal in phase DONE, and a human gave you a goal.");
    expect(kickoffTool?.description).not.toContain("only when read returns NO_GOAL");
    const next = await accepted<KickoffOk>(h.codex, "kickoff", {
      goal: "Document the rate limit in the README.",
      acceptance_criteria: ["The README names the limit and its env variable."],
      slug: "rate-limit-docs",
    });
    expect(next).toMatchObject({ ok: true, goal_id: "20261025-rate-limit-docs", lead: "codex", challenger: "claude", phase: "PLAN" });
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe("rejections", () => {
  it("surface as isError with the rule and the ANTI-SLOP.md message, and write nothing", async () => {
    const h = await harness();
    await h.kickoff();

    const ack = await rejected(h.claude, "post", { ...PROPOSE, body: "Sounds good." });
    expect(ack).toEqual({ ok: false, rule: "NO_ACK", message: "This message adds nothing. Post STATUS with evidence, a CHALLENGE with a test, or post nothing." });

    const missingRe = await rejected(h.claude, "post", PLAN_PROPOSAL);
    expect(missingRe).toEqual({ ok: false, rule: "CITE_AC", message: "Set `re` to acceptance criteria that exist in goal.md (AC1, AC2, AC3). Unknown: none cited." });

    const decide = await rejected(h.claude, "post", { type: "DECIDE", re: ["AC1"], claim: "Redis it is.", body: "Three replicas." });
    expect(decide).toEqual({ ok: false, rule: "WRONG_TOOL", message: "DECIDE goes through the decide tool, not post. Call decide with the same fields." });
    expect((await rejected(h.claude, "post", { type: "ASSIGN", to: "codex", re: ["AC1"] })).message).toContain("assign tool");
    expect((await rejected(h.claude, "post", { type: "KICKOFF", re: ["AC1"], body: GOAL })).message).toContain("kickoff tool");

    const ask = await rejected(h.claude, "post", { type: "ASK_HUMAN", to: "human", re: ["AC1"], body: "Which Redis?" });
    expect(ask).toEqual({ ok: false, rule: "HUMAN_LAST_RESORT", message: "Agents do not post ASK_HUMAN. Post BLOCKED with kind: external and the store pages the human." });

    const challengeAsLead = await rejected(h.claude, "post", { type: "CHALLENGE", re: ["AC1"], decision_id: "plan", claim: "No.", evidence: [{ kind: "test", test: "x", result: "pending" }] });
    expect(challengeAsLead.rule).toBe("SCHEMA");

    const read = await accepted<ReadResult>(h.codex, "read");
    expect(read.messages.map((message) => message.type)).toEqual(["KICKOFF"]);
  });
});

// ---------------------------------------------------------------------------
// Malformed arguments: the server checks the input schema, not the SDK
// ---------------------------------------------------------------------------

const schemaText = (field: string, problem: string): string => `Field "${field}": ${problem}. Fix it per PROTOCOL.md section 3 and post again.`;

describe("malformed arguments", () => {
  it("answer { ok: false, rule: SCHEMA, message } naming the field for every tool, instead of a plain-text -32602 error, and write nothing", async () => {
    const h = await harness();
    expect(await rejected(h.claude, "kickoff", { goal: GOAL })).toEqual({ ok: false, rule: "SCHEMA", message: schemaText("acceptance_criteria", "required") });
    await h.kickoff();

    const cases: [Client, string, Record<string, unknown>, string][] = [
      [h.codex, "read", { since: 5 }, "since"],
      [h.codex, "wait_for_reply", { timeout_ms: 0 }, "timeout_ms"],
      [h.codex, "wait_for_reply", { timeout_ms: 1.5 }, "timeout_ms"],
      [h.claude, "post", { ...PROPOSE, re: "AC1" }, "re"],
      [h.claude, "post", { type: "BLOCKED", re: ["AC1"], kind: "urgent", body: "Need the Redis password." }, "kind"],
      [h.codex, "status", { re: ["AC1"], evidence: [{ kind: "test", test: "npm test", result: "maybe" }] }, "evidence.0.result"],
      [h.claude, "decide", { claim: "Use Redis.", re: ["AC1"], basis: "vibes", decision_id: "plan" }, "basis"],
      [h.claude, "assign", { to: "codex", kind: "fix", task: "T1", re: ["AC1"] }, "kind"],
    ];
    for (const [client, name, args, field] of cases) {
      const result = await rejected(client, name, args);
      expect(result.rule, `${name} ${field}`).toBe("SCHEMA");
      expect(result.message.startsWith(`Field "${field}": `), result.message).toBe(true);
      expect(result.message.endsWith(". Fix it per PROTOCOL.md section 3 and post again."), result.message).toBe(true);
    }
    expect(await rejected(h.codex, "status", { re: ["AC1"], evidence: [{ kind: "commit" }] })).toEqual({ ok: false, rule: "SCHEMA", message: schemaText("evidence.0.sha", "required") });
    expect(await rejected(h.claude, "post", { type: "QUESTION", re: ["AC1"], body: "Which Redis?" })).toEqual({
      ok: false,
      rule: "TYPED_ONLY",
      message: `Unknown type "QUESTION". Use one of ${MESSAGE_TYPES.join(", ")}.`,
    });

    const read = await accepted<ReadResult>(h.codex, "read");
    expect(read.messages.map((message) => message.type)).toEqual(["KICKOFF"]);
  });

  it("leave tools/list advertising the declared schemas: required fields, enums, the evidence union, integer timeout_ms", async () => {
    const h = await harness();
    const { tools } = await h.claude.listTools();
    const property = (tool: string, key: string): Record<string, unknown> => {
      const properties = tools.find((entry) => entry.name === tool)?.inputSchema.properties ?? {};
      return (properties[key] ?? {}) as Record<string, unknown>;
    };
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]))).toEqual({
      kickoff: ["goal", "acceptance_criteria"],
      post: ["type"],
      decide: ["claim", "basis"],
      assign: ["to", "kind"],
      status: ["evidence"],
      read: [],
      wait_for_reply: [],
    });
    expect(property("post", "type").enum).toEqual([...MESSAGE_TYPES]);
    expect(property("post", "kind").enum).toEqual([...BLOCKED_KINDS]);
    expect(property("post", "to")).toMatchObject({ type: "string", default: "all" });
    expect(property("decide", "basis").enum).toEqual([...DECISION_BASES]);
    expect(property("assign", "kind").enum).toEqual([...ASSIGN_KINDS]);
    expect(property("status", "task_status").enum).toEqual([...STATUS_TASK_STATUSES]);
    const items = (property("status", "evidence").items ?? {}) as { oneOf?: { properties: { kind: { const: string } } }[] };
    expect(items.oneOf?.map((item) => item.properties.kind.const)).toEqual(["commit", "pr", "test", "file", "review", "human", "external"]);
    expect(property("wait_for_reply", "timeout_ms")).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
  });

  it("are documented in PROTOCOL.md section 10 as a SCHEMA rejection, not a plain-text error", () => {
    const protocol = readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8");
    const section = protocol.slice(protocol.indexOf("## 10. MCP tools"), protocol.indexOf("## 11."));
    expect(section).toContain('is rejected the same way as a rule: `{ ok: false, rule: "SCHEMA", message }` naming the field');
    expect(section).not.toMatch(/plain-text/);
  });
});

// ---------------------------------------------------------------------------
// wait_for_reply
// ---------------------------------------------------------------------------

describe("wait_for_reply", () => {
  it("resolves with the other agent's message posted during the wait", async () => {
    const h = await harness();
    await h.kickoff();
    await accepted<ReadResult>(h.codex, "read");
    const waiting = call<ReadResult>(h.codex, "wait_for_reply", { timeout_ms: 5_000 });
    await realSleep(50);
    const posted = await accepted<PostOk>(h.claude, "post", PROPOSE);
    const { isError, body } = await waiting;
    expect(isError).toBe(false);
    expect(body.messages.map((message) => message.id)).toEqual([posted.id]);
    expect(body).toMatchObject({ phase: "PLAN", role: "challenger", cursor: posted.id });
  });

  it("returns { timeout: true } at timeout_ms 300 on the real clock", async () => {
    const h = await harness({ realClock: true });
    await h.kickoff();
    await accepted<ReadResult>(h.codex, "read");
    const started = Date.now();
    const { isError, body } = await call(h.codex, "wait_for_reply", { timeout_ms: 300 });
    expect(isError).toBe(false);
    expect(body).toEqual({ timeout: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it("caps timeout_ms at MAX_WAIT_MS and sends progress and info log notifications every 15 s", async () => {
    const h = await harness();
    await h.kickoff();
    await accepted<ReadResult>(h.codex, "read");
    const logs: unknown[] = [];
    h.codex.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      logs.push(notification.params);
    });
    const progress: Progress[] = [];
    const waiting = call(h.codex, "wait_for_reply", { timeout_ms: 600_000 }, { onprogress: (update) => progress.push(update) });
    await realSleep(40);
    h.clock.advance(PROGRESS_MS);
    await realSleep(40);
    h.clock.advance(PROGRESS_MS);
    await realSleep(40);
    expect(progress).toEqual([
      { progress: 15, total: MAX_WAIT_MS / 1000, message: "wait_for_reply: 15 s of 110 elapsed, phase PLAN" },
      { progress: 30, total: MAX_WAIT_MS / 1000, message: "wait_for_reply: 30 s of 110 elapsed, phase PLAN" },
    ]);
    expect(logs).toEqual([
      { level: "info", logger: "diarchy", data: "wait_for_reply: 15 s of 110 elapsed, phase PLAN" },
      { level: "info", logger: "diarchy", data: "wait_for_reply: 30 s of 110 elapsed, phase PLAN" },
    ]);
    h.clock.advance(MAX_WAIT_MS - 2 * PROGRESS_MS);
    expect((await waiting).body).toEqual({ timeout: true });
    expect(progress).toHaveLength(2);
  });

  it("a wait the client cancels (request timeout) leaves the cursor alone, so the next read delivers the reply", async () => {
    const h = await harness();
    await h.kickoff();
    await accepted<ReadResult>(h.codex, "read");
    await expect(call(h.codex, "wait_for_reply", { timeout_ms: 5_000 }, { timeout: 50 })).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    await realSleep(50);
    const posted = await accepted<PostOk>(h.claude, "post", PROPOSE);
    await realSleep(50);
    const read = await accepted<ReadResult>(h.codex, "read");
    expect(read.messages.map((message) => message.id)).toEqual([posted.id]);
    expect(read.cursor).toBe(posted.id);
  });

  it("a wait whose client gave up without cancelling is ended by the agent's next call and does not consume the reply", async () => {
    const h = await harness();
    await h.kickoff();
    await accepted<ReadResult>(h.codex, "read");
    // A raw tools/call outside the Client's bookkeeping: no timeout, no notifications/cancelled, nobody awaiting the result.
    const transport = h.codex.transport;
    if (transport === undefined) throw new Error("codex client has no transport");
    const replies: JSONRPCMessage[] = [];
    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      replies.push(message);
      deliver?.(message, extra);
    };
    await transport.send({ jsonrpc: "2.0", id: "orphan", method: "tools/call", params: { name: "wait_for_reply", arguments: { timeout_ms: 5_000 } } });
    await realSleep(50);
    const waiting = call<ReadResult>(h.codex, "wait_for_reply", { timeout_ms: 5_000 });
    await realSleep(50);
    const posted = await accepted<PostOk>(h.claude, "post", PROPOSE);
    const { isError, body } = await waiting;
    expect(isError).toBe(false);
    expect(body.messages.map((message) => message.id)).toEqual([posted.id]);
    expect(body.cursor).toBe(posted.id);
    const orphan = replies.find((message) => "id" in message && message.id === "orphan");
    expect(orphan).toMatchObject({ result: { structuredContent: { timeout: true } } });
    expect((await accepted<ReadResult>(h.codex, "read")).messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe("resources", () => {
  it("diarchy://goal and diarchy://chat return the store-rendered views, or a no-goal line", async () => {
    const h = await harness();
    const { resources } = await h.claude.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(["diarchy://chat", "diarchy://goal"]);
    expect(resourceText(await h.claude.readResource({ uri: "diarchy://goal" }))).toBe("No goal in this vault. Call kickoff first.\n");

    await h.kickoff();
    const goal = await h.codex.readResource({ uri: "diarchy://goal" });
    expect(goal.contents[0]).toMatchObject({ uri: "diarchy://goal", mimeType: "text/markdown" });
    const goalText = resourceText(goal);
    expect(goalText.startsWith(GENERATED)).toBe(true);
    expect(goalText).toContain(`# ${GOAL_ID}`);
    // goal.md shows agent text as plain text (RENDERING.md 1.1): the criterion's final period is escaped.
    expect(goalText).toContain("| AC1 | Requests over the limit get 429\\. | open |");
    const chatText = resourceText(await h.codex.readResource({ uri: "diarchy://chat" }));
    expect(chatText.startsWith(`${GENERATED}\n# Chat: ${GOAL_ID}`)).toBe(true);
    expect(chatText).toContain("KICKOFF");
  });
});

// ---------------------------------------------------------------------------
// runMcpServer over stdio
// ---------------------------------------------------------------------------

describe("runMcpServer over stdio", () => {
  it("serves an SDK client over StdioClientTransport with nothing but MCP frames on stdout", async () => {
    const projectDir = tempProject();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", STDIO_SERVER, projectDir, "claude"],
      cwd: ROOT,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: "smoke", version: "0.0.0" });
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(SORTED_TOOLS);
      expect(await rejected(client, "read")).toEqual(NO_GOAL);
    } finally {
      await client.close();
    }
    expect(errors, stderr).toEqual([]);
  });

  it("writes only JSON-RPC frames to stdout and exits 0 when stdin closes", async () => {
    const projectDir = tempProject();
    const child = spawn(process.execPath, ["--import", "tsx", STDIO_SERVER, projectDir, "codex"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const listed = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('"id":2')) resolve();
      });
    });
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
    await listed;
    child.stdin.end();
    expect(await exited, stderr).toBe(0);

    const lines = stdout.trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as { jsonrpc: string; id?: number; result?: { tools?: { name: string }[] } });
    expect(parsed.every((frame) => frame.jsonrpc === "2.0")).toBe(true);
    expect(parsed.find((frame) => frame.id === 2)?.result?.tools?.map((tool) => tool.name).sort()).toEqual(SORTED_TOOLS);
  });

  it("bin/diarchy.js mcp, the plugins' entry over the committed dist/, serves the same tools and reads the project's goal", async () => {
    const projectDir = tempProject();
    const human = new VaultStore({ projectDir, config: loadConfig(projectDir), agent: "human" });
    const kicked = await human.kickoff({ ...KICKOFF_ARGS, lead: "claude" });
    if (!kicked.ok) throw new Error(`${kicked.rule}: ${kicked.message}`);
    const child = spawn(process.execPath, [join(ROOT, "bin", "diarchy.js"), "mcp", "--agent", "codex", "--project", projectDir], {
      cwd: projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const answered = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('"id":3')) resolve();
      });
      child.on("exit", (code) => reject(new Error(`bin/diarchy.js mcp exited ${code} before answering: ${stderr}`)));
    });
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: {} } },
    ];
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
    await answered;
    child.stdin.end();
    expect(await exited, stderr).toBe(0);

    const parsed = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { jsonrpc: string; id?: number; result?: { tools?: { name: string }[]; structuredContent?: Partial<ReadResult> } });
    expect(parsed.every((frame) => frame.jsonrpc === "2.0")).toBe(true);
    expect(parsed.find((frame) => frame.id === 2)?.result?.tools?.map((tool) => tool.name).sort()).toEqual(SORTED_TOOLS);
    expect(parsed.find((frame) => frame.id === 3)?.result?.structuredContent).toMatchObject({
      goal: kicked.goal_id,
      phase: "PLAN",
      role: "challenger",
      cursor: kicked.kickoff_id,
    });
  });
});

// ---------------------------------------------------------------------------
// assign description: the recipe it gives must pass the store
// ---------------------------------------------------------------------------

describe("assign tool description", () => {
  it("tells the lead a review ASSIGN takes new_task and to omit worktree and branch so config supplies them", async () => {
    const h = await harness();
    const { tools } = await h.claude.listTools();
    const assign = tools.find((tool) => tool.name === "assign")?.description ?? "";
    // An ASSIGN with neither task nor new_task is SCHEMA (PROTOCOL.md section 3), review included.
    expect(assign).toContain("kind review takes the PR url");
    expect(assign).toContain('new_task "Review <pr url>"');
    expect(assign).toContain("omit worktree and branch so they come from diarchy.config.json");
  });
});
