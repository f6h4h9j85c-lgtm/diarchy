export interface AgentLaunch {
    /** Executable; resolved on PATH by the OS. */
    command: string;
    /** Base flags; the launcher appends resume flags and the prompt. */
    args: string[];
}
export interface LauncherKnobs {
    /** How often the supervisor re-reads budget.json (ms, at most 1000). */
    poll_ms: number;
    /** Restarts per agent between two messages. Past it the agent is left dead until the next message lands, which respawns it with a fresh count. */
    max_restarts: number;
    restart_backoff_ms: number;
    /** After DONE or a non-clock block: wait this long for the PMs to exit on their own, then SIGTERM, then SIGKILL after as long again. */
    stop_grace_ms: number;
    /** After a WALL_CLOCK block the CLIs may finish on their own for this long, then SIGKILL. */
    wall_clock_grace_ms: number;
}
export interface LauncherConfig {
    agents: Record<string, AgentLaunch>;
    launcher: LauncherKnobs;
}
/**
 * Permission rules the Claude PM runs under. Headless `claude -p` has no one to
 * answer a permission prompt, so every tool outside this list is denied:
 * `acceptEdits` covers file edits and read-only shell commands, the MCP rule
 * covers the diarchy tools under the plugin-scoped server name (a server
 * registered with `claude mcp add diarchy` is `mcp__diarchy__*` instead), and
 * the Bash rules cover the commands a PM and its subagents issue. A project
 * whose checks run through another command adds it to `agents.claude.args` in
 * diarchy.config.json, for example `Bash(make *)`.
 */
export declare const CLAUDE_ALLOWED_TOOLS: string[];
/** Codex flag that runs enabled hooks without persisted /hooks trust for one invocation. */
export declare const HOOK_TRUST_BYPASS = "--dangerously-bypass-hook-trust";
export declare const DEFAULT_AGENT_LAUNCH: Record<string, AgentLaunch>;
/** Codex flag that turns off the sandbox and approvals: the PM runs with the user's full OS permissions. */
export declare const SANDBOX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
/** `agents.codex.args` written by `diarchy init --codex-full-access`. */
export declare const CODEX_FULL_ACCESS_ARGS: readonly string[];
/** True when these launch args keep Codex in the workspace-write sandbox (`--sandbox workspace-write`, `-s`, or `-c sandbox_mode=`). */
export declare function runsInWorkspaceWrite(args: readonly string[]): boolean;
export declare const DEFAULT_LAUNCHER: LauncherKnobs;
/**
 * The spawn recipe for one agent. `args` present: used verbatim. Absent: a
 * command with spaces (`"claude -p ..."`, PROTOCOL.md 8) is split on
 * whitespace; a bare known executable gets the default flags; anything else
 * runs with no flags.
 */
export declare function agentLaunch(id: string, raw: {
    command: string;
    args?: string[];
} | undefined): AgentLaunch;
export declare function loadLauncherConfig(projectDir: string, agentIds: string[]): LauncherConfig;
