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
