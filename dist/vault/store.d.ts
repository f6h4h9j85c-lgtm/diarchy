import { type AgentId, type GoalState, type Kickoff, type Message } from "../protocol/index.js";
import { CorruptVaultFileError } from "./types.js";
import type { GoalRef, KickoffInput, KickoffResult, MessageDraft, PostResult, ReadResult, ReplyOptions, VaultStoreOptions, WaitOptions, WaitResult } from "./types.js";
export { LOCK_STALE_MS } from "./lock.js";
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
    /** Per goal directory: chat/ files the open transaction wrote since its last budget.json commit. */
    private readonly uncommitted;
    /** budget.json and inbox files already reported as unreadable, so a poll loop warns once. */
    private readonly warned;
    constructor(options: VaultStoreOptions);
    /**
     * Every readable goal whose KICKOFF committed, oldest first. A goal whose
     * budget.json does not parse (damaged, or another protocol_version) is left
     * out with one stderr warning naming the file; it still blocks kickoff, and
     * when no readable goal started after it, activeGoal and every tool throw
     * CorruptVaultFileError naming it (PROTOCOL.md 2.3).
     */
    listGoals(): GoalRef[];
    /** The readable goals, oldest first, and the goal directories whose budget.json will not parse. */
    private scanGoals;
    private warnUnreadable;
    private kickoffCreated;
    /**
     * The readable goals, oldest first. Throws CorruptVaultFileError when a goal
     * whose budget.json will not parse is not older than all of them: that goal
     * may be the active one, so answering with no goal or an older goal would
     * hide it.
     */
    private knownGoals;
    /** The one goal in PLAN, EXECUTE, or BLOCKED, if any. */
    activeGoal(): GoalRef | null;
    /** The active goal, else the newest (so `read` keeps working after DONE). */
    private currentGoal;
    private requireGoal;
    state(): GoalState | null;
    /**
     * The active goal's committed messages. A committed file that will not parse
     * throws CorruptVaultFileError, unless `onCorrupt` is given: then the file is
     * left out and its error handed to `onCorrupt`, so a human-facing reader
     * (status, watch, the launcher) keeps working and can name the file.
     */
    listMessages(onCorrupt?: (error: CorruptVaultFileError) => void): Message[];
    readKickoff(): Kickoff | null;
    /** Re-render goal.md, chat.md, decisions.md from the files on disk. */
    render(): void;
    /**
     * Start a goal. The whole kickoff runs under the vault lock (goals/.lock), so
     * two PMs kicking off at once cannot both start a goal: the second sees the
     * first one active and gets SINGLE_KICKOFF.
     */
    kickoff(input: KickoffInput): Promise<KickoffResult>;
    /** SINGLE_KICKOFF while a goal is active, or while a goal whose budget.json will not parse may be. */
    private kickoffRefusal;
    private kickoffLocked;
    /**
     * Shape checks before anything is written. kickoff.md is line based (goal
     * text, blank line, `- AC<n>: <criterion>` lines), so a goal or criterion
     * with any line terminator or an unpaired surrogate, or a goal shaped like
     * an AC line, would not parse back to what was posted; those are SCHEMA
     * here rather than a wedged goal later.
     */
    private kickoffProblem;
    /**
     * `<YYYYMMDD>-<slug>`, slug from `slug` or the goal text (a time-based
     * `goal-HHMMSS` when the text has no Latin letters or digits). Under the vault
     * lock no goal is active, so a committed goal holding the id is a finished
     * one: a derived slug gets the first free `-2`, `-3`, ... suffix, while a
     * `slug` the caller chose is refused with SINGLE_KICKOFF and an explicit
     * `goal_id` with SCHEMA. A directory an interrupted kickoff left holds no id.
     */
    private newGoalId;
    /** A committed goal holds the id; what an interrupted kickoff left does not (PROTOCOL.md 2.2). */
    private goalIdTaken;
    /** A PM kicking off leads; the launcher alternates from the previous goal's lead. */
    private defaultLead;
    /**
     * One transaction (PROTOCOL.md 2.2): lock, recover, tick, evaluate, write,
     * effects, persist (the commit), render. A BLOCKED with kind external loads
     * the kickoff the way the human's commands do, so a PM can still page the
     * human when kickoff.md is corrupt; every other post needs kickoff.md to parse.
     */
    post(draft: MessageDraft): Promise<PostResult>;
    /** `post` with the kickoff loader chosen by the caller: strict for PMs, recovering for escalation and the human. */
    private postWith;
    /** Assign id, evaluate, and on acceptance write the message file. Call under the lock. */
    private accept;
    /**
     * Work-evidence keys of the committed STATUS messages (PROTOCOL.md 3.1),
     * which budget.json does not keep. A file that will not parse is left out,
     * so it cannot block a post; its evidence then counts as new once.
     */
    private workSeen;
    /** Write the system ASK_HUMAN for every `system_message` effect through the same path. */
    private applyEffects;
    /** Time-based transitions (DEADLOCK deadline, WALL_CLOCK) land before anything else. Call under the lock. */
    private tickLocked;
    private postOk;
    /** Goal text, ACs with status, and messages after this agent's cursor, excluding its own; advances the cursor. */
    read(options?: {
        since?: string;
    }): ReadResult | null;
    /** `read` without its side effect: what a read would deliver now, and the cursor that delivery commits. */
    private peek;
    /** Save the cursor when it moved, or when the stored file will not parse (PROTOCOL.md 2.3). */
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
    /**
     * stop, reply, and a BLOCKED kind external must work even when kickoff.md
     * is missing or will not parse (a hand edit, or a file written before the
     * kickoff shape checks), so a PM can page the human and the human can
     * always retire a wedged goal. The renderers only need what budget.json and
     * the KICKOFF message already hold.
     */
    private kickoffOrRebuilt;
    /**
     * Writing budget.json commits a transaction (PROTOCOL.md 2.2). A throw removes
     * the chat/ files written since the last commit; a crash's leftovers are moved
     * aside by the next transaction before it reads anything.
     */
    private withLock;
    /** Under the lock: a chat/ file whose id budget.json does not record never committed; move it to chat/.orphans/. */
    private recoverOrphans;
    /** The store never writes a message whose ts is still in the future. */
    private waitUntil;
    /** chat/ files are writer-owned and immutable: own agent or system only, never overwritten. */
    private writeMessage;
    /**
     * The committed messages: chat/ files whose id `state` records, in (ts, seq)
     * order; nothing else is read or rendered. A committed file that will not
     * parse throws CorruptVaultFileError, unless `skipCorrupt`: the rendered
     * views and the human's recovery paths leave it out so a corrupt file cannot
     * block them (a function `skipCorrupt` also receives each error).
     */
    private readMessages;
    /** budget.json of one goal; a file that will not parse throws CorruptVaultFileError naming it. */
    private loadState;
    /**
     * The goal's state once its KICKOFF has committed; null when the directory
     * holds no goal, or only what a kickoff that died before its commit left
     * (no budget.json, or one without a KICKOFF from before that write moved).
     */
    private committedState;
    /** The commit point: every chat/ file written so far is now accepted. */
    private persist;
    private loadKickoff;
    /** This agent's cursor; an inbox file that will not parse reads as null, with one stderr warning naming it. */
    private loadCursor;
    private saveCursor;
    /**
     * Render after a commit. The transaction has committed, so a render failure
     * is logged, not thrown: reporting it as an error would invite a retry that
     * posts the message twice. The next transaction or `diarchy render` renders again.
     */
    private renderCommitted;
    private renderFiles;
}
/**
 * The cursor an inbox/<agent>.json holds: null when the file is missing, and
 * also when it will not parse or is not this agent's protocol_version 1 inbox
 * (`corrupt`). The cursor only saves re-delivery, and delivering messages
 * again is safe, so a damaged file never blocks a read.
 */
export declare function readInbox(path: string, agent: AgentId): {
    cursor: string | null;
    corrupt: boolean;
};
