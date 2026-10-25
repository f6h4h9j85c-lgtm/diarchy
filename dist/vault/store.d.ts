import { type AgentId, type GoalState, type Kickoff, type Message } from "../protocol/index.js";
import type { GoalRef, KickoffInput, KickoffResult, MessageDraft, PostResult, ReadResult, ReplyOptions, VaultStoreOptions, WaitOptions, WaitResult } from "./types.js";
export declare const LOCK_STALE_MS = 30000;
export declare const MAX_WAIT_MS = 110000;
export declare const PROGRESS_MS = 15000;
export declare const DEFAULT_POLL_MS = 500;
export declare class VaultStore {
    readonly agent: AgentId;
    private readonly projectDir;
    private readonly config;
    private readonly now;
    private readonly sleep;
    private readonly renderOptions;
    private readonly pollIntervalMs;
    constructor(options: VaultStoreOptions);
    /** Every goal with a budget.json, oldest first. */
    listGoals(): GoalRef[];
    /** The one goal in PLAN, EXECUTE, or BLOCKED, if any. */
    activeGoal(): GoalRef | null;
    /** The active goal, else the newest (so `read` keeps working after DONE). */
    private currentGoal;
    private requireGoal;
    state(): GoalState | null;
    listMessages(): Message[];
    readKickoff(): Kickoff | null;
    /** Re-render goal.md, chat.md, decisions.md from the files on disk. */
    render(): void;
    kickoff(input: KickoffInput): Promise<KickoffResult>;
    private kickoffProblem;
    /** A PM kicking off leads; the launcher alternates from the previous goal's lead. */
    private defaultLead;
    /** One transaction (PROTOCOL.md 2.2): lock, tick, evaluate, write, persist, effects, render. */
    post(draft: MessageDraft): Promise<PostResult>;
    /** Assign id, evaluate, and on acceptance write the message file. Call under the lock. */
    private accept;
    /** Write the system ASK_HUMAN for every `system_message` effect through the same path. */
    private applyEffects;
    /** Time-based transitions (DEADLOCK deadline, WALL_CLOCK) land before anything else. Call under the lock. */
    private tickLocked;
    private postOk;
    /** Messages after this agent's cursor, excluding its own; advances the cursor. */
    read(options?: {
        since?: string;
    }): ReadResult | null;
    /** `read` without its side effect: what a read would deliver now, and the cursor that delivery commits. */
    private peek;
    private commitCursor;
    /**
     * Resolve as soon as a `read` would deliver something, or `{ timeout: true }`.
     * Polls the chat directory every `pollIntervalMs` (fs.watch only wakes the
     * poll early), runs the engine tick on every poll, and reports progress every
     * 15 s. The inbox cursor moves only when a result is delivered: once
     * `options.signal` aborts, the wait returns `{ timeout: true }` at the next
     * wake without touching the cursor, so the reply reaches the caller's next
     * read or wait instead of being consumed by a call nobody is reading.
     */
    waitForReply(options?: WaitOptions): Promise<WaitResult>;
    /** Apply a due tick under the lock; returns whether the phase moved. */
    private tickIfDue;
    private watchChat;
    private chatMtime;
    /**
     * DECIDE `basis: human` answering the latest ASK_HUMAN; `decision` names the
     * thread to close (an open thread by `decision_id`, a decided one by
     * `supersedes`). A ruling without terminal punctuation gets a period so
     * `diarchy reply "continue"` is one claim.
     */
    reply(text: string, options?: ReplyOptions): Promise<PostResult>;
    /** Leave the goal BLOCKED with a human BLOCKED (external) message saying why. */
    stop(reason: string): Promise<PostResult>;
    private requireHuman;
    private withLock;
    private acquireLock;
    /** The store never writes a message whose ts is still in the future. */
    private waitUntil;
    /** chat/ files are writer-owned and immutable: own agent or system only, never overwritten. */
    private writeMessage;
    private readMessages;
    private loadState;
    private persist;
    private loadKickoff;
    private loadCursor;
    private saveCursor;
    private renderFiles;
}
