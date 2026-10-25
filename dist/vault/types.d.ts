/** Public types of the vault store (docs/PROTOCOL.md sections 2 and 10). */
import type { AgentId, BudgetLimits, BudgetUsed, DiarchyConfig, Message, MessageType, Phase, Rejection, Role } from "../protocol/index.js";
import type { GoalPaths } from "./config.js";
export interface VaultStoreOptions {
    projectDir: string;
    config: DiarchyConfig;
    agent: AgentId;
    /** Clock; tests inject a fake. */
    now?: () => Date;
    /** Waits for a future message ts under the lock; tests advance their fake clock instead. */
    sleep?: (ms: number) => Promise<void>;
    /** Timezone of the local-time hint in rendered files; default: the host's. */
    localTz?: string;
    pollIntervalMs?: number;
}
export interface GoalRef {
    goalId: string;
    phase: Phase;
    lead: AgentId;
    challenger: AgentId;
    created: string;
    paths: GoalPaths;
}
/** Everything the caller supplies; the store assigns id, goal, phase, ts, and `from` defaults to the store's agent. */
export type MessageDraft = Omit<Message, "protocol_version" | "id" | "goal" | "from" | "phase" | "ts" | "body"> & {
    from?: AgentId;
    body?: string;
};
export interface KickoffInput {
    goal: string;
    acceptance_criteria: string[];
    lead?: AgentId;
    budgets?: Partial<BudgetLimits>;
    /** Overrides the slug derived from the goal text. */
    slug?: string;
    /** Overrides the whole `<YYYYMMDD>-<slug>` id. */
    goal_id?: string;
}
export interface BudgetSnapshot {
    used: BudgetUsed;
    limits: BudgetLimits;
}
export interface PostOk {
    ok: true;
    id: string;
    ts: string;
    seq: number;
    decision_id?: string;
    phase: Phase;
    allowed_types: MessageType[];
    budgets: BudgetSnapshot;
}
export type PostResult = PostOk | Rejection;
export interface KickoffOk extends PostOk {
    goal_id: string;
    lead: AgentId;
    challenger: AgentId;
    kickoff_id: string;
}
export type KickoffResult = KickoffOk | Rejection;
export interface ReadResult {
    goal: string;
    phase: Phase;
    role: Role;
    allowed_types: MessageType[];
    budgets: BudgetSnapshot;
    lead: AgentId;
    challenger: AgentId;
    messages: Message[];
    cursor: string | null;
}
export interface WaitProgress {
    elapsedMs: number;
    phase: Phase;
}
export interface WaitOptions {
    timeoutMs?: number;
    onProgress?: (progress: WaitProgress) => void;
}
export type WaitResult = ReadResult | {
    timeout: true;
};
export interface ReplyOptions {
    decision?: string;
    budgets?: Partial<BudgetLimits>;
    /** Free text under the one-sentence ruling (`text` is the DECIDE claim). */
    body?: string;
}
export declare class NoGoalError extends Error {
    constructor();
}
