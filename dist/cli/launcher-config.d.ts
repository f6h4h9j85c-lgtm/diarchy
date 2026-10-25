export interface AgentLaunch {
    /** Executable; resolved on PATH by the OS. */
    command: string;
    /** Base flags; the launcher appends resume flags and the prompt. */
    args: string[];
}
export interface LauncherKnobs {
    /** How often the supervisor re-reads budget.json (ms, at most 1000). */
    poll_ms: number;
    /** Restarts per agent before it is left dead; the count resets when a message lands. */
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
export declare const DEFAULT_AGENT_LAUNCH: Record<string, AgentLaunch>;
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
