/**
 * Zod schemas for message frontmatter (per type), evidence, kickoff.md,
 * diarchy.config.json, and budget.json, plus the YAML file (de)serializer.
 */
import { Document, isSeq, parse as parseYaml, visit } from "yaml";
import { z } from "zod";

import { FIELD_MAX_CHARS, hasControlChars, wordCount } from "./text.js";
import {
  AGENT_HUMAN,
  AGENT_ID_PATTERN,
  ASSIGN_KINDS,
  BLOCKED_KINDS,
  DECISION_BASES,
  MAX_AGENTS,
  MESSAGE_TYPES,
  PHASES,
  REVIEW_VERDICTS,
  STATUS_TASK_STATUSES,
  TASK_STATUSES,
  TEST_RESULTS,
  type DiarchyConfig,
  type GoalState,
  type Kickoff,
  type Message,
  type MessageType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const MESSAGE_ID_PATTERN = /^(\d{8}T\d{6}Z)-(\d{4})-([a-z][a-z0-9-]{1,15})-([A-Z_]+)$/;
export const GOAL_ID_PATTERN = /^\d{8}-[a-z0-9-]{1,40}$/;
export const AC_ID_PATTERN = /^AC[1-9][0-9]*$/;
export const TASK_ID_PATTERN = /^T[1-9][0-9]*$/;
export const DECISION_ID_PATTERN = /^(plan|D[1-9][0-9]*)$/;
export const ISO_TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface MessageIdParts {
  ts_compact: string;
  seq: number;
  agent: string;
  type: string;
}

export function parseMessageId(id: string): MessageIdParts | null {
  const match = MESSAGE_ID_PATTERN.exec(id);
  if (!match) return null;
  const [, ts_compact, seq, agent, type] = match;
  return { ts_compact, seq: Number(seq), agent, type };
}

/** `2026-10-25T14:30:12Z` -> `20261025T143012Z`. */
export function compactTs(ts: string): string {
  return ts.replace(/[-:]/g, "");
}

/** Second-precision UTC ISO string without milliseconds. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

const agentId = z.string().regex(AGENT_ID_PATTERN, "must be an agent id");
const goalId = z.string().regex(GOAL_ID_PATTERN, "must be a goal id");
const messageId = z.string().regex(MESSAGE_ID_PATTERN, "must be a message id");
const taskId = z.string().regex(TASK_ID_PATTERN, "must be a task id");
const decisionId = z.string().regex(DECISION_ID_PATTERN, "must be plan or D<n>");
const isoTs = z.string().regex(ISO_TS_PATTERN, "must be an ISO 8601 UTC timestamp");
const url = z.url();

/** Free text of 1 to `max` whitespace-split words; blank or whitespace-only text fails. */
const wordsMax = (max: number) =>
  z.string().refine((text) => wordCount(text) >= 1 && wordCount(text) <= max, `must be 1 to ${max} words`);

const ONE_LINE = "must be one line with no control characters";

/** Free text embedded in single-line contexts (briefs, hook reasons, tables): one line, 1 to `max` words. */
const oneLineWords = (max: number) => wordsMax(max).refine((text) => !hasControlChars(text), ONE_LINE);

/** A worktree or file path: one line, at most FIELD_MAX_CHARS. */
const pathText = z
  .string()
  .min(1)
  .max(FIELD_MAX_CHARS, `at most ${FIELD_MAX_CHARS} characters`)
  .refine((text) => !hasControlChars(text), ONE_LINE);

/** Git-ref-safe: letters, digits, `. _ / -`; no `..`; no leading `-`. */
const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const branchName = z
  .string()
  .max(FIELD_MAX_CHARS, `at most ${FIELD_MAX_CHARS} characters`)
  .regex(BRANCH_PATTERN, 'must be a branch name of letters, digits, and . _ / - with no ".." and no leading "-"');

// ---------------------------------------------------------------------------
// Evidence (PROTOCOL.md 3.1)
// ---------------------------------------------------------------------------

export const evidenceItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{7,40}$/, "7 to 40 hex") }),
  z.strictObject({ kind: z.literal("pr"), url }),
  z.strictObject({
    kind: z.literal("test"),
    test: wordsMax(40),
    result: z.enum(TEST_RESULTS),
    log: pathText.optional(),
  }),
  z.strictObject({ kind: z.literal("file"), path: pathText }),
  z.strictObject({ kind: z.literal("review"), url, verdict: z.enum(REVIEW_VERDICTS) }),
  z.strictObject({ kind: z.literal("human"), id: messageId }),
  z.strictObject({ kind: z.literal("external"), url, note: wordsMax(20).optional() }),
]);

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const budgetLimitsSchema = z.strictObject({
  plan_messages: z.number().int().positive(),
  messages_total: z.number().int().positive(),
  challenges_per_decision: z.number().int().positive(),
  rounds_per_decision: z.number().int().positive(),
  talk_work_ratio: z.number().int().positive(),
  wall_clock_minutes: z.number().int().positive(),
  spend_usd: z.number().positive().nullable(),
});

export const partialBudgetsSchema = budgetLimitsSchema.partial();

// ---------------------------------------------------------------------------
// Message frontmatter, per type
// ---------------------------------------------------------------------------

const base = {
  protocol_version: z.literal(1),
  id: messageId,
  goal: goalId,
  from: agentId,
  to: agentId,
  re: z.array(z.string()).default([]),
  reply_to: messageId.optional(),
  phase: z.enum(PHASES),
  ts: isoTs,
  body: z.string(),
};

/** Common fields only; `type` is any string here so TYPED_ONLY can judge it. */
const commonSchema = z.looseObject({ ...base, type: z.string() });

const claim = z.string().min(1);
const evidenceList = z.array(evidenceItemSchema);

export const messageSchemas = {
  KICKOFF: z.strictObject({ ...base, type: z.literal("KICKOFF") }),
  PROPOSE: z.strictObject({ ...base, type: z.literal("PROPOSE"), claim, decision_id: decisionId.optional() }),
  CHALLENGE: z.strictObject({
    ...base,
    type: z.literal("CHALLENGE"),
    reply_to: messageId,
    claim,
    decision_id: decisionId,
    evidence: evidenceList.optional(),
  }),
  DECIDE: z.strictObject({
    ...base,
    type: z.literal("DECIDE"),
    claim,
    basis: z.enum(DECISION_BASES),
    decision_id: decisionId.optional(),
    supersedes: decisionId.optional(),
    evidence: evidenceList.optional(),
    tasks: z.array(oneLineWords(40)).optional(),
    ac_add: z.array(wordsMax(40)).optional(),
    budgets: partialBudgetsSchema.optional(),
  }),
  ASSIGN: z.strictObject({
    ...base,
    type: z.literal("ASSIGN"),
    task: taskId.optional(),
    new_task: oneLineWords(40).optional(),
    kind: z.enum(ASSIGN_KINDS),
    worktree: pathText.optional(),
    branch: branchName.optional(),
    pr: url.optional(),
    reason: z.string().optional(),
  }),
  STATUS: z.strictObject({
    ...base,
    type: z.literal("STATUS"),
    task: taskId.optional(),
    task_status: z.enum(STATUS_TASK_STATUSES).optional(),
    evidence: evidenceList.optional(),
  }),
  DONE: z.strictObject({ ...base, type: z.literal("DONE"), evidence: evidenceList.min(1) }),
  BLOCKED: z.strictObject({ ...base, type: z.literal("BLOCKED"), kind: z.enum(BLOCKED_KINDS) }),
  ASK_HUMAN: z.strictObject({ ...base, type: z.literal("ASK_HUMAN"), decision_id: decisionId.optional() }),
} satisfies Record<MessageType, z.ZodType>;

export const messageSchema = z.discriminatedUnion("type", [
  messageSchemas.KICKOFF,
  messageSchemas.PROPOSE,
  messageSchemas.CHALLENGE,
  messageSchemas.DECIDE,
  messageSchemas.ASSIGN,
  messageSchemas.STATUS,
  messageSchemas.DONE,
  messageSchemas.BLOCKED,
  messageSchemas.ASK_HUMAN,
]);

// ---------------------------------------------------------------------------
// Shape checking (the stateless half of SCHEMA and TYPED_ONLY)
// ---------------------------------------------------------------------------

export type ShapeRule = "SCHEMA" | "TYPED_ONLY";

export type ShapeResult =
  | { ok: true; message: Message }
  /** `problem` is `message` without the advice to the poster, for a stored file that will not parse. */
  | { ok: false; rule: ShapeRule; message: string; field: string | null; problem: string };

export interface FieldProblem {
  field: string;
  problem: string;
}

function fieldProblem(field: string, problem: string): string {
  return `Field "${field}": ${problem}`;
}

function unknownType(type: unknown): string {
  return `Unknown type "${String(type)}"`;
}

export function schemaMessage(field: string, problem: string): string {
  return `${fieldProblem(field, problem)}. Fix it per PROTOCOL.md section 3 and post again.`;
}

export function typedOnlyMessage(type: unknown): string {
  return `${unknownType(type)}. Use one of ${MESSAGE_TYPES.join(", ")}.`;
}

export function isMessageType(type: unknown): type is MessageType {
  return typeof type === "string" && (MESSAGE_TYPES as readonly string[]).includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(input: unknown, path: PropertyKey[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** The field a zod issue points at and what is wrong with it, for a SCHEMA message. */
export function describeIssue(issue: z.core.$ZodIssue, input: unknown): FieldProblem {
  if (issue.code === "unrecognized_keys") {
    return { field: issue.keys[0] ?? "frontmatter", problem: "unknown field" };
  }
  const field = issue.path.map(String).join(".") || "frontmatter";
  if (valueAt(input, issue.path) === undefined) return { field, problem: "required" };
  return { field, problem: issue.message };
}

function hasConclusiveTest(message: Message): boolean {
  return (message.evidence ?? []).some(
    (item) => item.kind === "test" && (item.result === "pass" || item.result === "fail"),
  );
}

/** PROTOCOL.md section 10: a human DECIDE may omit both; the store assigns the next D<n>. */
function decideProblem(message: Message): FieldProblem | null {
  if (message.decision_id === undefined && message.supersedes === undefined && message.from !== AGENT_HUMAN) {
    return { field: "decision_id", problem: "required unless supersedes is set" };
  }
  if (message.basis === "test" && !hasConclusiveTest(message)) {
    return { field: "evidence", problem: "basis test needs a test item with result pass or fail" };
  }
  if (message.basis === "authority" && message.body.trim() === "") {
    return { field: "body", problem: "basis authority must say why the test cannot be run" };
  }
  return null;
}

function assignProblem(message: Message): FieldProblem | null {
  const hasTask = message.task !== undefined;
  const hasNew = message.new_task !== undefined;
  if (hasTask === hasNew) return { field: "task", problem: "exactly one of task or new_task" };
  if (message.kind === "implement") {
    if (message.worktree === undefined) return { field: "worktree", problem: "required for kind implement" };
    if (message.branch === undefined) return { field: "branch", problem: "required for kind implement" };
    if (message.pr !== undefined) return { field: "pr", problem: "only for kind review" };
  } else {
    if (message.pr === undefined) return { field: "pr", problem: "required for kind review" };
    if (message.worktree !== undefined) return { field: "worktree", problem: "only for kind implement" };
    if (message.branch !== undefined) return { field: "branch", problem: "only for kind implement" };
  }
  return null;
}

/** Cross-field requirements PROTOCOL.md section 3 states in prose. */
export function conditionalProblem(message: Message): FieldProblem | null {
  if (message.type === "DECIDE") return decideProblem(message);
  if (message.type === "ASSIGN") return assignProblem(message);
  return null;
}

function schemaFail(field: string, problem: string): ShapeResult {
  return { ok: false, rule: "SCHEMA", message: schemaMessage(field, problem), field, problem: fieldProblem(field, problem) };
}

/**
 * Stateless validation of a message object. Runs the common fields first
 * (SCHEMA), then the type name (TYPED_ONLY), then the type-specific shape
 * (SCHEMA), matching the ANTI-SLOP.md evaluation order.
 */
export function checkMessageShape(input: unknown): ShapeResult {
  if (!isRecord(input)) return schemaFail("frontmatter", "must be a mapping");
  const common = commonSchema.safeParse(input);
  if (!common.success) {
    const { field, problem } = describeIssue(common.error.issues[0], input);
    return schemaFail(field, problem);
  }
  if (!isMessageType(input.type)) {
    return { ok: false, rule: "TYPED_ONLY", message: typedOnlyMessage(input.type), field: "type", problem: unknownType(input.type) };
  }
  const typed = messageSchemas[input.type].safeParse(input);
  if (!typed.success) {
    const { field, problem } = describeIssue(typed.error.issues[0], input);
    return schemaFail(field, problem);
  }
  const message: Message = typed.data;
  const conditional = conditionalProblem(message);
  if (conditional) return schemaFail(conditional.field, conditional.problem);
  return { ok: true, message };
}

// ---------------------------------------------------------------------------
// Message files: YAML frontmatter + body
// ---------------------------------------------------------------------------

export class SchemaError extends Error {
  readonly rule: ShapeRule;
  readonly field: string | null;
  /** What is wrong, without the advice to fix and post again: a stored file is not the caller's draft. */
  readonly problem: string;

  constructor(rule: ShapeRule, message: string, field: string | null = null, problem: string = message) {
    super(message);
    this.name = "SchemaError";
    this.rule = rule;
    this.field = field;
    this.problem = problem;
  }
}

function schemaError(field: string, problem: string): SchemaError {
  return new SchemaError("SCHEMA", schemaMessage(field, problem), field, fieldProblem(field, problem));
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export interface SplitFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split a markdown file into its YAML frontmatter mapping and body. */
export function splitFrontmatter(text: string): SplitFile {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    throw schemaError("frontmatter", "missing or unterminated");
  }
  const [, yamlText, body] = match;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText, { schema: "core" });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw schemaError("frontmatter", reason);
  }
  if (!isRecord(parsed)) {
    throw schemaError("frontmatter", "must be a mapping");
  }
  return { frontmatter: coerceTimestamps(parsed), body };
}

/** PROTOCOL.md: `ts` is a string; undo any YAML timestamp coercion defensively. */
function coerceTimestamps(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...frontmatter };
  for (const key of ["ts", "created"]) {
    const value = out[key];
    if (value instanceof Date) out[key] = isoSeconds(value);
  }
  return out;
}

/** Parse a `chat/<id>.md` file; throws `SchemaError` (SCHEMA or TYPED_ONLY). */
export function parseMessageFile(text: string): Message {
  const { frontmatter, body } = splitFrontmatter(text);
  const result = checkMessageShape({ ...frontmatter, body });
  if (!result.ok) throw new SchemaError(result.rule, result.message, result.field, result.problem);
  return result.message;
}

/** Canonical key order, taken from the PROTOCOL.md 3.2 examples. */
export const FRONTMATTER_KEY_ORDER = [
  "protocol_version",
  "id",
  "goal",
  "from",
  "to",
  "type",
  "re",
  "reply_to",
  "decision_id",
  "task",
  "new_task",
  "kind",
  "worktree",
  "branch",
  "pr",
  "reason",
  "task_status",
  "phase",
  "claim",
  "basis",
  "supersedes",
  "evidence",
  "tasks",
  "ac_add",
  "budgets",
  "ts",
] as const;

/** Strings holding quotes or flow indicators are double-quoted, as in the examples. */
const NEEDS_DOUBLE_QUOTE = /['"{}[\]]/;

function orderedFrontmatter(message: Message): Record<string, unknown> {
  const source = message as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEY_ORDER) {
    if (source[key] !== undefined) ordered[key] = source[key];
  }
  for (const key of Object.keys(source).sort()) {
    if (key !== "body" && !(key in ordered) && source[key] !== undefined) ordered[key] = source[key];
  }
  return ordered;
}

/** Serialize to the canonical file text; round-trips the PROTOCOL.md examples byte for byte. */
export function serializeMessageFile(message: Message): string {
  const doc = new Document(orderedFrontmatter(message));
  const re = doc.get("re", true);
  if (isSeq(re)) re.flow = true;
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && NEEDS_DOUBLE_QUOTE.test(node.value)) node.type = "QUOTE_DOUBLE";
    },
  });
  const yamlText = doc.toString({
    lineWidth: 0,
    singleQuote: false,
    blockQuote: false,
    indentSeq: true,
    flowCollectionPadding: false,
  });
  return `---\n${yamlText}---\n${message.body}`;
}

// ---------------------------------------------------------------------------
// kickoff.md
// ---------------------------------------------------------------------------

export const kickoffFrontmatterSchema = z.strictObject({
  protocol_version: z.literal(1),
  goal: goalId,
  lead: agentId,
  challenger: agentId,
  agents: z.array(agentId).min(2),
  budgets: partialBudgetsSchema.default({}),
  project: z.string().min(1),
  vault: z.string().min(1),
  created: isoTs,
  by: agentId,
});

/** A `- AC<n>: <criterion>` line of kickoff.md; the store refuses a goal text shaped like one. */
export const AC_LINE_PATTERN = /^- AC([1-9][0-9]*): (.+)$/;

/**
 * Every Unicode line terminator: CR, LF, VT, FF, NEL (U+0085), LS (U+2028),
 * PS (U+2029). kickoff.md is line based, so the store refuses a goal or
 * criterion containing one; `.` in AC_LINE_PATTERN stops at CR, LF, LS, PS,
 * and editors and other readers break lines at the rest.
 */
export const LINE_TERMINATOR = /[\r\n\v\f\u0085\u2028\u2029]/;

/**
 * Parse kickoff.md: frontmatter, goal text, and the `- AC<n>: <criterion>` lines.
 * The criteria are the unbroken run of AC lines that ends the body; everything
 * above it is goal text, so an AC-shaped line inside the goal (a hand-edited
 * file) stays goal text instead of shifting the numbering.
 */
export function parseKickoffFile(text: string): Kickoff {
  const { frontmatter, body } = splitFrontmatter(text);
  const parsed = kickoffFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const { field, problem } = describeIssue(parsed.error.issues[0], frontmatter);
    throw schemaError(field, problem);
  }
  const lines = body.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const acLines: RegExpExecArray[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = AC_LINE_PATTERN.exec(lines[index]);
    if (match === null) break;
    acLines.unshift(match);
  }
  if (acLines.length === 0) {
    throw schemaError("body", "needs at least one `- AC<n>: <criterion>` line");
  }
  const acceptance_criteria = acLines.map((match, index) => {
    if (Number(match[1]) !== index + 1) {
      throw schemaError("body", `AC${match[1]} is out of order`);
    }
    return match[2].trim();
  });
  const goal_text = lines.slice(0, lines.length - acLines.length).join("\n").trim();
  return { ...parsed.data, goal_text, acceptance_criteria };
}

// ---------------------------------------------------------------------------
// diarchy.config.json
// ---------------------------------------------------------------------------

export const configSchema = z.object({
  protocol_version: z.literal(1),
  vault: z.string().min(1),
  agents: z
    .record(agentId, z.object({ command: z.string().min(1) }))
    .refine((agents) => Object.keys(agents).length <= MAX_AGENTS, {
      message: `protocol_version 1 runs exactly ${MAX_AGENTS} agents, one lead and one challenger (PROTOCOL.md section 11)`,
    }),
  budgets: partialBudgetsSchema.default({}),
  worktrees: z
    .object({ root: z.string().min(1), branch_prefix: z.string().min(1) })
    .default({ root: ".diarchy/worktrees", branch_prefix: "diarchy" }),
  review: z.object({ required: z.boolean() }).default({ required: true }),
});

export function parseConfig(input: unknown): DiarchyConfig {
  return configSchema.parse(input);
}

// ---------------------------------------------------------------------------
// budget.json (GoalState)
// ---------------------------------------------------------------------------

const decisionStateSchema = z.strictObject({
  status: z.enum(["open", "decided", "superseded"]),
  proposer: agentId.nullable(),
  messages: z.number().int().nonnegative(),
  challenges: z.number().int().nonnegative(),
  supersedes: decisionId.nullable(),
  superseded_by: decisionId.nullable(),
  evidence: z.array(z.string()),
  challenge: z
    .strictObject({ id: messageId, from: agentId, new_evidence: z.array(z.string()) })
    .nullable(),
});

export const goalStateSchema = z.strictObject({
  protocol_version: z.literal(1),
  goal: goalId,
  created: isoTs,
  lead: agentId,
  challenger: agentId,
  agents: z.array(agentId).min(2),
  kickoff_id: messageId.nullable(),
  phase: z.enum(PHASES),
  blocked_from: z.enum(PHASES).nullable(),
  limits: budgetLimitsSchema,
  used: z.strictObject({
    plan_messages: z.number().int().nonnegative(),
    messages_total: z.number().int().nonnegative(),
    talk_since_work: z.number().int().nonnegative(),
    wall_clock_minutes: z.number().nonnegative(),
    spend_usd: z.number().nonnegative(),
  }),
  seq: z.record(agentId, z.number().int().nonnegative()),
  last_ts: isoTs.nullable(),
  decisions: z.record(decisionId, decisionStateSchema),
  prs: z.record(
    url,
    z.strictObject({
      author: agentId,
      reviews: z.array(z.strictObject({ by: agentId, verdict: z.enum(REVIEW_VERDICTS) })),
    }),
  ),
  deadlock_watch: z
    .strictObject({
      decision_id: decisionId,
      challenge_id: messageId,
      remaining: z.number().int().nonnegative(),
      deadline: isoTs,
    })
    .nullable(),
  acs: z.record(
    z.string().regex(AC_ID_PATTERN),
    z.strictObject({ criterion: z.string(), status: z.enum(["open", "passing", "failing"]) }),
  ),
  tasks: z.record(
    taskId,
    z.strictObject({
      id: taskId,
      task: z.string(),
      kind: z.enum(ASSIGN_KINDS).nullable(),
      assignee: agentId.nullable(),
      branch: z.string().nullable(),
      worktree: z.string().nullable(),
      pr: z.string().nullable(),
      status: z.enum(TASK_STATUSES),
    }),
  ),
  messages: z.array(
    z.strictObject({
      id: messageId,
      from: agentId,
      type: z.enum(MESSAGE_TYPES),
      decision_id: decisionId.nullable(),
      re: z.array(z.string()),
    }),
  ),
  review_required: z.boolean(),
  updated: isoTs,
});

/** Validate a budget.json snapshot loaded from disk. */
export function parseGoalState(input: unknown): GoalState {
  return goalStateSchema.parse(input);
}
