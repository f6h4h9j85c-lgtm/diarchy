import { type LockOwner } from "../vault/index.js";
export declare const GATE_CAP = 12;
export declare function runInboxSkim(projectDir: string, agent: string): string[];
/** One record per session, so blocks of one session never use up another's GATE_CAP. */
export declare function gateRecordPath(projectDir: string, agent: string, session?: string | null): string;
export interface GateDecision {
    decision: "block";
    reason: string;
}
/** What the gate reads about processes; the defaults are this process's, and tests pass their own. */
export interface ProcessProbe {
    /** Where this process's locks say they come from (LOCK_HOST). */
    host: string;
    pid: number;
    /** The parent of `pid`, or null when it cannot be read. */
    parentOf(pid: number): number | null;
}
/**
 * True only when the lease `holder` is surely another session's MCP server,
 * so this session's tools only get AGENT_BUSY. The hook and the session's own
 * server are both children of the same CLI process, so a holder whose parent
 * is one of this hook's ancestors is this session's server, and one whose
 * parent is not on the hook's chain, read up to pid 1, is another session's.
 * When it cannot tell, it answers false and the gate blocks as it would with
 * no lease: the owner file is not readable or not written yet; the holder's
 * parent is pid 1 (a CLI that is itself pid 1 in a container, or an orphaned
 * server); a parent cannot be read (Windows); or the holder is on this
 * machine but in another pid namespace, where its pids mean nothing here. A
 * holder on another machine is another session. Limit: a server the CLI
 * starts through a wrapper process (a shell, npx) has the wrapper as its
 * parent and is taken for another session.
 */
export declare function heldByAnotherSession(holder: LockOwner | null, probe?: ProcessProbe): boolean;
/**
 * The block decision, or null to let the turn end. `hookJson` is the Stop
 * event on stdin; its `session_id` keys the GATE_CAP record.
 */
export declare function runGate(projectDir: string, agent: string, hookJson?: string): GateDecision | null;
/**
 * The human subcommand a shell command would run (`reply` or `stop`), else
 * null. Each simple command is read as `[VAR=x ...] [sudo|env|node|npx ...]
 * <program> [--project <dir>] <subcommand>`, so the words inside an argument
 * (`grep "diarchy reply" docs/`) do not count. Best effort by design: a
 * `bash -c '...'` string, an alias, or a wrapper script is not unpacked
 * (ANTI-SLOP.md, What this does NOT prevent).
 */
export declare function humanCommand(command: string): "reply" | "stop" | null;
export interface GuardDecision {
    hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
    };
}
/**
 * The PreToolUse deny for a shell call that runs `diarchy reply` or
 * `diarchy stop`, else null. `hookJson` is the hook event on stdin; anything
 * that is not an event with a string `tool_input.command` is let through.
 */
export declare function runGuard(agent: string, hookJson: string): GuardDecision | null;
