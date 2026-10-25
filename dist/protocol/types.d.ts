/**
 * Core types for the diarchy protocol engine (docs/PROTOCOL.md, docs/ANTI-SLOP.md).
 * Everything here is plain data; the engine is pure and side-effect free.
 */
export type AgentId = string;
export declare const AGENT_CLAUDE: AgentId;
export declare const AGENT_CODEX: AgentId;
export declare const AGENT_HUMAN: AgentId;
export declare const AGENT_SYSTEM: AgentId;
/** PROTOCOL.md section 11: agent ids are `[a-z][a-z0-9-]{1,15}`. */
export declare const AGENT_ID_PATTERN: RegExp;
export declare const MESSAGE_TYPES: readonly ["KICKOFF", "PROPOSE", "CHALLENGE", "DECIDE", "ASSIGN", "STATUS", "DONE", "BLOCKED", "ASK_HUMAN"];
export type MessageType = (typeof MESSAGE_TYPES)[number];
export declare const PHASES: readonly ["PLAN", "EXECUTE", "BLOCKED", "DONE"];
export type Phase = (typeof PHASES)[number];
export declare const DECISION_BASES: readonly ["test", "authority", "adopted-challenge", "human"];
export type DecisionBasis = (typeof DECISION_BASES)[number];
export declare const ASSIGN_KINDS: readonly ["implement", "review"];
export type AssignKind = (typeof ASSIGN_KINDS)[number];
export declare const BLOCKED_KINDS: readonly ["external", "internal"];
export type BlockedKind = (typeof BLOCKED_KINDS)[number];
export declare const ASSIGN_REASONS: readonly ["availability", "continuity", "load-balance"];
export type AssignReason = (typeof ASSIGN_REASONS)[number];
export declare const TASK_STATUSES: readonly ["todo", "assigned", "in_progress", "done"];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export declare const STATUS_TASK_STATUSES: readonly ["in_progress", "done"];
export type StatusTaskStatus = (typeof STATUS_TASK_STATUSES)[number];
export declare const AC_STATUSES: readonly ["open", "passing", "failing"];
export type AcStatus = (typeof AC_STATUSES)[number];
export declare const TEST_RESULTS: readonly ["pass", "fail", "pending"];
export type TestResult = (typeof TEST_RESULTS)[number];
export declare const REVIEW_VERDICTS: readonly ["approve", "request_changes"];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type EvidenceItem = {
    kind: "commit";
    sha: string;
} | {
    kind: "pr";
    url: string;
} | {
    kind: "test";
    test: string;
    result: TestResult;
    log?: string;
} | {
    kind: "file";
    path: string;
} | {
    kind: "review";
    url: string;
    verdict: ReviewVerdict;
} | {
    kind: "human";
    id: string;
} | {
    kind: "external";
    url: string;
    note?: string;
};
export type EvidenceKind = EvidenceItem["kind"];
export interface BudgetLimits {
    plan_messages: number;
    messages_total: number;
    challenges_per_decision: number;
    rounds_per_decision: number;
    talk_work_ratio: number;
    wall_clock_minutes: number;
    spend_usd: number | null;
}
export declare const DEFAULT_LIMITS: BudgetLimits;
export interface BudgetUsed {
    plan_messages: number;
    messages_total: number;
    talk_since_work: number;
    wall_clock_minutes: number;
    spend_usd: number;
}
/**
 * One chat message: frontmatter fields plus `body`. Type-specific fields are
 * optional at the type level; the schema (schema.ts) enforces which are
 * required per `type`. Rules receive a `Message` that has not necessarily
 * passed the schema yet (SCHEMA and TYPED_ONLY are themselves rules), so
 * early rules read fields defensively.
 */
export interface Message {
    protocol_version: number;
    id: string;
    goal: string;
    from: AgentId;
    to: string;
    type: MessageType;
    re: string[];
    phase: Phase;
    ts: string;
    body: string;
    reply_to?: string;
    claim?: string;
    evidence?: EvidenceItem[];
    decision_id?: string;
    basis?: DecisionBasis;
    supersedes?: string;
    tasks?: string[];
    ac_add?: string[];
    budgets?: Partial<BudgetLimits>;
    task?: string;
    new_task?: string;
    kind?: AssignKind | BlockedKind;
    worktree?: string;
    branch?: string;
    pr?: string;
    reason?: string;
    task_status?: StatusTaskStatus;
}
export type DecisionStatus = "open" | "decided" | "superseded";
/** The CHALLENGE awaiting the lead's DECIDE on a thread. */
export interface ChallengeRecord {
    id: string;
    from: AgentId;
    /** Evidence keys that qualified as new evidence when the CHALLENGE landed. */
    new_evidence: string[];
}
export interface DecisionState {
    status: DecisionStatus;
    proposer: AgentId | null;
    /** PROPOSE and CHALLENGE messages on the thread while open (TWO_ROUNDS). */
    messages: number;
    challenges: number;
    supersedes: string | null;
    superseded_by: string | null;
    /** `kind:key` of every evidence item cited on this decision (NEW_EVIDENCE). */
    evidence: string[];
    challenge: ChallengeRecord | null;
}
export interface ReviewRecord {
    by: AgentId;
    verdict: ReviewVerdict;
}
export interface PrState {
    author: AgentId;
    reviews: ReviewRecord[];
}
export interface TaskState {
    id: string;
    task: string;
    kind: AssignKind | null;
    assignee: AgentId | null;
    branch: string | null;
    worktree: string | null;
    pr: string | null;
    status: TaskStatus;
}
export interface DeadlockWatch {
    decision_id: string;
    challenge_id: string;
    remaining: number;
    deadline: string;
}
/** Compact index entry for an accepted message (reply_to existence etc.). */
export interface MessageRef {
    id: string;
    from: AgentId;
    type: MessageType;
    decision_id: string | null;
    re: string[];
}
export interface AcState {
    criterion: string;
    status: AcStatus;
}
export interface GoalState {
    protocol_version: 1;
    goal: string;
    /** kickoff `created`; wall clock counts from here. */
    created: string;
    lead: AgentId;
    challenger: AgentId;
    agents: AgentId[];
    /** id of the accepted KICKOFF, null before kickoff (SINGLE_KICKOFF). */
    kickoff_id: string | null;
    phase: Phase;
    blocked_from: Phase | null;
    limits: BudgetLimits;
    used: BudgetUsed;
    seq: Record<AgentId, number>;
    /** ts of the last id handed out; the next ts must strictly exceed it. */
    last_ts: string | null;
    decisions: Record<string, DecisionState>;
    prs: Record<string, PrState>;
    deadlock_watch: DeadlockWatch | null;
    /** Keyed by AC id in order (AC1, AC2, ...). */
    acs: Record<string, AcState>;
    /** Keyed by task id (T1, T2, ...). */
    tasks: Record<string, TaskState>;
    messages: MessageRef[];
    /** `review.required` from diarchy.config.json (waives DONE 9.2(c) and (f) when false). */
    review_required: boolean;
    updated: string;
}
export declare const RULE_IDS: readonly ["WRITER_OWNED", "SCHEMA", "TYPED_ONLY", "HUMAN_LAST_RESORT", "ONE_CLAIM", "WORD_CAP", "CHALLENGE_NEEDS_TEST", "NO_DOMAIN_ROUTING", "NO_ACK", "SINGLE_KICKOFF", "TOTAL_BUDGET", "WALL_CLOCK", "PHASE_GATE", "ROLE_GATE", "PLAN_BUDGET", "TALK_WORK_RATIO", "CITE_AC", "NEW_EVIDENCE", "ONE_CHALLENGE", "TWO_ROUNDS", "DECISION_IMMUTABLE", "NO_SELF_REVIEW", "BUSY_REVIEWING", "DONE_PRECONDITION", "DEADLOCK"];
export type RuleId = (typeof RULE_IDS)[number];
export interface Rejection {
    ok: false;
    rule: RuleId;
    message: string;
}
/** Why the store transitioned into BLOCKED and posted a system ASK_HUMAN. */
export type BlockReason = "BLOCKED" | "DEADLOCK" | "TOTAL_BUDGET" | "WALL_CLOCK";
export type Effect = {
    kind: "phase";
    from: Phase | null;
    to: Phase;
} | {
    kind: "system_message";
    type: "ASK_HUMAN";
    reason: BlockReason;
    to: "human";
    re: string[];
    body: string;
    reply_to: string | null;
    decision_id: string | null;
} | {
    kind: "decision_opened";
    id: string;
} | {
    kind: "decision_closed";
    id: string;
    supersedes: string | null;
} | {
    kind: "ac_status";
    ac: string;
    status: AcStatus;
} | {
    kind: "ac_added";
    ac: string;
    criterion: string;
} | {
    kind: "task";
    id: string;
    task: string;
    status: TaskStatus;
    assignee: AgentId | null;
    branch: string | null;
};
/** A state change the store must persist, with the effects it must act on. */
export interface Transition {
    ok: true;
    state: GoalState;
    effects: Effect[];
}
export interface Acceptance extends Transition {
    /** The message as the store must write it (store-assigned fields filled in). */
    message: Message;
}
export interface RuleContext {
    message: Message;
    state: GoalState;
    now: Date;
    callerAgent: AgentId;
}
export type Rule = (ctx: RuleContext) => Rejection | null;
export interface KickoffFrontmatter {
    protocol_version: 1;
    goal: string;
    lead: AgentId;
    challenger: AgentId;
    agents: AgentId[];
    budgets: Partial<BudgetLimits>;
    project: string;
    vault: string;
    created: string;
    by: AgentId;
}
/** kickoff.md: frontmatter plus the body's goal text and `- AC<n>: <criterion>` lines. */
export interface Kickoff extends KickoffFrontmatter {
    goal_text: string;
    acceptance_criteria: string[];
}
export interface DiarchyConfig {
    protocol_version: 1;
    vault: string;
    agents: Record<AgentId, {
        command: string;
    }>;
    budgets: Partial<BudgetLimits>;
    worktrees: {
        root: string;
        branch_prefix: string;
    };
    review: {
        required: boolean;
    };
}
