/**
 * Zod schemas for message frontmatter (per type), evidence, kickoff.md,
 * diarchy.config.json, and budget.json, plus the YAML file (de)serializer.
 */
import { Document, isSeq, parse as parseYaml, visit } from "yaml";
import { z } from "zod";
import { wordCount } from "./text.js";
import { AGENT_HUMAN, AGENT_ID_PATTERN, ASSIGN_KINDS, BLOCKED_KINDS, DECISION_BASES, MAX_AGENTS, MESSAGE_TYPES, PHASES, REVIEW_VERDICTS, STATUS_TASK_STATUSES, TASK_STATUSES, TEST_RESULTS, } from "./types.js";
// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
export const MESSAGE_ID_PATTERN = /^(\d{8}T\d{6}Z)-(\d{4})-([a-z][a-z0-9-]{1,15})-([A-Z_]+)$/;
export const GOAL_ID_PATTERN = /^\d{8}-[a-z0-9-]{1,40}$/;
export const AC_ID_PATTERN = /^AC[1-9][0-9]*$/;
export const TASK_ID_PATTERN = /^T[1-9][0-9]*$/;
export const DECISION_ID_PATTERN = /^(plan|D[1-9][0-9]*)$/;
export const ISO_TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export function parseMessageId(id) {
    const match = MESSAGE_ID_PATTERN.exec(id);
    if (!match)
        return null;
    const [, ts_compact, seq, agent, type] = match;
    return { ts_compact, seq: Number(seq), agent, type };
}
/** `2026-10-25T14:30:12Z` -> `20261025T143012Z`. */
export function compactTs(ts) {
    return ts.replace(/[-:]/g, "");
}
/** Second-precision UTC ISO string without milliseconds. */
export function isoSeconds(date) {
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
const wordsMax = (max) => z.string().min(1).refine((text) => wordCount(text) <= max, `at most ${max} words`);
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
        log: z.string().min(1).optional(),
    }),
    z.strictObject({ kind: z.literal("file"), path: z.string().min(1) }),
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
        tasks: z.array(z.string().min(1)).optional(),
        ac_add: z.array(wordsMax(40)).optional(),
        budgets: partialBudgetsSchema.optional(),
    }),
    ASSIGN: z.strictObject({
        ...base,
        type: z.literal("ASSIGN"),
        task: taskId.optional(),
        new_task: z.string().min(1).optional(),
        kind: z.enum(ASSIGN_KINDS),
        worktree: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
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
};
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
export function schemaMessage(field, problem) {
    return `Field "${field}": ${problem}. Fix it per PROTOCOL.md section 3 and post again.`;
}
export function typedOnlyMessage(type) {
    return `Unknown type "${String(type)}". Use one of ${MESSAGE_TYPES.join(", ")}.`;
}
export function isMessageType(type) {
    return typeof type === "string" && MESSAGE_TYPES.includes(type);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function valueAt(input, path) {
    let current = input;
    for (const key of path) {
        if (current === null || typeof current !== "object")
            return undefined;
        current = current[key];
    }
    return current;
}
function describeIssue(issue, input) {
    if (issue.code === "unrecognized_keys") {
        return { field: issue.keys[0] ?? "frontmatter", problem: "unknown field" };
    }
    const field = issue.path.map(String).join(".") || "frontmatter";
    if (valueAt(input, issue.path) === undefined)
        return { field, problem: "required" };
    return { field, problem: issue.message };
}
function hasConclusiveTest(message) {
    return (message.evidence ?? []).some((item) => item.kind === "test" && (item.result === "pass" || item.result === "fail"));
}
/** PROTOCOL.md section 10: a human DECIDE may omit both; the store assigns the next D<n>. */
function decideProblem(message) {
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
function assignProblem(message) {
    const hasTask = message.task !== undefined;
    const hasNew = message.new_task !== undefined;
    if (hasTask === hasNew)
        return { field: "task", problem: "exactly one of task or new_task" };
    if (message.kind === "implement") {
        if (message.worktree === undefined)
            return { field: "worktree", problem: "required for kind implement" };
        if (message.branch === undefined)
            return { field: "branch", problem: "required for kind implement" };
        if (message.pr !== undefined)
            return { field: "pr", problem: "only for kind review" };
    }
    else {
        if (message.pr === undefined)
            return { field: "pr", problem: "required for kind review" };
        if (message.worktree !== undefined)
            return { field: "worktree", problem: "only for kind implement" };
        if (message.branch !== undefined)
            return { field: "branch", problem: "only for kind implement" };
    }
    return null;
}
/** Cross-field requirements PROTOCOL.md section 3 states in prose. */
export function conditionalProblem(message) {
    if (message.type === "DECIDE")
        return decideProblem(message);
    if (message.type === "ASSIGN")
        return assignProblem(message);
    return null;
}
function fail(rule, message, field) {
    return { ok: false, rule, message, field };
}
/**
 * Stateless validation of a message object. Runs the common fields first
 * (SCHEMA), then the type name (TYPED_ONLY), then the type-specific shape
 * (SCHEMA), matching the ANTI-SLOP.md evaluation order.
 */
export function checkMessageShape(input) {
    if (!isRecord(input))
        return fail("SCHEMA", schemaMessage("frontmatter", "must be a mapping"), "frontmatter");
    const common = commonSchema.safeParse(input);
    if (!common.success) {
        const { field, problem } = describeIssue(common.error.issues[0], input);
        return fail("SCHEMA", schemaMessage(field, problem), field);
    }
    if (!isMessageType(input.type))
        return fail("TYPED_ONLY", typedOnlyMessage(input.type), "type");
    const typed = messageSchemas[input.type].safeParse(input);
    if (!typed.success) {
        const { field, problem } = describeIssue(typed.error.issues[0], input);
        return fail("SCHEMA", schemaMessage(field, problem), field);
    }
    const message = typed.data;
    const conditional = conditionalProblem(message);
    if (conditional) {
        return fail("SCHEMA", schemaMessage(conditional.field, conditional.problem), conditional.field);
    }
    return { ok: true, message };
}
// ---------------------------------------------------------------------------
// Message files: YAML frontmatter + body
// ---------------------------------------------------------------------------
export class SchemaError extends Error {
    rule;
    field;
    constructor(rule, message, field = null) {
        super(message);
        this.name = "SchemaError";
        this.rule = rule;
        this.field = field;
    }
}
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
/** Split a markdown file into its YAML frontmatter mapping and body. */
export function splitFrontmatter(text) {
    const match = FRONTMATTER_PATTERN.exec(text);
    if (!match) {
        throw new SchemaError("SCHEMA", schemaMessage("frontmatter", "missing or unterminated"), "frontmatter");
    }
    const [, yamlText, body] = match;
    let parsed;
    try {
        parsed = parseYaml(yamlText, { schema: "core" });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
        throw new SchemaError("SCHEMA", schemaMessage("frontmatter", reason), "frontmatter");
    }
    if (!isRecord(parsed)) {
        throw new SchemaError("SCHEMA", schemaMessage("frontmatter", "must be a mapping"), "frontmatter");
    }
    return { frontmatter: coerceTimestamps(parsed), body };
}
/** PROTOCOL.md: `ts` is a string; undo any YAML timestamp coercion defensively. */
function coerceTimestamps(frontmatter) {
    const out = { ...frontmatter };
    for (const key of ["ts", "created"]) {
        const value = out[key];
        if (value instanceof Date)
            out[key] = isoSeconds(value);
    }
    return out;
}
/** Parse a `chat/<id>.md` file; throws `SchemaError` (SCHEMA or TYPED_ONLY). */
export function parseMessageFile(text) {
    const { frontmatter, body } = splitFrontmatter(text);
    const result = checkMessageShape({ ...frontmatter, body });
    if (!result.ok)
        throw new SchemaError(result.rule, result.message, result.field);
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
];
/** Strings holding quotes or flow indicators are double-quoted, as in the examples. */
const NEEDS_DOUBLE_QUOTE = /['"{}[\]]/;
function orderedFrontmatter(message) {
    const source = message;
    const ordered = {};
    for (const key of FRONTMATTER_KEY_ORDER) {
        if (source[key] !== undefined)
            ordered[key] = source[key];
    }
    for (const key of Object.keys(source).sort()) {
        if (key !== "body" && !(key in ordered) && source[key] !== undefined)
            ordered[key] = source[key];
    }
    return ordered;
}
/** Serialize to the canonical file text; round-trips the PROTOCOL.md examples byte for byte. */
export function serializeMessageFile(message) {
    const doc = new Document(orderedFrontmatter(message));
    const re = doc.get("re", true);
    if (isSeq(re))
        re.flow = true;
    visit(doc, {
        Scalar(_key, node) {
            if (typeof node.value === "string" && NEEDS_DOUBLE_QUOTE.test(node.value))
                node.type = "QUOTE_DOUBLE";
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
const AC_LINE_PATTERN = /^- AC([1-9][0-9]*): (.+)$/;
/** Parse kickoff.md: frontmatter, goal text, and the `- AC<n>: <criterion>` lines. */
export function parseKickoffFile(text) {
    const { frontmatter, body } = splitFrontmatter(text);
    const parsed = kickoffFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
        const { field, problem } = describeIssue(parsed.error.issues[0], frontmatter);
        throw new SchemaError("SCHEMA", schemaMessage(field, problem), field);
    }
    const goalLines = [];
    const acceptance_criteria = [];
    for (const line of body.split(/\r?\n/)) {
        const match = AC_LINE_PATTERN.exec(line);
        if (match) {
            if (Number(match[1]) !== acceptance_criteria.length + 1) {
                throw new SchemaError("SCHEMA", schemaMessage("body", `AC${match[1]} is out of order`), "body");
            }
            acceptance_criteria.push(match[2].trim());
        }
        else if (acceptance_criteria.length === 0) {
            goalLines.push(line);
        }
    }
    if (acceptance_criteria.length === 0) {
        throw new SchemaError("SCHEMA", schemaMessage("body", "needs at least one `- AC<n>: <criterion>` line"), "body");
    }
    return { ...parsed.data, goal_text: goalLines.join("\n").trim(), acceptance_criteria };
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
export function parseConfig(input) {
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
    prs: z.record(url, z.strictObject({
        author: agentId,
        reviews: z.array(z.strictObject({ by: agentId, verdict: z.enum(REVIEW_VERDICTS) })),
    })),
    deadlock_watch: z
        .strictObject({
        decision_id: decisionId,
        challenge_id: messageId,
        remaining: z.number().int().nonnegative(),
        deadline: isoTs,
    })
        .nullable(),
    acs: z.record(z.string().regex(AC_ID_PATTERN), z.strictObject({ criterion: z.string(), status: z.enum(["open", "passing", "failing"]) })),
    tasks: z.record(taskId, z.strictObject({
        id: taskId,
        task: z.string(),
        kind: z.enum(ASSIGN_KINDS).nullable(),
        assignee: agentId.nullable(),
        branch: z.string().nullable(),
        worktree: z.string().nullable(),
        pr: z.string().nullable(),
        status: z.enum(TASK_STATUSES),
    })),
    messages: z.array(z.strictObject({
        id: messageId,
        from: agentId,
        type: z.enum(MESSAGE_TYPES),
        decision_id: decisionId.nullable(),
        re: z.array(z.string()),
    })),
    review_required: z.boolean(),
    updated: isoTs,
});
/** Validate a budget.json snapshot loaded from disk. */
export function parseGoalState(input) {
    return goalStateSchema.parse(input);
}
//# sourceMappingURL=schema.js.map