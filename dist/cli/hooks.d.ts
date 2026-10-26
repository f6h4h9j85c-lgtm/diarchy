export declare const GATE_CAP = 12;
export declare function runInboxSkim(projectDir: string, agent: string): string[];
/** One record per session, so blocks of one session never use up another's GATE_CAP. */
export declare function gateRecordPath(projectDir: string, agent: string, session?: string | null): string;
export interface GateDecision {
    decision: "block";
    reason: string;
}
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
