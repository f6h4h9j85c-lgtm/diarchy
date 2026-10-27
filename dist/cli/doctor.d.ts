export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type CheckGroup = "env" | "project" | "claude" | "codex" | "live";
export interface Check {
    id: string;
    group: CheckGroup;
    status: CheckStatus;
    summary: string;
    fix?: string;
}
export interface RunOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Written to stdin, which is then closed; without it stdin is /dev/null. */
    input?: string;
}
export interface RunResult {
    /** The exit code, or null when the process did not run or was killed. */
    code: number | null;
    stdout: string;
    stderr: string;
    /** ENOENT, EACCES, ETIMEDOUT, or another reason the process did not run to its end; null when it did. */
    error: string | null;
}
/** Runs one command: an argv array, never a shell. */
export type Runner = (command: string, args: readonly string[], options?: RunOptions) => RunResult;
export declare const RUN_TIMEOUT_MS = 20000;
export declare const MCP_LIST_TIMEOUT_MS = 60000;
export declare const PROBE_TIMEOUT_MS = 30000;
export declare const LIVE_TIMEOUT_MS = 180000;
export declare const spawnRunner: Runner;
export interface McpTarget {
    command: string;
    args: string[];
    cwd: string;
    /** The server's whole environment. */
    env: Record<string, string>;
}
export interface McpProbe {
    /** False when the server could not be started or did not answer. */
    connected: boolean;
    version: string | null;
    tools: string[];
    /** What `read` answered: the goal id, or the rejection's rule. */
    goal: string | null;
    rule: string | null;
    error: string | null;
}
export type McpProber = (target: McpTarget, timeoutMs: number) => Promise<McpProbe>;
/** Connect an MCP client over stdio, list the tools, and call `read` once. The SDK client loads only here. */
export declare const sdkProber: McpProber;
export interface DoctorDeps {
    run: Runner;
    probeMcp: McpProber;
    /** The environment the checks read and pass on (PATH, HOME, CODEX_HOME, CLAUDE_CONFIG_DIR). */
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    /** This process's Node version, without the v. */
    nodeVersion: string;
    home: string;
}
export declare function defaultDeps(): DoctorDeps;
export interface DoctorOptions {
    json?: boolean;
    live?: boolean;
    /** With live: a directory for each CLI's raw output and the diagnostics trail. */
    out?: string;
}
/** The variables Codex gives an MCP server besides its `env_vars` (codex-rs/rmcp-client). */
export declare const CODEX_ENV_ALLOWLIST: string[];
export declare const PROBE_PROMPT = "Call the diarchy read tool once and reply with only the value of its goal field. Call no other tool.";
export declare const CLAUDE_SPEND_CAP_USD = "0.25";
type Version = [number, number, number];
export declare function parseVersion(text: string): Version | null;
export declare function atLeast(version: Version, minimum: string): boolean;
/** Every `--flag` a help text names. */
export declare function helpFlags(help: string): Set<string>;
/**
 * Whether launch args let a headless Claude call a server's tools: a rule
 * naming the server (`<prefix>`) or its tools (`<prefix>__*`, `<prefix>__read`),
 * or permissions bypassed altogether.
 */
export declare function allowsTools(args: readonly string[], prefix: string): boolean;
export interface DoctorReport {
    version: string;
    platform: NodeJS.Platform;
    project: string;
    checks: Check[];
}
export interface CodexTransport {
    enabled: boolean;
    type: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    envVars: string[];
    cwd: string | null;
    startupTimeoutSec: number | null;
    toolTimeoutSec: number | null;
}
/** The fields of `codex mcp get <name> --json` the checks need; null when the shape is not recognised. */
export declare function codexTransport(raw: unknown): CodexTransport | null;
/** realPlan's args with the probe prompt in place of the PM prompt, and Claude's spend cap when its --help lists the flag. */
export declare function liveArgs(flavor: string, planArgs: readonly string[], claudeFlags: Set<string> | null): string[];
/** The fix for a failed live turn, from what the CLI printed. */
export declare function liveHint(flavor: string, agent: string, output: string, result: RunResult, failed: string[]): string;
export declare function doctorReport(projectDir: string, options?: DoctorOptions, deps?: DoctorDeps): Promise<DoctorReport>;
export declare function formatReport(report: DoctorReport): string;
export declare function runDoctor(projectDir: string, options?: DoctorOptions, deps?: DoctorDeps): Promise<number>;
export {};
