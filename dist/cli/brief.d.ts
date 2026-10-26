/**
 * What a goal needs from an agent or the human right now. Shared by `status`,
 * `inbox-skim`, and `gate`; pure over GoalState plus the message list, except
 * for reading an inbox cursor file (never writing it).
 */
import { type AgentId, type GoalState, type Message, type TaskStatus } from "../protocol/index.js";
import { type GoalRef } from "../vault/index.js";
export interface Assignment {
    task: string;
    kind: "implement" | "review";
    text: string;
    assignee: AgentId;
    branch: string | null;
    pr: string | null;
    status: TaskStatus;
}
/** Tasks still owed: implement tasks not done, review tasks whose review is still owed (`reviewOwed`, as BUSY_REVIEWING counts them). */
export declare function openAssignments(state: GoalState, agent?: AgentId): Assignment[];
export interface ChallengedThread {
    id: string;
    from: AgentId;
    challengeId: string;
    /** False for a decided thread (an EXECUTE CHALLENGE): only a DECIDE with `supersedes` answers it. */
    open: boolean;
}
/** Decisions whose CHALLENGE still awaits the lead's DECIDE, open or decided; the one the deadlock watch is on first. */
export declare function challengedThreads(state: GoalState): ChallengedThread[];
export interface ChangesRequested {
    url: string;
    author: AgentId;
    /** The agent whose latest review of the PR asked for changes. */
    by: AgentId;
    /** The author has posted a STATUS with a commit for this PR since that review. */
    fixed: boolean;
}
/** PRs no other agent has approved whose latest review by another agent is request_changes (the fix and re-review loop). */
export declare function changesRequested(state: GoalState, messages: Message[]): ChangesRequested[];
/**
 * ACs the lead still owes an implement task in EXECUTE. A plan DECIDE that
 * carried `tasks` already mapped tasks to ACs, so its todo tasks drive the
 * brief and none is owed here. Otherwise (a human ruling, or a DECIDE with no
 * tasks, closed plan) every AC not yet passing is owed until an implement
 * ASSIGN cites it in `re`; one task may cover several ACs.
 */
export declare function uncoveredAcs(state: GoalState, messages: Message[]): string[];
/**
 * Messages after the agent's inbox cursor, excluding its own. Reads the cursor
 * file, never moves it; one that will not parse counts as no cursor, as in the store.
 */
export declare function unreadFor(goal: GoalRef, messages: Message[], agent: AgentId): Message[];
/**
 * The `diarchy reply` invocation that answers the current block, mirroring the
 * goal.md question callout (RENDERING.md 4.1). Null unless BLOCKED.
 */
export declare function replyHint(state: GoalState, messages: Message[]): string | null;
/** Why the run is BLOCKED, in one short clause. */
export declare function blockSummary(state: GoalState, messages: Message[]): string;
/** Which store trigger blocked the run: WALL_CLOCK (clock or spend), TOTAL_BUDGET, DEADLOCK, BLOCKED, or STOP. */
export declare function blockReason(state: GoalState, messages: Message[]): "WALL_CLOCK" | "TOTAL_BUDGET" | "DEADLOCK" | "BLOCKED" | "STOP";
export interface NextStep {
    /** Imperative, names the MCP tool to call. One line: agent-authored parts pass through `oneLine`. */
    text: string;
    /** True when the agent owes the goal something now (the Stop gate blocks on this). */
    owes: boolean;
}
/** The imperative next step for `agent`, in priority order. */
export declare function nextStep(state: GoalState, messages: Message[], agent: AgentId, unread: Message[]): NextStep;
