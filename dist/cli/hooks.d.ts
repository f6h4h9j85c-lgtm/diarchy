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
 * null. Each simple command is read as `[VAR=x ...] [sudo|env|timeout 60|npx ...]
 * <program> [--project <dir>] <subcommand>` after quote removal, so the words
 * inside an argument (`grep "diarchy reply" docs/`), single-quoted text, and a
 * quoted-delimiter heredoc body (`<<'EOF'`) do not count, while a `$(...)` or
 * backtick substitution does, even inside double quotes. Three things are read
 * as command lines of their own: the string of `bash|sh|zsh|dash|ksh -c`
 * wherever the shell stands in the command (`timeout 60 bash -c`, `xargs sh
 * -c`); the arguments of `eval`; and a heredoc or here-string that a shell,
 * `eval`, or `source` runs, from its stdin (`bash <<'EOF'`, `sh -s <<EOF`,
 * `cat <<'EOF' | bash`, `source /dev/stdin <<EOF`, `xargs sh -c '{}' <<EOF`)
 * or through a substitution in its arguments (`bash -c "$(cat <<'EOF' ...)"`,
 * `bash <(cat <<'EOF' ...)`). Best effort by design: an alias, a function, a
 * wrapper script, a script in a file or a variable (`bash x.sh`,
 * `while read l; do eval "$l"; done <<EOF`), text a shell gets from a
 * command's arguments (`echo 'diarchy stop' | bash`, `eval "$(echo ...)"`),
 * and a heredoc read by a shell that an unknown wrapper starts without `-c`
 * (`ssh host bash <<'EOF'`) are not unpacked (ANTI-SLOP.md, What this does NOT
 * prevent).
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
