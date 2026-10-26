import { type LockOwner } from "../vault/index.js";
export declare const GATE_CAP = 12;
export declare function runInboxSkim(projectDir: string, agent: string): string[];
/** One record per session, so blocks of one session never use up another's GATE_CAP. */
export declare function gateRecordPath(projectDir: string, agent: string, session?: string | null): string;
export interface GateDecision {
    decision: "block";
    reason: string;
}
/**
 * Whether `argv` is a launch wrapper a CLI may start its MCP server through:
 * a shell, env, npx or `npm exec` (whose process title reads `npm exec`),
 * pnpm, yarn, bunx, or bin/diarchy.js handing `mcp` on to the diarchy on PATH.
 */
export declare function isLaunchWrapper(argv: string[]): boolean;
/** What the gate reads about processes; the defaults are this process's, and tests pass their own. */
export interface ProcessProbe {
    /** Where this process's locks say they come from (LOCK_HOST). */
    host: string;
    pid: number;
    /** The parent of `pid`, or null when it cannot be read. */
    parentOf(pid: number): number | null;
    /** Whether `pid` is a launch wrapper (`isLaunchWrapper`); without it, no process is one. */
    isWrapper?(pid: number): boolean;
}
/**
 * True only when the lease `holder` is surely another session's MCP server,
 * so this session's tools only get AGENT_BUSY. The hook and the session's own
 * server are both children of the same CLI process, so a holder whose parent
 * is one of this hook's ancestors is this session's server, and one whose
 * parent is not on the hook's chain, read up to pid 1, is another session's.
 * A CLI may start its server through launch wrappers (`sh -c`, npx, or
 * bin/diarchy.js handing on to the diarchy on PATH, `isLaunchWrapper`): up to
 * MAX_WRAPPERS of them are stepped over, so the parent compared is the CLI.
 * When it cannot tell, it answers false and the gate blocks as it would with
 * no lease: the owner file is not readable or not written yet; the holder's
 * parent is pid 1 (a CLI that is itself pid 1 in a container, or an orphaned
 * server); a parent cannot be read (Windows); more than MAX_WRAPPERS wrappers
 * stand in a row; or the holder is on this machine but in another pid
 * namespace, where its pids mean nothing here. A holder on another machine is
 * another session.
 */
export declare function heldByAnotherSession(holder: LockOwner | null, probe?: ProcessProbe): boolean;
/** How many times in a row the gate has blocked the session this Stop event names (0 once nothing is owed). */
export declare function gateBlockCount(projectDir: string, agent: string, hookJson?: string): number;
/**
 * The block decision, or null to let the turn end. `hookJson` is the Stop
 * event on stdin; its `session_id` keys the GATE_CAP record.
 */
export declare function runGate(projectDir: string, agent: string, hookJson?: string): GateDecision | null;
/**
 * The human subcommand a shell command would run (`reply` or `stop`), else
 * null. It denies what the original guard denied and lets through only text
 * that never runs:
 *
 * 1. The command is split on shell operators (`;`, `|`, `&`, `(`, `)`,
 *    backtick, newline, `$(`) with quoting ignored, and each piece is read as
 *    `[VAR=x ...] [sudo|env|timeout 60|npx|then|{ ...] <program> [--project <dir>]
 *    <subcommand>`, so `grep "diarchy reply" docs/` does not count while
 *    `bash -c 'x; diarchy stop now'`, a `bash <<'EOF'` script, and `eval` do.
 * 2. A hit from 1 is let through only when it lies wholly inside inert text
 *    (single quotes, double quotes without `$(` or backtick, or a `<<'EOF'`,
 *    `<<"EOF"`, or `<<\EOF` body) that is an argument or the stdin of a data
 *    program (echo, cat, tee, printf without -v, git commit|tag|notes, gh
 *    pr|issue|release|api) whose pipeline is all data programs and whose
 *    `$(...)`, if any, is an argument of one too: the commit and PR body
 *    heredocs, `cat >> notes.md <<'EOF'`, `echo "x; diarchy stop now"`.
 *    Nothing is let through when the line names a shell, eval, or source, or
 *    uses syntax the reader does not follow (`readShell`).
 * 3. Quote removal can add a deny: `"diarchy" reply`, a shell's `-c` string
 *    or here-string wherever the shell stands (`env sh -o pipefail -c "..."`),
 *    and `eval`'s arguments are read too.
 *
 * Best effort by design: an alias, a function, a wrapper script, and a script
 * written to a file and run by a later Bash call are not unpacked (ANTI-SLOP.md,
 * What this does NOT prevent).
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
/** The human subcommand the hook event's `tool_input.command` runs, else null (also for anything that is not such an event). */
export declare function guardedCommand(hookJson: string): "reply" | "stop" | null;
export declare function guardDecision(agent: string, subcommand: "reply" | "stop"): GuardDecision;
