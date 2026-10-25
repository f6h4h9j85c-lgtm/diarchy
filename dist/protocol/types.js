/**
 * Core types for the diarchy protocol engine (docs/PROTOCOL.md, docs/ANTI-SLOP.md).
 * Everything here is plain data; the engine is pure and side-effect free.
 */
export const AGENT_CLAUDE = "claude";
export const AGENT_CODEX = "codex";
export const AGENT_HUMAN = "human";
export const AGENT_SYSTEM = "system";
/** PROTOCOL.md section 11: agent ids are `[a-z][a-z0-9-]{1,15}`. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,15}$/;
export const MESSAGE_TYPES = [
    "KICKOFF",
    "PROPOSE",
    "CHALLENGE",
    "DECIDE",
    "ASSIGN",
    "STATUS",
    "DONE",
    "BLOCKED",
    "ASK_HUMAN",
];
export const PHASES = ["PLAN", "EXECUTE", "BLOCKED", "DONE"];
export const DECISION_BASES = ["test", "authority", "adopted-challenge", "human"];
export const ASSIGN_KINDS = ["implement", "review"];
export const BLOCKED_KINDS = ["external", "internal"];
export const ASSIGN_REASONS = ["availability", "continuity", "load-balance"];
export const TASK_STATUSES = ["todo", "assigned", "in_progress", "done"];
export const STATUS_TASK_STATUSES = ["in_progress", "done"];
export const AC_STATUSES = ["open", "passing", "failing"];
export const TEST_RESULTS = ["pass", "fail", "pending"];
export const REVIEW_VERDICTS = ["approve", "request_changes"];
export const DEFAULT_LIMITS = {
    plan_messages: 12,
    messages_total: 80,
    challenges_per_decision: 1,
    rounds_per_decision: 2,
    talk_work_ratio: 3,
    wall_clock_minutes: 240,
    spend_usd: null,
};
// ---------------------------------------------------------------------------
// Rules and results
// ---------------------------------------------------------------------------
export const RULE_IDS = [
    "WRITER_OWNED",
    "SCHEMA",
    "TYPED_ONLY",
    "HUMAN_LAST_RESORT",
    "ONE_CLAIM",
    "WORD_CAP",
    "CHALLENGE_NEEDS_TEST",
    "NO_DOMAIN_ROUTING",
    "NO_ACK",
    "SINGLE_KICKOFF",
    "TOTAL_BUDGET",
    "WALL_CLOCK",
    "PHASE_GATE",
    "ROLE_GATE",
    "PLAN_BUDGET",
    "TALK_WORK_RATIO",
    "CITE_AC",
    "NEW_EVIDENCE",
    "ONE_CHALLENGE",
    "TWO_ROUNDS",
    "DECISION_IMMUTABLE",
    "NO_SELF_REVIEW",
    "BUSY_REVIEWING",
    "DONE_PRECONDITION",
    "DEADLOCK",
];
//# sourceMappingURL=types.js.map