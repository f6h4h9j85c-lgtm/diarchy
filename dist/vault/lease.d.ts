import type { AgentId } from "../protocol/index.js";
import type { GoalPaths } from "./config.js";
import { type LockOwner } from "./lock.js";
/** The live server that holds `agent`'s lease on the goal, or null when the lease is free or stale; never claims it. */
export declare function leaseHolder(paths: GoalPaths, agent: AgentId): LockOwner | null;
export declare class AgentLease {
    private readonly agent;
    /** Lease directory -> our owner token. */
    private readonly held;
    private heartbeat;
    constructor(agent: AgentId);
    /** null when this server may act as its agent on the goal; otherwise the live server that holds it. */
    claim(paths: GoalPaths): LockOwner | null;
    /** Give up every lease this server holds (on close). */
    release(): void;
    private startHeartbeat;
}
