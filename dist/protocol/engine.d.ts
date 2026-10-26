import { type Acceptance, type AgentId, type DiarchyConfig, type GoalState, type Kickoff, type Message, type MessageType, type Rejection, type Transition } from "./types.js";
export { allowedTypes } from "./state.js";
export interface EvaluateOptions {
    now: Date;
    callerAgent: AgentId;
    /**
     * `workEvidenceKeys` of every STATUS already accepted on the goal. budget.json
     * does not keep them, so the store reads them from the committed chat/ files.
     * A STATUS resets talk_since_work only with a key not among them (PROTOCOL.md
     * 3.1); omitted, no key counts as seen.
     */
    workSeen?: readonly string[];
}
/** Run every rule in ANTI-SLOP.md order; on acceptance apply the transition. */
export declare function evaluate(message: Message, state: GoalState, options: EvaluateOptions): Acceptance | Rejection;
/** Time-based transitions for `wait_for_reply`: WALL_CLOCK and the DEADLOCK timer. */
export declare function tick(state: GoalState, now: Date): Transition | null;
/** Goal state right after kickoff.md is written, before the KICKOFF message is evaluated. */
export declare function initialState(kickoff: Kickoff, config: DiarchyConfig, now: Date): GoalState;
export interface AssignedId {
    id: string;
    ts: string;
    seq: number;
    state: GoalState;
}
/**
 * PROTOCOL.md 2.1: per-agent seq, and a ts strictly after the previous one
 * (the store sleeps to `ts` if it is in the future). Call under the goal lock.
 */
export declare function assignId(state: GoalState, from: AgentId, type: MessageType, now: Date): AssignedId;
