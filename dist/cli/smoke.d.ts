export interface SmokeOptions {
    out?: string;
    minutes: string;
    maxUsd: string;
    github?: string;
    /** commander: `--no-transcripts` sets this to false. */
    transcripts: boolean;
    /** commander: `--no-ping` sets this to false. */
    ping: boolean;
    clean?: boolean;
    driver: string;
}
export declare const SMOKE_SLUG = "smoke";
export declare const SMOKE_GOAL: string;
export declare const SMOKE_ACS: string[];
export declare const SMOKE_LAUNCHER: {
    max_restarts: number;
    restart_backoff_ms: number;
    stop_grace_ms: number;
    wall_clock_grace_ms: number;
};
/** After the wall clock: the 60 s grace plus room for start to stop both PMs. */
export declare const WATCHDOG_MARGIN_MS: number;
/** After the watchdog's SIGTERM: start waits stop_grace_ms twice (for the PMs to exit, then after its SIGTERM) before its own SIGKILL. */
export declare const KILL_AFTER_MS: number;
/** The argv after `node` that runs this same diarchy: the built entry, or the source entry through tsx. */
export declare function selfArgs(): string[];
/** `env` without any DIARCHY_* variable, so a child cannot find a project or a mode the caller set. */
export declare function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * Text safe to send back: common token shapes (sk-, ghp_ and the other GitHub
 * prefixes, github_pat_, xox, AKIA and ASIA, Bearer) keep their prefix only,
 * emails become `[email]`, and the home directory becomes `~`.
 */
export declare function redact(text: string, home?: string): string;
export declare function parseRepo(value: string): string;
export interface TranscriptSources {
    /** Claude Code's projects directory (`claude auth status --json` names it). */
    claudeProjects: string;
    codexHome: string;
    claudeSessions: string[];
    codexSessions: string[];
    /** Where the PMs ran: the project and its worktrees. */
    cwds: string[];
    /** Run start, ms since the epoch: a Codex rollout found by its cwd must have been written since. */
    since: number;
}
export interface TranscriptCopy {
    from: string;
    /** Relative to the bundle's transcripts/ directory. */
    to: string;
}
/**
 * The transcripts of this run. Claude: each projects/ directory named after a
 * PM's cwd, and any holding a saved session id's `<id>.jsonl` (with its
 * `<id>/` subagent directory). Codex: `sessions/**\/rollout-*-<id>.jsonl` for a
 * saved thread id, and any rollout written since the run began whose
 * session_meta cwd is one of the PMs' cwds.
 */
export declare function findTranscripts(sources: TranscriptSources): TranscriptCopy[];
export interface TrailCounts {
    mcp_start: number;
    project_sources: string[];
    tools_ok: number;
    tools_rejected: number;
    rejected_rules: string[];
    session_start: number;
    stop: number;
    stop_blocks: number;
    guard_denies: number;
}
export interface AgentSummary {
    spawned: number;
    exits: string[];
    restarts: number;
    posted: number;
    session_id: string | null;
    session_source: string | null;
    trail: TrailCounts;
}
export type SmokeVerdict = "DONE" | "BLOCKED" | "stalled" | "aborted";
export interface SmokeSummary {
    version: string;
    driver: string;
    mode: "local" | "github";
    repo: string | null;
    verdict: SmokeVerdict;
    exit_code: number;
    levels: {
        L1: boolean;
        L2: boolean;
        L3: boolean;
    };
    goal: string | null;
    phase: string | null;
    blocked_from: string | null;
    block: string | null;
    aborted: {
        step: string;
        reason: string;
    } | null;
    duration_s: number;
    start_exit: string | null;
    watchdog: {
        after_s: number;
        fired: boolean;
        killed: boolean;
    };
    interrupted: boolean;
    doctor: {
        gated: boolean;
        fail: string[];
    };
    claude_spend_cap_usd: string | null;
    agents: Record<string, AgentSummary>;
    prs: number | null;
    transcripts: number | null;
    project: string;
    project_kept: boolean;
    bundle: string;
    notes: string[];
}
/** Per-agent counts from the diagnostics trail. */
export declare function trailCounts(log: string, agent: string): TrailCounts;
/** Spawns, exits, and restarts per agent from the supervisor's lines in start.log. */
export declare function supervisorEvents(log: string, agent: string): {
    spawned: number;
    exits: string[];
    restarts: number;
};
/** The tiered verdict: L1 both PMs posted, L2 the goal reached EXECUTE, L3 DONE. */
export declare function verdictOf(input: {
    aborted: boolean;
    phase: string | null;
    blockedFrom: string | null;
    chatMd: string;
    posted: number[];
}): {
    verdict: SmokeVerdict;
    exitCode: number;
    levels: {
        L1: boolean;
        L2: boolean;
        L3: boolean;
    };
};
export declare function formatSummary(summary: SmokeSummary): string;
export declare const TRANSCRIPT_NOTICE = "the bundle includes both CLIs' transcripts of this run, redacted (home paths, emails, and common token shapes); a transcript can quote your global CLAUDE.md or AGENTS.md. Pass --no-transcripts to leave them out.";
export declare function runSmoke(options: SmokeOptions): Promise<number>;
