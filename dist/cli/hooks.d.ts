export declare const GATE_CAP = 12;
export declare function runInboxSkim(projectDir: string, agent: string): string[];
export declare function gateRecordPath(projectDir: string, agent: string): string;
export interface GateDecision {
    decision: "block";
    reason: string;
}
/** The block decision, or null to let the turn end. The hook JSON on stdin is drained by the caller and not needed. */
export declare function runGate(projectDir: string, agent: string): GateDecision | null;
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
