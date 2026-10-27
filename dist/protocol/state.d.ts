/** Read-only queries over GoalState shared by the rules and the engine. */
import { type AgentId, type DeadlockWatch, type EvidenceItem, type GoalState, type Message, type MessageRef, type MessageType, type TaskState } from "./types.js";
export type Role = "lead" | "challenger" | "human" | "system" | "unknown";
export declare function isPm(state: GoalState, agent: string): boolean;
export declare function isKnownSender(state: GoalState, agent: string): boolean;
export declare function roleOf(state: GoalState, agent: string): Role;
export declare function challengers(state: GoalState): AgentId[];
export declare function minutesSince(iso: string, now: Date): number;
export type LimitHit = "wall_clock" | "spend";
/** WALL_CLOCK: wall clock, or spend when a spend limit is configured. */
export declare function limitHit(state: GoalState, now: Date): LimitHit | null;
export declare function totalBudgetReached(state: GoalState): boolean;
export declare function planBudgetSpent(state: GoalState): boolean;
export declare function talkRatioReached(state: GoalState): boolean;
export declare function deadlinePassed(watch: DeadlockWatch, now: Date): boolean;
export declare function messageRef(state: GoalState, id: string): MessageRef | undefined;
/** The decision a PROPOSE/CHALLENGE/DECIDE acts on: `decision_id`, else `supersedes`. */
export declare function targetDecisionId(message: Message): string | undefined;
/** A decision id followed by every decision it supersedes, transitively. */
export declare function decisionLineage(state: GoalState, id: string): string[];
export declare function openThreads(state: GoalState): string[];
/** Open threads other than `plan`: PHASE_GATE refuses DECIDE `plan` until each is decided (PROTOCOL.md section 6). */
export declare function threadsBeforePlan(state: GoalState): string[];
export declare function challengeCount(state: GoalState, id: string): number;
export declare function nextDecisionId(state: GoalState): string;
export declare function nextTaskId(state: GoalState): string;
/** DECIDE that answers the CHALLENGE still open on its decision (TALK_WORK_RATIO exemption). */
export declare function repliesToOpenChallenge(state: GoalState, message: Message): boolean;
export declare function evidenceKey(item: EvidenceItem): string;
export declare function qualifiesAsNew(item: EvidenceItem): boolean;
export declare function citedEvidenceKeys(state: GoalState, decisionId: string): Set<string>;
/** Keys of the items that count as new evidence relative to `decisionId`. */
export declare function newEvidenceKeys(state: GoalState, decisionId: string, items: EvidenceItem[]): string[];
/**
 * The key that tells repeated work evidence from new, or null for an item
 * that is not work evidence (`file`, `human`, `external`, a pending `test`).
 * A review keys on its sender and verdict too, so a re-review that changes
 * the verdict is new; a test keys on its result, so a fixed test is new.
 */
export declare function workEvidenceKey(from: AgentId, item: EvidenceItem): string | null;
/** The work-evidence keys a message carries; only a STATUS carries any, since only a STATUS resets talk_since_work. */
export declare function workEvidenceKeys(message: Message): string[];
/** Did an earlier STATUS carry this key? A sha matches a seen sha it prefixes or that prefixes it (short and full forms). */
export declare function workEvidenceSeen(key: string, seen: readonly string[]): boolean;
/** Who introduced a PR: the registry, or this very message's `pr` item. */
export declare function prAuthor(state: GoalState, message: Message, url: string): AgentId | undefined;
/** Has `agent` introduced a PR on this goal (first `pr` evidence)? DONE 9.2(f). */
export declare function authoredPr(state: GoalState, agent: AgentId | null): boolean;
/**
 * Does this review task still owe its review? The engine closes a review task
 * only when its assignee's `review` evidence on the PR lands (task_status on
 * it changes nothing), so one that is not done is owed, a
 * re-review ASSIGNed after an earlier review included. A done task with no
 * review from its assignee is still owed: diarchy 0.2.0 and older let a STATUS
 * mark a review task done, and goals they stored keep that status.
 */
export declare function reviewOwed(state: GoalState, task: TaskState): boolean;
/** The PR an agent still owes a review on, if any (BUSY_REVIEWING). */
export declare function pendingReviewUrl(state: GoalState, agent: AgentId): string | undefined;
/** Is `type` legal in the current phase for any sender? */
export declare function phaseAllows(state: GoalState, type: MessageType): boolean;
/** May this role post `type` now? DECIDE is the lead's, except in BLOCKED where it is the human's. */
export declare function roleAllows(state: GoalState, role: Role, type: MessageType): boolean;
/** Types the agent may post now, after phase, role, thread, and budget gates. */
export declare function allowedTypes(state: GoalState, agent: AgentId): MessageType[];
