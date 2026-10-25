import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  AC_LINE_PATTERN,
  LINE_TERMINATOR,
  RULE_IDS,
  RULES_IN_ORDER,
  SchemaError,
  allowedTypes,
  assignId,
  evaluate,
  initialState,
  isAck,
  isOneClaim,
  parseConfig,
  parseGoalState,
  parseKickoffFile,
  parseMessageFile,
  serializeMessageFile,
  tick,
  wordCount,
  type Acceptance,
  type Effect,
  type EvaluateOptions,
  type GoalState,
  type Message,
  type Phase,
  type Rejection,
  type RuleId,
} from "../src/protocol/index.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/protocol/", import.meta.url));
const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));

// ---------------------------------------------------------------------------
// Fixture format: test/fixtures/protocol/{slop,valid}/<name>.yaml
// ---------------------------------------------------------------------------

interface FixtureStep {
  message: Message;
  caller?: string;
  now?: string;
}

interface Fixture extends FixtureStep {
  description: string;
  state: Record<string, unknown> & { base?: string };
  prior?: FixtureStep[];
  expect: {
    ok: boolean;
    rule?: RuleId;
    message?: string;
    phase_after?: Phase;
    effects?: Array<Partial<Effect>>;
    state?: Record<string, unknown>;
  };
}

function readYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, "utf8"), { schema: "core" }) as T;
}

function listFixtures(dir: "slop" | "valid"): Array<{ name: string; fixture: Fixture }> {
  return readdirSync(join(FIXTURES, dir))
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => ({ name: file.replace(/\.yaml$/, ""), fixture: readYaml<Fixture>(join(FIXTURES, dir, file)) }));
}

function loadBase(name: string): GoalState {
  return parseGoalState(readYaml(join(FIXTURES, "bases", `${name}.yaml`)));
}

/** `base:` names a shared state; the remaining keys override it shallowly. */
function resolveState(spec: Fixture["state"]): GoalState {
  const { base, ...overrides } = spec;
  const baseState: Partial<GoalState> = base === undefined ? {} : loadBase(base);
  return parseGoalState({ ...baseState, ...overrides });
}

function optionsFor(step: FixtureStep): EvaluateOptions {
  return { now: new Date(step.now ?? step.message.ts), callerAgent: step.caller ?? step.message.from };
}

interface Run {
  result: Acceptance | Rejection;
  state: GoalState;
  effects: Effect[];
}

function runFixture(fixture: Fixture): Run {
  let state = resolveState(fixture.state);
  const effects: Effect[] = [];
  for (const step of fixture.prior ?? []) {
    const result = evaluate(step.message, state, optionsFor(step));
    if (!result.ok) throw new Error(`prior ${step.message.id} rejected: ${result.rule} ${result.message}`);
    state = result.state;
    effects.push(...result.effects);
  }
  const result = evaluate(fixture.message, state, optionsFor(fixture));
  if (result.ok) {
    state = result.state;
    effects.push(...result.effects);
  }
  return { result, state, effects };
}

// ---------------------------------------------------------------------------
// ANTI-SLOP.md tables, parsed so docs and code cannot drift
// ---------------------------------------------------------------------------

const antiSlop = readFileSync(join(DOCS, "ANTI-SLOP.md"), "utf8");

function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
}

function docEvaluationOrder(): string[] {
  const section = antiSlop.slice(antiSlop.indexOf("## Evaluation order"), antiSlop.indexOf("## Rules"));
  return tableRows(section)
    .filter((cells) => cells[1] !== "Layer")
    .flatMap((cells) => cells[2].split(",").map((id) => id.trim()));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Error-message column, with `{placeholders}` turned into wildcards. */
function docErrorTemplates(): Map<string, RegExp> {
  const section = antiSlop.slice(antiSlop.indexOf("## Rules"), antiSlop.indexOf("### Fixture convention"));
  const templates = new Map<string, RegExp>();
  for (const cells of tableRows(section)) {
    if (!/^[A-Z_]+$/.test(cells[1])) continue;
    expect(cells, `row ${cells[1]} has an unexpected pipe`).toHaveLength(7);
    const template = cells[4].replace(/ \(ASK_HUMAN body\)$/, "");
    const parts = template.split(/\{[a-z_]+\}/).map(escapeRegExp);
    templates.set(cells[1], new RegExp(`^${parts.join("[\\s\\S]+?")}$`));
  }
  return templates;
}

const errorTemplates = docErrorTemplates();

// ---------------------------------------------------------------------------
// Fixture-driven tests
// ---------------------------------------------------------------------------

const slopFixtures = listFixtures("slop");
const validFixtures = listFixtures("valid");

function assertExpectations(run: Run, fixture: Fixture): void {
  const { result, state, effects } = run;
  expect(result.ok).toBe(fixture.expect.ok);
  if (!result.ok) {
    expect(result.rule).toBe(fixture.expect.rule);
    expect(result.message).not.toMatch(/\{[a-z_]+\}/);
    expect(result.message).toMatch(errorTemplates.get(result.rule) ?? /^$/);
    if (fixture.expect.message !== undefined) expect(result.message).toBe(fixture.expect.message);
  }
  if (fixture.expect.phase_after !== undefined) expect(state.phase).toBe(fixture.expect.phase_after);
  for (const matcher of fixture.expect.effects ?? []) {
    expect(effects).toEqual(expect.arrayContaining([expect.objectContaining(matcher)]));
  }
  if (fixture.expect.state !== undefined) expect(state).toMatchObject(fixture.expect.state);
}

describe("slop fixtures are rejected with the named rule", () => {
  for (const { name, fixture } of slopFixtures) {
    it(`${name}: ${fixture.description}`, () => {
      expect(fixture.expect.ok).toBe(false);
      assertExpectations(runFixture(fixture), fixture);
    });
  }
});

describe("valid fixtures are accepted", () => {
  for (const { name, fixture } of validFixtures) {
    it(`${name}: ${fixture.description}`, () => {
      expect(fixture.expect.ok).toBe(true);
      const run = runFixture(fixture);
      assertExpectations(run, fixture);
      for (const effect of run.effects) {
        if (effect.kind !== "system_message") continue;
        expect(wordCount(effect.body)).toBeLessThanOrEqual(120);
        expect(effect.re.length).toBeGreaterThan(0);
        if (effect.reason === "DEADLOCK") expect(effect.body).toMatch(errorTemplates.get("DEADLOCK") ?? /^$/);
      }
    });
  }
});

describe("fixture coverage", () => {
  it("has at least 8 slop and 6 valid fixtures", () => {
    expect(slopFixtures.length).toBeGreaterThanOrEqual(8);
    expect(validFixtures.length).toBeGreaterThanOrEqual(6);
  });

  it("every rejecting rule has a slop fixture named after it; DEADLOCK has a trigger fixture", () => {
    const covered = new Set(slopFixtures.map(({ fixture }) => fixture.expect.rule));
    for (const { name, fixture } of slopFixtures) {
      expect(name.startsWith(`${fixture.expect.rule?.toLowerCase()}-`), `${name} is named after its rule`).toBe(true);
    }
    for (const rule of RULE_IDS) {
      if (rule !== "DEADLOCK") expect(covered.has(rule), `slop fixture for ${rule}`).toBe(true);
    }
    const deadlock = validFixtures.some(({ fixture }) =>
      (fixture.expect.effects ?? []).some((effect) => effect.kind === "system_message" && effect.reason === "DEADLOCK"),
    );
    expect(deadlock).toBe(true);
  });

  it("every base state validates against the budget.json schema", () => {
    const bases = readdirSync(join(FIXTURES, "bases")).filter((file) => file.endsWith(".yaml"));
    expect(bases.length).toBeGreaterThan(0);
    for (const file of bases) expect(() => loadBase(file.replace(/\.yaml$/, ""))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Docs and code agree
// ---------------------------------------------------------------------------

describe("ANTI-SLOP.md", () => {
  it("RULES_IN_ORDER has the 25 ids, no duplicates, in the doc's evaluation order", () => {
    expect(RULES_IN_ORDER).toHaveLength(25);
    expect(new Set(RULES_IN_ORDER).size).toBe(25);
    expect(RULES_IN_ORDER).toEqual(docEvaluationOrder());
  });

  it("the rules table names exactly the rule ids the code knows", () => {
    expect([...errorTemplates.keys()].sort()).toEqual([...RULE_IDS].sort());
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL.md examples
// ---------------------------------------------------------------------------

const exampleDir = join(FIXTURES, "examples");
const exampleFiles = readdirSync(exampleDir).filter((file) => file.endsWith(".md")).sort();

const KICKOFF_MD = `---
protocol_version: 1
goal: 20261025-rate-limit
lead: claude
challenger: codex
agents: [claude, codex]
budgets: {}
project: /home/user/api
vault: /home/user/api/api brain/diarchy
created: 2026-10-25T14:00:00Z
by: human
---
Add per-API-key rate limiting to the public API.

- AC1: Requests over the per-key limit get HTTP 429
- AC2: Limit is configurable via RATE_LIMIT_PER_MIN
- AC3: Full test suite stays green
`;

const CONFIG = parseConfig({
  protocol_version: 1,
  vault: "api brain/diarchy",
  agents: { claude: { command: "claude -p" }, codex: { command: "codex exec" } },
});

function example(id: string): Message {
  return parseMessageFile(readFileSync(join(exampleDir, `${id}.md`), "utf8"));
}

function accept(message: Message, state: GoalState): GoalState {
  const result = evaluate(message, state, { now: new Date(message.ts), callerAgent: message.from });
  if (!result.ok) throw new Error(`${message.id}: ${result.rule} ${result.message}`);
  return result.state;
}

describe("PROTOCOL.md examples", () => {
  it("has all nine example messages", () => {
    expect(exampleFiles).toHaveLength(9);
  });

  for (const file of exampleFiles) {
    it(`parses and round-trips ${file} byte for byte`, () => {
      const text = readFileSync(join(exampleDir, file), "utf8");
      const message = parseMessageFile(text);
      expect(`${message.id}.md`).toBe(file);
      expect(typeof message.ts).toBe("string");
      expect(serializeMessageFile(message)).toBe(text);
    });
  }

  it("replays the example sequence from initialState and lands on the base states", () => {
    const kickoff = parseKickoffFile(KICKOFF_MD);
    expect(kickoff.acceptance_criteria).toHaveLength(3);
    expect(kickoff.goal_text).toBe("Add per-API-key rate limiting to the public API.");
    let state = initialState(kickoff, CONFIG, new Date("2026-10-25T14:00:00Z"));
    expect(state).toEqual(loadBase("initial"));
    state = accept(example("20261025T140000Z-0001-human-KICKOFF"), state);
    expect(state).toEqual(loadBase("plan-fresh"));
    state = accept(example("20261025T140210Z-0001-claude-PROPOSE"), state);
    expect(state).toEqual(loadBase("plan-proposed"));
    state = accept(example("20261025T140455Z-0001-codex-CHALLENGE"), state);
    expect(state).toEqual(loadBase("plan-challenged"));
    state = accept(example("20261025T140730Z-0002-claude-DECIDE"), state);
    expect(state).toEqual(loadBase("execute"));
    state = accept(example("20261025T140800Z-0003-claude-ASSIGN"), state);
    expect(state).toEqual(loadBase("execute-assigned"));
    expect(accept(example("20261025T151200Z-0003-codex-STATUS"), state)).toEqual(loadBase("execute-pr"));
    const blocked = accept(example("20261025T143500Z-0002-codex-BLOCKED"), state);
    expect(blocked).toEqual(loadBase("blocked"));
    expect(accept(example("20261025T143501Z-0001-system-ASK_HUMAN"), blocked).phase).toBe("BLOCKED");
  });

  it("parseKickoffFile takes the trailing run of AC lines as the criteria and keeps an AC-shaped goal line as goal text", () => {
    const goal = "Add per-API-key rate limiting to the public API.";
    const criteria = ["Requests over the per-key limit get HTTP 429", "Limit is configurable via RATE_LIMIT_PER_MIN", "Full test suite stays green"];
    const injected = parseKickoffFile(KICKOFF_MD.replace(`${goal}\n`, `${goal}\n- AC1: injected criterion\n`));
    expect(injected.goal_text).toBe(`${goal}\n- AC1: injected criterion`);
    expect(injected.acceptance_criteria).toEqual(criteria);
    expect(parseKickoffFile(KICKOFF_MD.replace("\n\n- AC1", "\n- AC1"))).toMatchObject({ goal_text: goal, acceptance_criteria: criteria });
    expect(parseKickoffFile(`${KICKOFF_MD}\n\n`).acceptance_criteria).toEqual(criteria);
    expect(() => parseKickoffFile(KICKOFF_MD.replace("- AC2:", "- AC3:"))).toThrowError(/^Field "body": AC3 is out of order/);
    expect(() => parseKickoffFile(KICKOFF_MD.replace("- AC1:", "- AC1: again\n- AC1:"))).toThrowError(/^Field "body": AC1 is out of order/);
    expect(() => parseKickoffFile(KICKOFF_MD.replace(/- AC\d: .*\n/g, ""))).toThrowError(/^Field "body": needs at least one/);
    expect(AC_LINE_PATTERN.test("- AC1: x")).toBe(true);
    expect(AC_LINE_PATTERN.test("- AC0: x")).toBe(false);
  });

  it("parseMessageFile throws SchemaError with TYPED_ONLY for unknown types and SCHEMA otherwise", () => {
    const text = readFileSync(join(exampleDir, "20261025T140000Z-0001-human-KICKOFF.md"), "utf8");
    const unknownType = text.replace("type: KICKOFF", "type: HELLO").replace("human-KICKOFF", "human-HELLO");
    expect(() => parseMessageFile(unknownType)).toThrowError(SchemaError);
    expect(() => parseMessageFile(unknownType)).toThrowError(/^Unknown type "HELLO"/);
    const badVersion = text.replace("protocol_version: 1", "protocol_version: 2");
    expect(() => parseMessageFile(badVersion)).toThrowError(/^Field "protocol_version"/);
    expect(() => parseMessageFile("no frontmatter here")).toThrowError(/^Field "frontmatter"/);
    try {
      parseMessageFile(badVersion);
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).rule).toBe("SCHEMA");
      expect((error as SchemaError).problem).toBe('Field "protocol_version": Invalid input: expected 1');
    }
    expect(() => parseMessageFile(unknownType)).toThrowError(expect.objectContaining({ rule: "TYPED_ONLY", field: "type", problem: 'Unknown type "HELLO"' }));
  });

  it("PROTOCOL.md states the rule a stored file that will not parse surfaces with, and the line terminators kickoff refuses, as the code has them", () => {
    const protocolMd = readFileSync(join(DOCS, "PROTOCOL.md"), "utf8");
    const tools = protocolMd.slice(protocolMd.indexOf("## 10. MCP tools"), protocolMd.indexOf("## 11. "));
    expect(tools).toContain("rule SCHEMA, or TYPED_ONLY for a message file whose `type` is unknown");
    const kickoffMd = readFileSync(join(exampleDir, "20261025T140000Z-0001-human-KICKOFF.md"), "utf8");
    expect(() => parseMessageFile(kickoffMd.replace("type: KICKOFF", "type: HELLO"))).toThrowError(expect.objectContaining({ rule: "TYPED_ONLY" }));
    expect(() => parseMessageFile(kickoffMd.replace("protocol_version: 1", "protocol_version: 2"))).toThrowError(expect.objectContaining({ rule: "SCHEMA" }));
    expect(() => parseKickoffFile(KICKOFF_MD.replace("- AC2:", "- AC3:"))).toThrowError(expect.objectContaining({ rule: "SCHEMA" }));

    const storeFiles = protocolMd.slice(protocolMd.indexOf("### 2.3 Store-owned files"), protocolMd.indexOf("## 3. "));
    const named = /line terminator \(([^)]*)\)/.exec(storeFiles)?.[1].split(", ") ?? [];
    const byName: Record<string, string> = { CR: "\r", LF: "\n", VT: "\v", FF: "\f", "U+0085": "\u0085", "U+2028": "\u2028", "U+2029": "\u2029" };
    expect(named).toEqual(Object.keys(byName));
    for (const [name, char] of Object.entries(byName)) expect(LINE_TERMINATOR.test(`a${char}b`), name).toBe(true);
    for (const char of [" ", "\t", "\u00a0", "\u200b", "\ufeff", "\u001c"]) expect(LINE_TERMINATOR.test(`a${char}b`), JSON.stringify(char)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tick: DEADLOCK (10 min) and WALL_CLOCK
// ---------------------------------------------------------------------------

describe("tick", () => {
  const CHALLENGE_ID = "20261025T140455Z-0001-codex-CHALLENGE";

  it("fires DEADLOCK exactly 10 minutes after the CHALLENGE", () => {
    const state = loadBase("plan-challenged");
    expect(state.deadlock_watch?.deadline).toBe("2026-10-25T14:14:55Z");
    expect(tick(state, new Date("2026-10-25T14:14:54Z"))).toBeNull();
    const result = tick(state, new Date("2026-10-25T14:14:55Z"));
    expect(result?.state.phase).toBe("BLOCKED");
    expect(result?.state.blocked_from).toBe("PLAN");
    expect(result?.effects).toEqual([
      { kind: "phase", from: "PLAN", to: "BLOCKED" },
      expect.objectContaining({
        kind: "system_message",
        type: "ASK_HUMAN",
        reason: "DEADLOCK",
        reply_to: CHALLENGE_ID,
        decision_id: "plan",
        re: ["AC1"],
        body: "Lead did not DECIDE plan within 2 messages or 10 minutes. Goal BLOCKED; human paged.",
      }),
    ]);
    expect(state.phase).toBe("PLAN");
  });

  it("fires WALL_CLOCK at wall_clock_minutes after kickoff.created", () => {
    const state = loadBase("execute-assigned");
    expect(tick(state, new Date("2026-10-25T17:59:59Z"))).toBeNull();
    const result = tick(state, new Date("2026-10-25T18:00:00Z"));
    expect(result?.state.phase).toBe("BLOCKED");
    expect(result?.state.blocked_from).toBe("EXECUTE");
    expect(result?.state.used.wall_clock_minutes).toBe(240);
    expect(result?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "system_message", reason: "WALL_CLOCK", re: ["AC1", "AC2", "AC3"] })]),
    );
  });

  it("treats a reached spend_usd limit like WALL_CLOCK", () => {
    const base = loadBase("execute-assigned");
    const state: GoalState = { ...base, limits: { ...base.limits, spend_usd: 50 }, used: { ...base.used, spend_usd: 50 } };
    const result = tick(state, new Date("2026-10-25T14:30:00Z"));
    expect(result?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "system_message", reason: "WALL_CLOCK", body: expect.stringMatching(/^Spend 50 of 50 USD/) })]),
    );
  });

  it("does nothing in BLOCKED or DONE", () => {
    expect(tick(loadBase("blocked"), new Date("2026-10-26T14:00:00Z"))).toBeNull();
    const done: GoalState = { ...loadBase("execute-reviewed"), phase: "DONE" };
    expect(tick(done, new Date("2026-10-26T14:00:00Z"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assignId
// ---------------------------------------------------------------------------

describe("assignId", () => {
  const now = new Date("2026-10-25T14:30:12.700Z");

  it("builds <ts-compact>-<seq>-<agent>-<type> with second precision", () => {
    const first = assignId(loadBase("plan-fresh"), "claude", "PROPOSE", now);
    expect(first).toMatchObject({ id: "20261025T143012Z-0001-claude-PROPOSE", ts: "2026-10-25T14:30:12Z", seq: 1 });
    expect(first.state.seq.claude).toBe(1);
    expect(first.state.last_ts).toBe("2026-10-25T14:30:12Z");
  });

  it("is monotonic per agent and in ts across agents, including the same second", () => {
    const start = loadBase("plan-fresh");
    const a = assignId(start, "claude", "PROPOSE", now);
    const b = assignId(a.state, "codex", "CHALLENGE", now);
    const c = assignId(b.state, "claude", "DECIDE", now);
    expect(b.ts).toBe("2026-10-25T14:30:13Z");
    expect(b.seq).toBe(1);
    expect(c.ts).toBe("2026-10-25T14:30:14Z");
    expect(c.seq).toBe(2);
    expect(c.id).toBe("20261025T143014Z-0002-claude-DECIDE");
    expect([a.ts, b.ts, c.ts]).toEqual([...new Set([a.ts, b.ts, c.ts])].sort());
    expect(start.seq.claude).toBe(0);
  });

  it("never goes backwards when the clock does", () => {
    const a = assignId(loadBase("plan-fresh"), "claude", "PROPOSE", now);
    const earlier = assignId(a.state, "claude", "STATUS", new Date("2026-10-25T14:00:00Z"));
    expect(earlier.ts).toBe("2026-10-25T14:30:13Z");
    expect(earlier.seq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// allowedTypes
// ---------------------------------------------------------------------------

describe("allowedTypes", () => {
  it("follows phase and role", () => {
    expect(allowedTypes(loadBase("initial"), "human")).toEqual(["KICKOFF"]);
    expect(allowedTypes(loadBase("initial"), "codex")).toEqual([]);
    expect(allowedTypes(loadBase("plan-fresh"), "claude")).toEqual(["PROPOSE", "DECIDE", "STATUS", "BLOCKED"]);
    expect(allowedTypes(loadBase("plan-fresh"), "codex")).toEqual(["PROPOSE", "CHALLENGE", "STATUS", "BLOCKED"]);
    expect(allowedTypes(loadBase("execute"), "claude")).toEqual(["STATUS", "ASSIGN", "BLOCKED", "DONE", "DECIDE"]);
    expect(allowedTypes(loadBase("execute"), "codex")).toEqual(["STATUS", "BLOCKED", "CHALLENGE"]);
    expect(allowedTypes(loadBase("blocked"), "claude")).toEqual([]);
    expect(allowedTypes(loadBase("blocked"), "human")).toEqual(["DECIDE"]);
    expect(allowedTypes(loadBase("blocked"), "system")).toEqual(["ASK_HUMAN"]);
  });

  it("narrows under PLAN_BUDGET and TALK_WORK_RATIO", () => {
    const plan = loadBase("plan-proposed");
    const spent: GoalState = { ...plan, used: { ...plan.used, plan_messages: 12 } };
    expect(allowedTypes(spent, "claude")).toEqual(["DECIDE", "BLOCKED"]);
    expect(allowedTypes(spent, "codex")).toEqual(["BLOCKED"]);
    const exec = loadBase("execute");
    const talky: GoalState = { ...exec, used: { ...exec.used, talk_since_work: 3 } };
    expect(allowedTypes(talky, "claude")).toEqual(["STATUS", "BLOCKED", "DONE", "DECIDE"]);
  });
});

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

describe("text helpers", () => {
  it("wordCount splits on whitespace", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
    expect(wordCount("  a  b\nc ")).toBe(3);
  });

  it("isOneClaim enforces one sentence of 1 to 40 words", () => {
    expect(isOneClaim("A token-bucket middleware keyed by API key satisfies AC1 and AC2.")).toBe(true);
    expect(isOneClaim("Really?!")).toBe(true);
    expect(isOneClaim("src/middleware/rateLimit.ts handles 429s.")).toBe(true);
    expect(isOneClaim("Use Redis. It is shared.")).toBe(false);
    expect(isOneClaim("No terminal punctuation")).toBe(false);
    expect(isOneClaim("")).toBe(false);
    expect(isOneClaim(`${Array.from({ length: 41 }, () => "word").join(" ")}.`)).toBe(false);
    expect(isOneClaim(`${Array.from({ length: 40 }, () => "word").join(" ")}.`)).toBe(true);
  });

  it("isAck matches whole words in short bodies only", () => {
    expect(isAck("Sounds good!")).toBe(true);
    expect(isAck("+1")).toBe(true);
    expect(isAck("LGTM, merging.")).toBe(true);
    expect(isAck("Noted")).toBe(true);
    expect(isAck("Thank you, I agree with that.")).toBe(true);
    expect(isAck("Thanksgiving tests pass.")).toBe(false);
    expect(isAck("Looks fine to me after rebase.")).toBe(false);
    expect(isAck("Agreed with the review note: the bucket refills per key now, and tests cover the 429 path.")).toBe(false);
    expect(isAck("")).toBe(false);
    expect(isAck("Use Redis.", "Use Redis.")).toBe(false);
  });
});
