/**
 * `diarchy doctor`: the prerequisites and wiring a run needs, checked without
 * a model call; `--live` then runs one short real turn per CLI.
 *
 * Each check is ok, warn, fail, or skip, with a fix line under a warn or a
 * fail; any fail exits 1. Groups: env (platform, Node, git, a global
 * `diarchy`), project (the directory exists, config, commits, launch
 * commands, the Codex files at HEAD, `.diarchy/` ignored, the active goal),
 * claude (version, launch flags, login, plugin, MCP server and an
 * --allowedTools rule for its tools, an MCP probe, hook probes,
 * disableAllHooks), and codex (version, launch flags,
 * login, plugin, the `[mcp_servers.diarchy]` entry, an MCP probe under
 * Codex's environment allowlist, the guard hook of the plugin copy, hook
 * trust, project trust).
 *
 * Every external command goes through one injectable Runner (argv arrays, no
 * shell, a timeout), and the MCP probes through an injectable McpProber, so
 * tests stub claude, codex, and git. Parsers of CLI output that cannot read
 * it warn instead of failing. Nothing prints an environment value or a token.
 *
 * The probes, the guard hooks included, run against throwaway projects in the
 * temp directory, deleted afterwards (also on SIGINT, SIGTERM, or SIGHUP,
 * which end the run before another live turn starts): `diarchy init`, a
 * probe goal, and for `--live` a git repository, the diagnostics marker
 * (diag.ts), and a human BLOCKED, so `read` still returns the goal, the
 * SessionStart brief still prints, and the Stop gate lets the turn end.
 * `--live` spawns each CLI the way `diarchy start` does (realPlan: same
 * command, args, and env, less any other DIARCHY_* the caller set) with a
 * prompt that only calls `read`, and passes when the output names the probe
 * goal and the trail shows the MCP server found the project through
 * DIARCHY_PROJECT and both hooks ran.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { VERSION } from "../index.js";
import { CONFIG_FILENAME, MAX_WAIT_MS, loadConfig } from "../vault/index.js";
import { humanStore, printJson } from "./common.js";
import { DIAG_LOG, DIAG_MARKER } from "./diag.js";
import { detectSessionId, flavorOf, realPlan } from "./drivers.js";
import { runInit } from "./init.js";
import { DEFAULT_AGENT_LAUNCH, HOOK_TRUST_BYPASS, loadLauncherConfig } from "./launcher-config.js";
import { missingCommands, platformProblem } from "./preflight.js";
import { runningSupervisor } from "./run-record.js";
export const RUN_TIMEOUT_MS = 20_000;
export const MCP_LIST_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 30_000;
export const LIVE_TIMEOUT_MS = 180_000;
export const spawnRunner = (command, args, options = {}) => {
    const result = spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeoutMs ?? RUN_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        ...(options.input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input: options.input }),
    });
    const failure = result.error;
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: failure === undefined ? null : (failure.code ?? failure.message) };
};
/** Connect an MCP client over stdio, list the tools, and call `read` once. The SDK client loads only here. */
export const sdkProber = async (target, timeoutMs, onChild) => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({ command: target.command, args: target.args, cwd: target.cwd, env: target.env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    const client = new Client({ name: "diarchy-doctor", version: VERSION });
    const probe = { connected: false, version: null, tools: [], goal: null, rule: null, error: null };
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    });
    try {
        // connect spawns the server before its first await.
        const connecting = client.connect(transport);
        onChild?.(transport.pid);
        await Promise.race([connecting, expired]);
        probe.connected = true;
        probe.version = client.getServerVersion()?.version ?? null;
        const listed = await Promise.race([client.listTools(), expired]);
        probe.tools = listed.tools.map((tool) => tool.name).sort();
        const read = await Promise.race([client.callTool({ name: "read", arguments: {} }), expired]);
        const content = (read.structuredContent ?? {});
        probe.goal = typeof content.goal === "string" ? content.goal : null;
        probe.rule = typeof content.rule === "string" ? content.rule : null;
    }
    catch (error) {
        const tail = stderr.trim().split("\n").filter((line) => line !== "").slice(-2).join(" | ");
        probe.error = `${error instanceof Error ? error.message : String(error)}${tail === "" ? "" : ` (stderr: ${tail})`}`;
    }
    finally {
        clearTimeout(timer);
        await client.close().catch(() => undefined);
        onChild?.(null);
    }
    return probe;
};
export function defaultDeps() {
    return { run: spawnRunner, probeMcp: sdkProber, env: process.env, platform: process.platform, nodeVersion: process.versions.node, home: homedir() };
}
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PLUGIN_ID = "diarchy@diarchy";
const MARKETPLACE = "f6h4h9j85c-lgtm/diarchy";
const INSTALL_CLI = `npm install -g github:${MARKETPLACE}`;
const NODE_MIN = "20.3.0";
const GIT_MIN = "2.31.0";
const CLAUDE_MIN = "2.1.275";
/** The longest wait_for_reply, in seconds: a Codex tool timeout at or under it cuts waits off. */
const WAIT_CAP_SEC = Math.ceil(MAX_WAIT_MS / 1000);
/** The variables Codex gives an MCP server besides its `env_vars` (codex-rs/rmcp-client). */
export const CODEX_ENV_ALLOWLIST = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];
const CODEX_HOOK_EVENTS = ["session_start", "pre_tool_use", "stop"];
export const PROBE_PROMPT = "Call the diarchy read tool once and reply with only the value of its goal field. Call no other tool.";
export const CLAUDE_SPEND_CAP_USD = "0.25";
const GUARD_DENY_EVENT = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "diarchy reply x" } });
const GUARD_ALLOW_EVENT = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
/** The tool prefix of the plugin's server, and of one registered with `claude mcp add diarchy`. */
const PLUGIN_TOOLS = "mcp__plugin_diarchy_diarchy";
const BARE_TOOLS = "mcp__diarchy";
const CLAUDE_UPDATE = "claude update";
const CODEX_UPDATE = "update Codex (npm install -g @openai/codex)";
export function parseVersion(text) {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}
export function atLeast(version, minimum) {
    const min = parseVersion(minimum) ?? [0, 0, 0];
    for (let i = 0; i < 3; i += 1)
        if (version[i] !== min[i])
            return version[i] > min[i];
    return true;
}
const show = (version) => version.join(".");
function firstLine(text) {
    return text.trim().split("\n")[0]?.trim() ?? "";
}
/** Why a command did not give a usable answer, in a few words. */
function failure(command, result) {
    if (result.error === "ENOENT")
        return `${command} is not on PATH`;
    if (result.error === "ETIMEDOUT")
        return `${command} did not answer in time`;
    if (result.error !== null)
        return `${command} could not run (${result.error})`;
    const said = firstLine(result.stderr) || firstLine(result.stdout);
    return `${command} exited ${result.code ?? "on a signal"}${said === "" ? "" : `: ${said}`}`;
}
/**
 * Let the event loop poll, so a signal that arrived during a spawnSync reaches
 * its handler: a handler runs only from a poll, and neither a spawnSync nor
 * synchronous code polls. Two hops, since code resumed from an I/O callback
 * runs its first setImmediate before the next poll.
 */
export async function settleSignals() {
    for (let hop = 0; hop < 2; hop += 1)
        await new Promise((done) => setImmediate(done));
}
/** The fix for a command whose output a check could not read. */
function readByHand(command, update) {
    return `run ${command} by hand and read its output; ${update} if its format changed`;
}
function probeFix() {
    return `check that the temp directory (${tmpdir()}) exists and is writable`;
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** Every `--flag` a help text names. */
export function helpFlags(help) {
    return new Set(help.match(/--[A-Za-z][A-Za-z0-9-]*/g) ?? []);
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DENY_FLAGS = new Set(["--disallowedTools", "--disallowed-tools"]);
/**
 * Whether launch args let a headless Claude call a server's tools: a rule
 * naming the server (`<prefix>`) or its tools (`<prefix>__*`, `<prefix>__read`),
 * or permissions bypassed altogether. A rule among the values of
 * --disallowedTools, which runs to the next flag, allows nothing.
 */
export function allowsTools(args, prefix) {
    const bypass = args.includes("--dangerously-skip-permissions") ||
        args.includes("--permission-mode=bypassPermissions") ||
        args.some((arg, i) => arg === "--permission-mode" && args[i + 1] === "bypassPermissions");
    const rule = new RegExp(`${escapeRegExp(prefix)}(?:__|(?![A-Za-z0-9_-]))`);
    let denying = false;
    const allowing = args.filter((arg) => {
        if (arg.startsWith("-"))
            denying = DENY_FLAGS.has(arg.split("=")[0]);
        return !denying;
    });
    return bypass || allowing.some((arg) => rule.test(arg));
}
/** The long flags among launch args, without their `=value`. */
function longFlags(args) {
    return args.filter((arg) => /^--[A-Za-z]/.test(arg)).map((arg) => arg.split("=")[0]);
}
function readText(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
}
/** The body of the TOML table whose header matches `header`, up to the next header; null when absent. Good enough to warn, never to fail. */
function tomlTable(toml, header) {
    const lines = toml.split(/\r?\n/);
    const start = lines.findIndex((line) => header.test(line.trim()));
    if (start === -1)
        return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^\s*\[/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}
/** `[a."b"]` or `[a.'b']` for a literal key `b`. */
function quotedHeader(prefix, key) {
    return new RegExp(`^\\[${escapeRegExp(prefix)}\\.(?:"${escapeRegExp(key)}"|'${escapeRegExp(key)}')\\]$`);
}
function realOrSame(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
const PROBE_GOAL = "diarchy doctor probe: confirm each PM reaches the diarchy tools from a throwaway project.";
const PROBE_AC = "The read tool returns this goal.";
const PROBE_STOP = "diarchy doctor probe: nothing to do here; end the turn after one read.";
const PROBE_GIT = ["-c", "user.name=diarchy doctor", "-c", "user.email=doctor@diarchy.invalid", "-c", "commit.gpgsign=false"];
/**
 * A temp project with `diarchy init` run and a probe goal kicked off. `live`
 * adds a git repository with one commit, the diagnostics marker, and a human
 * BLOCKED on the goal. `made` gets the directory as soon as it exists, so a
 * signal handler can delete it before this returns.
 */
async function probeProject(agents, live, deps, made) {
    const dir = realOrSame(mkdtempSync(join(tmpdir(), "diarchy-doctor-")));
    made(dir);
    try {
        const git = (...args) => {
            const result = deps.run("git", [...PROBE_GIT, ...args], { cwd: dir, env: deps.env });
            if (result.code !== 0)
                throw new Error(failure(`git ${args[0]}`, result));
        };
        if (live)
            git("init", "-q");
        runInit(dir, { agents: agents.join(",") }, () => undefined);
        if (live) {
            mkdirSync(join(dir, ".diarchy"), { recursive: true });
            writeFileSync(join(dir, DIAG_MARKER), "");
            git("add", "-A");
            git("commit", "-q", "-m", "diarchy doctor probe");
        }
        const store = humanStore(dir);
        const kicked = await store.kickoff({ goal: PROBE_GOAL, acceptance_criteria: [PROBE_AC], slug: "doctor-probe" });
        if (!kicked.ok)
            throw new Error(`probe kickoff rejected ${kicked.rule}: ${kicked.message}`);
        if (live) {
            const stopped = await store.stop(PROBE_STOP);
            if (!stopped.ok)
                throw new Error(`probe BLOCKED rejected ${stopped.rule}: ${stopped.message}`);
        }
        return { dir, goalId: kicked.goal_id };
    }
    catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
}
class Doctor {
    projectDir;
    deps;
    checks = [];
    agents = {};
    claude = null;
    codex = null;
    probe = null;
    temps = [];
    /** The pid of the MCP server a probe is talking to, while it runs. */
    probeChild = null;
    constructor(projectDir, deps) {
        this.projectDir = projectDir;
        this.deps = deps;
    }
    add(group, id, status, summary, fix) {
        this.checks.push({ id, group, status, summary, ...(fix === undefined || status === "ok" || status === "skip" ? {} : { fix }) });
    }
    /** Run from the project directory (this process's cwd when it does not exist), with the doctor's environment. */
    run(command, args, options = {}) {
        const cwd = existsSync(this.projectDir) ? this.projectDir : process.cwd();
        return this.deps.run(command, args, { env: this.deps.env, cwd, ...options });
    }
    /** The offline probe project, made once and shared by the MCP and hook probes of both CLIs. */
    probeOnce() {
        this.probe ??= probeProject(Object.keys(this.agents), false, this.deps, (dir) => this.temps.push(dir));
        return this.probe;
    }
    /** The offline probe project, or null after a warn on `id` saying why it could not be made. */
    async probeOrWarn(group, id) {
        try {
            return await this.probeOnce();
        }
        catch (error) {
            this.add(group, id, "warn", `could not make a probe project: ${error instanceof Error ? error.message : String(error)}`, probeFix());
            return null;
        }
    }
    cleanup() {
        for (const dir of this.temps.splice(0))
            rmSync(dir, { recursive: true, force: true });
    }
    /** Kill a probe's MCP server still running, so it cannot write into a probe project after cleanup deletes it. */
    killProbe() {
        if (this.probeChild === null)
            return;
        try {
            process.kill(this.probeChild, "SIGKILL");
        }
        catch {
            // already gone
        }
        this.probeChild = null;
    }
    async offline() {
        this.project();
        this.environment();
        this.projectGit();
        if (this.claude === null)
            this.add("claude", "C0", "skip", "no agent launches claude");
        else
            await this.claudeChecks(this.claude);
        if (this.codex === null)
            this.add("codex", "X0", "skip", "no agent launches codex");
        else
            await this.codexChecks(this.codex);
    }
    // -- project config first: it names the agents every other group checks ---
    project() {
        if (!existsSync(this.projectDir))
            this.add("project", "P0", "fail", `${this.projectDir} does not exist`, "pass --project <existing dir>");
        const configPath = join(this.projectDir, CONFIG_FILENAME);
        try {
            const config = loadConfig(this.projectDir);
            this.agents = loadLauncherConfig(this.projectDir, Object.keys(config.agents)).agents;
            if (existsSync(configPath))
                this.add("project", "P1", "ok", `${CONFIG_FILENAME} loads: agents ${Object.keys(this.agents).join(", ")}`);
            else
                this.add("project", "P1", "warn", `no ${CONFIG_FILENAME} in ${this.projectDir}; the checks below use the default agents`, `run diarchy init in the project root (or pass --project <dir>)`);
        }
        catch (error) {
            this.agents = { claude: { ...DEFAULT_AGENT_LAUNCH.claude }, codex: { ...DEFAULT_AGENT_LAUNCH.codex } };
            this.add("project", "P1", "fail", `${CONFIG_FILENAME} does not load: ${error instanceof Error ? error.message : String(error)}`, `fix the file, or rerun diarchy init --force`);
        }
        for (const [agent, launch] of Object.entries(this.agents)) {
            const flavor = flavorOf(launch.command);
            if (flavor === "claude")
                this.claude ??= { agent, launch, flags: null, projectsDirectory: null };
            if (flavor === "codex")
                this.codex ??= { agent, launch };
        }
    }
    // -- env ------------------------------------------------------------------
    environment() {
        const platform = platformProblem(this.deps.platform, "real");
        this.add("env", "E1", platform === null ? "ok" : "fail", platform ?? `platform ${this.deps.platform}`, "run diarchy under WSL");
        const own = parseVersion(this.deps.nodeVersion);
        const onPath = this.run("node", ["--version"]);
        const pathVersion = onPath.code === 0 ? parseVersion(onPath.stdout) : null;
        const problems = [];
        if (own === null || !atLeast(own, NODE_MIN))
            problems.push(`this diarchy runs on Node ${this.deps.nodeVersion}`);
        if (pathVersion === null)
            problems.push(onPath.code === 0 ? "could not read node --version" : failure("node", onPath));
        else if (!atLeast(pathVersion, NODE_MIN))
            problems.push(`the node on PATH is ${show(pathVersion)}`);
        this.add("env", "E2", problems.length === 0 ? "ok" : "fail", problems.length === 0 ? `Node ${this.deps.nodeVersion} here, ${show(pathVersion ?? [0, 0, 0])} on PATH (the hooks and MCP servers run that one)` : `${problems.join("; ")}; diarchy needs ${NODE_MIN} or later`, `install Node ${NODE_MIN} or later and put it first on PATH`);
        const git = this.run("git", ["--version"]);
        const gitVersion = git.code === 0 ? parseVersion(git.stdout) : null;
        if (gitVersion !== null && atLeast(gitVersion, GIT_MIN))
            this.add("env", "E3", "ok", `git ${show(gitVersion)}`);
        else
            this.add("env", "E3", "warn", gitVersion === null ? failure("git", git) : `git ${show(gitVersion)} is older than ${GIT_MIN}; worktree detection uses rev-parse --path-format=absolute`, `install git ${GIT_MIN} or later`);
        const global = this.run("diarchy", ["--version"]);
        const globalVersion = global.code === 0 ? firstLine(global.stdout) : null;
        if (globalVersion === null) {
            if (this.codex !== null)
                this.add("env", "E4", "fail", `no working diarchy on PATH (${failure("diarchy", global)}); the Codex plugin's MCP server and hooks run it`, INSTALL_CLI);
            else
                this.add("env", "E4", "skip", "no global diarchy on PATH; only Codex needs one");
        }
        else if (globalVersion !== VERSION) {
            this.add("env", "E4", "warn", `the diarchy on PATH is ${globalVersion}, this one is ${VERSION}`, `${INSTALL_CLI}, and update both plugins to the same version`);
        }
        else {
            this.add("env", "E4", "ok", `diarchy ${globalVersion} on PATH`);
        }
    }
    // -- project: git, commands, Codex files, ignore, goal ---------------------
    projectGit() {
        // A missing project runs no git: from this process's cwd it would check some other repository.
        const exists = existsSync(this.projectDir);
        const inside = exists ? this.run("git", ["rev-parse", "--is-inside-work-tree"]) : null;
        const isRepo = inside !== null && inside.code === 0 && inside.stdout.trim() === "true";
        const hasCommits = isRepo && this.run("git", ["rev-parse", "--verify", "-q", "HEAD"]).code === 0;
        if (!exists)
            this.add("project", "P2", "skip", "no project directory");
        else if (!isRepo)
            this.add("project", "P2", "fail", `${this.projectDir} is not a git repository`, 'git init && git add -A && git commit -m "Initial commit": each PM works in a git worktree cut from HEAD');
        else if (!hasCommits)
            this.add("project", "P2", "fail", "the repository has no commits", 'commit once (git add -A && git commit -m "Initial commit"): each PM works in a git worktree cut from HEAD');
        else
            this.add("project", "P2", "ok", "git repository with commits");
        const missing = missingCommands(this.agents, () => this.projectDir, this.deps.env.PATH);
        this.add("project", "P3", missing.length === 0 ? "ok" : "fail", missing.length === 0 ? "every agent command is executable" : missing.join("; "), "install the CLI, or fix agents.<id>.command in diarchy.config.json");
        if (this.codex === null)
            this.add("project", "P4", "skip", "no agent launches codex, so AGENTS.md and .codex/agents are not needed");
        else if (!exists)
            this.add("project", "P4", "skip", "no project directory");
        else if (!hasCommits)
            this.add("project", "P4", "skip", "no commits to check AGENTS.md and .codex/agents against");
        else {
            const tree = this.run("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "AGENTS.md", ".codex/agents"]);
            const files = tree.stdout.split("\n").map((line) => line.trim());
            const absent = [
                ...(files.includes("AGENTS.md") ? [] : ["AGENTS.md"]),
                ...(files.some((file) => file.startsWith(".codex/agents/") && file.endsWith(".toml")) ? [] : [".codex/agents/*.toml"]),
            ];
            if (tree.code !== 0)
                this.add("project", "P4", "warn", `could not list HEAD (${failure("git ls-tree", tree)})`, "run git ls-tree HEAD by hand in the project and read the error");
            else if (absent.length === 0)
                this.add("project", "P4", "ok", "AGENTS.md and .codex/agents are committed");
            else
                this.add("project", "P4", "warn", `${absent.join(" and ")} not committed at HEAD; Codex reads AGENTS.md and .codex/agents only from its worktree`, 'diarchy init, then git add AGENTS.md .codex && git commit -m "Add the diarchy Codex files"');
        }
        if (!exists)
            this.add("project", "P5", "skip", "no project directory");
        else if (!isRepo)
            this.add("project", "P5", "skip", "not a git repository");
        else {
            const ignored = this.run("git", ["check-ignore", "-q", ".diarchy/"]);
            if (ignored.code === 0)
                this.add("project", "P5", "ok", ".diarchy/ is ignored");
            else
                this.add("project", "P5", "warn", ".diarchy/ is not ignored, so the worktrees and launcher state show as untracked", "add .diarchy/ to .gitignore (diarchy init does)");
        }
        try {
            const goal = humanStore(this.projectDir).activeGoal();
            const supervisor = runningSupervisor(this.projectDir);
            const goalText = goal === null ? "no active goal" : `goal ${goal.goalId} in ${goal.phase}`;
            this.add("project", "P6", "ok", `${goalText}; ${supervisor === null ? "no diarchy start running" : `diarchy start running (pid ${supervisor})`}`);
        }
        catch (error) {
            this.add("project", "P6", "warn", `could not read the vault: ${error instanceof Error ? error.message : String(error)}`, "diarchy status names the file at fault");
        }
    }
    // -- claude ---------------------------------------------------------------
    async claudeChecks(claude) {
        const cmd = claude.launch.command;
        const version = this.run(cmd, ["--version"]);
        const parsed = version.code === 0 ? parseVersion(version.stdout) : null;
        if (version.code !== 0) {
            this.add("claude", "C1", "fail", failure(cmd, version), "install Claude Code: https://docs.claude.com/en/docs/claude-code");
            for (const id of ["C2", "C3", "C4", "C5", "C6", "C7"])
                this.add("claude", id, "skip", `${cmd} did not run`);
            this.claudeSettings();
            return;
        }
        if (parsed === null)
            this.add("claude", "C1", "warn", `could not read ${cmd} --version output`, readByHand(`${cmd} --version`, CLAUDE_UPDATE));
        else if (!atLeast(parsed, CLAUDE_MIN))
            this.add("claude", "C1", "fail", `Claude Code ${show(parsed)} is older than ${CLAUDE_MIN}`, "claude update");
        else
            this.add("claude", "C1", "ok", `Claude Code ${show(parsed)}`);
        const help = this.run(cmd, ["--help"]);
        if (help.code !== 0)
            this.add("claude", "C2", "warn", `could not read ${cmd} --help output (${failure(cmd, help)})`, readByHand(`${cmd} --help`, CLAUDE_UPDATE));
        else {
            claude.flags = helpFlags(help.stdout);
            const flags = claude.flags;
            const wanted = [...new Set([...longFlags(claude.launch.args), "--session-id", "--resume"])];
            const unknown = wanted.filter((flag) => !flags.has(flag));
            if (unknown.length === 0)
                this.add("claude", "C2", "ok", `${cmd} accepts every launch flag (${wanted.join(" ")})`);
            else
                this.add("claude", "C2", "fail", `${cmd} --help does not list ${unknown.join(", ")}`, `claude update, or drop the flag from agents.${claude.agent}.args in diarchy.config.json`);
        }
        const auth = parseJson(this.run(cmd, ["auth", "status", "--json"]).stdout);
        if (!isRecord(auth) || typeof auth.loggedIn !== "boolean")
            this.add("claude", "C3", "warn", `could not read ${cmd} auth status --json output`, readByHand(`${cmd} auth status --json`, CLAUDE_UPDATE));
        else if (auth.loggedIn)
            this.add("claude", "C3", "ok", "logged in (local state only; --live proves model access)");
        else
            this.add("claude", "C3", "warn", "not logged in", "claude auth login");
        if (isRecord(auth) && typeof auth.projectsDirectory === "string")
            claude.projectsDirectory = auth.projectsDirectory;
        const installPath = this.claudePlugin(cmd);
        this.claudeMcpList(cmd, claude);
        if (installPath === null) {
            this.add("claude", "C6", "skip", "no installed plugin to probe");
            this.add("claude", "C7", "skip", "no installed plugin to probe");
        }
        else {
            await this.claudeProbe(installPath, claude.agent);
            await this.claudeHooks(installPath);
        }
        this.claudeSettings();
    }
    /** C4; returns the enabled plugin's install path. */
    claudePlugin(cmd) {
        const listed = this.run(cmd, ["plugin", "list", "--json"]);
        const plugins = parseJson(listed.stdout);
        if (listed.code !== 0 || !Array.isArray(plugins)) {
            this.add("claude", "C4", "warn", `could not read ${cmd} plugin list --json output`, readByHand(`${cmd} plugin list --json`, CLAUDE_UPDATE));
            return null;
        }
        const ours = plugins.filter((plugin) => isRecord(plugin) && plugin.id === PLUGIN_ID);
        const enabled = ours.find((plugin) => plugin.enabled === true);
        if (ours.length === 0) {
            this.add("claude", "C4", "fail", `${PLUGIN_ID} is not installed in Claude Code`, `claude plugin install diarchy --marketplace ${MARKETPLACE}`);
            return null;
        }
        if (enabled === undefined) {
            this.add("claude", "C4", "fail", `${PLUGIN_ID} is installed but not enabled`, `claude plugin enable ${PLUGIN_ID}`);
            return null;
        }
        const notes = [];
        const fixes = [];
        if (enabled.scope === "project" || enabled.scope === "local") {
            notes.push(`installed at ${String(enabled.scope)} scope, so a PM worktree enables it only through a committed .claude/settings.json`);
            fixes.push(`claude plugin install ${PLUGIN_ID} (user scope)`);
        }
        if (typeof enabled.version === "string" && enabled.version !== VERSION) {
            notes.push(`plugin ${enabled.version}, CLI ${VERSION}`);
            fixes.push(`claude plugin update ${PLUGIN_ID}`);
        }
        const installPath = typeof enabled.installPath === "string" ? enabled.installPath : null;
        if (notes.length > 0)
            this.add("claude", "C4", "warn", `${PLUGIN_ID} enabled; ${notes.join("; ")}`, fixes.join("; "));
        else
            this.add("claude", "C4", "ok", `${PLUGIN_ID}${typeof enabled.version === "string" ? ` ${enabled.version}` : ""} enabled`);
        return installPath;
    }
    /** C5: the MCP server Claude Code would start, by name, and whether the launch flags allow its tools. */
    claudeMcpList(cmd, claude) {
        // The health check starts the server from the project; DIARCHY_DIAG=0 keeps it out of the project's diagnostics trail.
        const listed = this.run(cmd, ["mcp", "list"], { timeoutMs: MCP_LIST_TIMEOUT_MS, env: { ...this.deps.env, DIARCHY_DIAG: "0" } });
        if (listed.code !== 0) {
            this.add("claude", "C5", "warn", `could not read ${cmd} mcp list output (${failure(cmd, listed)})`, readByHand(`${cmd} mcp list`, CLAUDE_UPDATE));
            return;
        }
        const servers = new Map();
        for (const line of listed.stdout.split("\n")) {
            const match = /^(\S+?): .* - (.+)$/.exec(line.trim());
            if (match !== null)
                servers.set(match[1], match[2]);
        }
        const plugin = servers.get("plugin:diarchy:diarchy");
        const bare = servers.get("diarchy");
        const connected = (status) => status !== undefined && /connected/i.test(status) && !/fail|not connected/i.test(status);
        const args = `agents.${claude.agent}.args`;
        const allowsPlugin = allowsTools(claude.launch.args, PLUGIN_TOOLS);
        const allowsBare = allowsTools(claude.launch.args, BARE_TOOLS);
        const pluginFix = `add ${PLUGIN_TOOLS}__* to --allowedTools in ${args}`;
        if (plugin === undefined && bare === undefined) {
            this.add("claude", "C5", "fail", "claude mcp list shows no diarchy server", `claude plugin install diarchy --marketplace ${MARKETPLACE}`);
        }
        else if (plugin !== undefined && bare !== undefined && !allowsPlugin && !allowsBare) {
            this.add("claude", "C5", "fail", `two diarchy servers, and ${args} allows neither's tools (${PLUGIN_TOOLS}__* or ${BARE_TOOLS}__*), so a headless run is denied every diarchy tool`, `${pluginFix}, then claude mcp remove diarchy`);
        }
        else if (plugin !== undefined && bare !== undefined) {
            const rule = allowsPlugin ? "" : `, and ${args} does not allow the plugin's ${PLUGIN_TOOLS}__*`;
            this.add("claude", "C5", "warn", `two diarchy servers: the plugin's plugin:diarchy:diarchy and a bare diarchy, so the PM sees each tool twice${rule}`, `claude mcp remove diarchy (keep the plugin's)${allowsPlugin ? "" : `, then ${pluginFix}`}`);
        }
        else if (plugin !== undefined) {
            if (!connected(plugin))
                this.add("claude", "C5", "fail", `plugin:diarchy:diarchy is ${plugin}`, "run node <plugin root>/bin/diarchy.js mcp --agent claude by hand and read the error");
            else if (!allowsPlugin)
                this.add("claude", "C5", "fail", `plugin:diarchy:diarchy connected, but ${args} does not allow its tools (${PLUGIN_TOOLS}__*), so a headless run is denied every diarchy tool`, pluginFix);
            else
                this.add("claude", "C5", "ok", `plugin:diarchy:diarchy connected, and the launch flags allow ${PLUGIN_TOOLS}__*`);
        }
        else if (!allowsBare) {
            this.add("claude", "C5", "fail", `only a bare diarchy server (claude mcp add), whose tools are ${BARE_TOOLS}__*, and ${args} does not allow them`, `add ${BARE_TOOLS}__* to --allowedTools in ${args}, or install the plugin`);
        }
        else if (connected(bare)) {
            this.add("claude", "C5", "ok", `diarchy connected (claude mcp add), and the launch flags allow ${BARE_TOOLS}__*`);
        }
        else {
            this.add("claude", "C5", "fail", `diarchy is ${String(bare)}`, "run the server command from claude mcp get diarchy by hand and read the error");
        }
    }
    /** C6: the plugin's own .mcp.json server, started as Claude Code starts it, against the probe project. */
    async claudeProbe(installPath, agent) {
        const declared = parseJson(readText(join(installPath, ".mcp.json")) ?? "");
        const server = isRecord(declared) && isRecord(declared.mcpServers) && isRecord(declared.mcpServers.diarchy) ? declared.mcpServers.diarchy : null;
        const substitute = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", installPath);
        const command = server !== null && typeof server.command === "string" ? substitute(server.command) : "node";
        const args = server !== null && Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")
            ? server.args.map((arg) => substitute(arg))
            : [join(installPath, "bin", "diarchy.js"), "mcp", "--agent", "claude"];
        // Without the caller's other DIARCHY_* variables; no check reads the probe project's trail, so DIARCHY_DIAG=0 keeps it off.
        await this.mcpProbe("claude", "C6", (probe) => ({
            command,
            args,
            cwd: probe.dir,
            env: { ...stringEnv(liveEnv(this.deps.env)), DIARCHY_PROJECT: probe.dir, DIARCHY_AGENT: agent, DIARCHY_GOAL: probe.goalId, DIARCHY_DIAG: "0" },
        }));
    }
    /** C7: the plugin's guard denies a human command and lets `ls` through; the SessionStart script exits 0. */
    async claudeHooks(installPath) {
        const hooks = join(installPath, "hooks");
        const probe = await this.probeOrWarn("claude", "C7");
        if (probe === null)
            return;
        const env = { ...this.deps.env, DIARCHY_PROJECT: probe.dir };
        const problems = this.guardProbe(hooks, "claude", env, probe.dir, true);
        const start = this.run("bash", [join(hooks, "session-start.sh"), "claude"], { env, cwd: probe.dir });
        if (start.code !== 0)
            problems.push(`session-start.sh: ${failure("session-start.sh", start)}`);
        if (problems.length === 0)
            this.add("claude", "C7", "ok", "pre-tool-guard.sh denies diarchy reply and passes ls; session-start.sh exits 0");
        else
            this.add("claude", "C7", "fail", problems.join("; "), `run bash ${join(hooks, "pre-tool-guard.sh")} claude by hand with a PreToolUse event on stdin and read the error`);
    }
    /** The problems of a guard hook script: it must deny `diarchy reply x` and, when `allowToo`, print nothing for `ls`. */
    guardProbe(hooks, agent, env, cwd, allowToo) {
        const script = join(hooks, "pre-tool-guard.sh");
        const problems = [];
        const deny = this.run("bash", [script, agent], { env, cwd, input: GUARD_DENY_EVENT });
        if (deny.code !== 0)
            problems.push(`pre-tool-guard.sh: ${failure("pre-tool-guard.sh", deny)}`);
        else if (!deny.stdout.includes('"permissionDecision":"deny"'))
            problems.push("pre-tool-guard.sh did not deny diarchy reply");
        if (allowToo) {
            const allow = this.run("bash", [script, agent], { env, cwd, input: GUARD_ALLOW_EVENT });
            if (allow.code !== 0 || allow.stdout.trim() !== "")
                problems.push("pre-tool-guard.sh did not pass ls through silently");
        }
        return problems;
    }
    /** C8: disableAllHooks in any Claude Code settings file turns the brief, the guard, and the Stop gate off. */
    claudeSettings() {
        const configDir = this.deps.env.CLAUDE_CONFIG_DIR ?? join(this.deps.home, ".claude");
        const files = [join(configDir, "settings.json"), join(this.projectDir, ".claude", "settings.json"), join(this.projectDir, ".claude", "settings.local.json")];
        const off = files.filter((file) => {
            const settings = parseJson(readText(file) ?? "");
            return isRecord(settings) && settings.disableAllHooks === true;
        });
        if (off.length === 0)
            this.add("claude", "C8", "ok", "disableAllHooks is not set");
        else
            this.add("claude", "C8", "fail", `disableAllHooks is true in ${off.join(", ")}, so no diarchy hook runs`, "remove disableAllHooks from that file");
    }
    // -- codex ----------------------------------------------------------------
    async codexChecks(codex) {
        const cmd = codex.launch.command;
        const version = this.run(cmd, ["--version"]);
        if (version.code !== 0) {
            this.add("codex", "X1", "fail", failure(cmd, version), "install Codex CLI: npm install -g @openai/codex");
            for (const id of ["X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9"])
                this.add("codex", id, "skip", `${cmd} did not run`);
            return;
        }
        this.add("codex", "X1", "ok", firstLine(version.stdout) || `${cmd} runs`);
        const execAt = codex.launch.args.indexOf("exec");
        const execArgs = execAt === -1 ? codex.launch.args : codex.launch.args.slice(execAt + 1);
        const help = this.run(cmd, ["exec", "--help"]);
        const resume = this.run(cmd, ["exec", "resume", "--help"]);
        if (help.code !== 0)
            this.add("codex", "X2", "warn", `could not read ${cmd} exec --help output (${failure(cmd, help)})`, readByHand(`${cmd} exec --help`, CODEX_UPDATE));
        else {
            const flags = helpFlags(help.stdout);
            const unknown = [...new Set(longFlags(execArgs))].filter((flag) => !flags.has(flag));
            const problems = [...(unknown.length === 0 ? [] : [`${cmd} exec --help does not list ${unknown.join(", ")}`]), ...(resume.code === 0 ? [] : [`${cmd} exec resume is not available (${failure(cmd, resume)})`])];
            if (problems.length === 0)
                this.add("codex", "X2", "ok", `${cmd} exec accepts every launch flag and resume`);
            else
                this.add("codex", "X2", "fail", problems.join("; "), `update Codex (npm install -g @openai/codex), or drop the flag from agents.${codex.agent}.args in diarchy.config.json`);
        }
        const login = this.run(cmd, ["login", "status"]);
        if (login.code === 0)
            this.add("codex", "X3", "ok", "logged in (local state only; --live proves model access)");
        else
            this.add("codex", "X3", "warn", `not logged in (${failure(`${cmd} login status`, login)})`, "codex login");
        const pluginVersion = this.codexPlugin(cmd);
        const transport = this.codexMcp(cmd, codex.agent);
        if (transport === null)
            this.add("codex", "X6", "skip", "no [mcp_servers.diarchy] entry to probe");
        else
            await this.codexProbe(transport, codex.agent);
        await this.codexGuard(pluginVersion);
        this.codexTrust(codex);
    }
    codexHome() {
        const configured = this.deps.env.CODEX_HOME;
        return configured !== undefined && configured !== "" ? configured : join(this.deps.home, ".codex");
    }
    /** X4; returns the installed plugin's version. */
    codexPlugin(cmd) {
        const listed = this.run(cmd, ["plugin", "list", "--json"]);
        const parsed = parseJson(listed.stdout);
        const installed = isRecord(parsed) && Array.isArray(parsed.installed) ? parsed.installed : Array.isArray(parsed) ? parsed : null;
        if (listed.code !== 0 || installed === null) {
            this.add("codex", "X4", "warn", `could not read ${cmd} plugin list --json output`, readByHand(`${cmd} plugin list --json`, CODEX_UPDATE));
            return null;
        }
        const ours = installed.find((plugin) => isRecord(plugin) && (plugin.pluginId === PLUGIN_ID || plugin.id === PLUGIN_ID));
        if (ours === undefined) {
            this.add("codex", "X4", "fail", `${PLUGIN_ID} is not installed in Codex`, `codex plugin marketplace add ${MARKETPLACE} && codex plugin add ${PLUGIN_ID}`);
            return null;
        }
        const version = typeof ours.version === "string" ? ours.version : null;
        if (ours.enabled === false)
            this.add("codex", "X4", "fail", `${PLUGIN_ID} is installed but not enabled`, `enable ${PLUGIN_ID} in /plugins, or set [plugins."${PLUGIN_ID}"] enabled = true in config.toml`);
        else if (version !== null && version !== VERSION)
            this.add("codex", "X4", "warn", `${PLUGIN_ID} ${version} enabled, CLI ${VERSION}`, `update the plugin and ${INSTALL_CLI} to the same version`);
        else
            this.add("codex", "X4", "ok", `${PLUGIN_ID}${version === null ? "" : ` ${version}`} enabled`);
        return version;
    }
    /** X5: `codex mcp get diarchy --json`; returns the transport to probe. */
    codexMcp(cmd, agent) {
        const got = this.run(cmd, ["mcp", "get", "diarchy", "--json"]);
        if (got.code !== 0) {
            this.add("codex", "X5", "fail", `no diarchy MCP server in Codex (${failure(`${cmd} mcp get diarchy`, got)})`, "add [mcp_servers.diarchy] to ~/.codex/config.toml (docs/INSTALL-CODEX.md section 2)");
            return null;
        }
        const transport = codexTransport(parseJson(got.stdout));
        if (transport === null) {
            this.add("codex", "X5", "warn", `could not read ${cmd} mcp get diarchy --json output`, readByHand(`${cmd} mcp get diarchy --json`, CODEX_UPDATE));
            return null;
        }
        const fails = [];
        const warns = [];
        const fixes = [];
        if (!transport.enabled) {
            fails.push("the server is disabled");
            fixes.push("set enabled = true under [mcp_servers.diarchy]");
        }
        if (transport.type !== "stdio") {
            fails.push(`transport ${transport.type}, not stdio`);
            fixes.push('use command = "diarchy" and args = ["mcp", "--agent", "codex"]');
        }
        if (!transport.envVars.includes("DIARCHY_PROJECT")) {
            fails.push("env_vars does not name DIARCHY_PROJECT, so the launcher's project never reaches the server");
            fixes.push('add env_vars = ["DIARCHY_PROJECT"] to [mcp_servers.diarchy] in ~/.codex/config.toml');
        }
        const at = transport.args.indexOf("mcp");
        if (at === -1 || transport.args[at + 1] !== "--agent" || transport.args[at + 2] !== agent) {
            fails.push(`args do not run mcp --agent ${agent}`);
            fixes.push(`set args = ["mcp", "--agent", "${agent}"]`);
        }
        if (transport.toolTimeoutSec !== null && transport.toolTimeoutSec <= WAIT_CAP_SEC) {
            fails.push(`tool_timeout_sec ${transport.toolTimeoutSec} cuts wait_for_reply (up to ${WAIT_CAP_SEC} s) off`);
            fixes.push("set tool_timeout_sec = 1800");
        }
        if (transport.startupTimeoutSec !== null && transport.startupTimeoutSec < 30) {
            warns.push(`startup_timeout_sec ${transport.startupTimeoutSec} is under Codex's 30 s default`);
            fixes.push("set startup_timeout_sec = 60");
        }
        if (transport.cwd !== null && transport.cwd.includes(`plugins${sep}cache`)) {
            warns.push("the effective server is the plugin copy, which finds the project only through DIARCHY_PROJECT, so interactive sessions miss it");
            fixes.push("add the [mcp_servers.diarchy] entry of docs/INSTALL-CODEX.md section 2 to ~/.codex/config.toml");
        }
        const status = fails.length > 0 ? "fail" : warns.length > 0 ? "warn" : "ok";
        const summary = status === "ok" ? `diarchy: ${transport.command} ${transport.args.join(" ")}, env_vars DIARCHY_PROJECT` : [...fails, ...warns].join("; ");
        this.add("codex", "X5", status, summary, fixes.join("; "));
        return transport;
    }
    /** X6: that server, started with only the environment Codex gives it, against the probe project, from a directory outside it. */
    async codexProbe(transport, agent) {
        await this.mcpProbe("codex", "X6", (probe) => {
            const launched = { ...stringEnv(this.deps.env), DIARCHY_PROJECT: probe.dir, DIARCHY_AGENT: agent, DIARCHY_GOAL: probe.goalId };
            const env = {};
            for (const name of [...CODEX_ENV_ALLOWLIST, ...transport.envVars])
                if (launched[name] !== undefined)
                    env[name] = launched[name];
            Object.assign(env, transport.env, { DIARCHY_DIAG: "0" });
            const cwd = transport.cwd !== null && isAbsolute(transport.cwd) ? transport.cwd : resolve(sep);
            return { command: transport.command, args: transport.args, cwd, env };
        });
    }
    /** C6 and X6: start the server, list its tools, call read, and expect the probe goal. */
    async mcpProbe(group, id, target) {
        const probe = await this.probeOrWarn(group, id);
        if (probe === null)
            return;
        const spec = target(probe);
        const result = await this.deps.probeMcp(spec, PROBE_TIMEOUT_MS, (pid) => (this.probeChild = pid));
        const { TOOL_NAMES } = await import("../mcp/index.js");
        const expected = [...TOOL_NAMES].sort();
        const missing = expected.filter((tool) => !result.tools.includes(tool));
        const envFix = group === "codex"
            ? 'add env_vars = ["DIARCHY_PROJECT"] to [mcp_servers.diarchy] in ~/.codex/config.toml: Codex passes a server only its allowlist plus env_vars'
            : "the server did not get DIARCHY_PROJECT from its environment; check the plugin's .mcp.json";
        if (!result.connected || result.error !== null) {
            const fix = group === "codex" ? `run ${spec.command} ${spec.args.join(" ")} by hand and read the error; ${INSTALL_CLI} if it is not found` : `run ${spec.command} ${spec.args.join(" ")} by hand and read the error`;
            this.add(group, id, "fail", `the MCP server did not answer: ${result.error ?? "not connected"}`, fix);
        }
        else if (missing.length > 0) {
            this.add(group, id, "fail", `the MCP server lacks ${missing.join(", ")}`, "update the plugin to the version of this diarchy");
        }
        else if (result.rule === "NO_GOAL") {
            this.add(group, id, "fail", "read answered NO_GOAL: DIARCHY_PROJECT did not reach the server", envFix);
        }
        else if (result.goal !== probe.goalId) {
            this.add(group, id, "fail", `read answered ${result.goal ?? result.rule ?? "nothing"}, not the probe goal ${probe.goalId}`, envFix);
        }
        else if (result.version !== VERSION) {
            this.add(group, id, "warn", `serves ${result.tools.length} tools and read returned ${result.goal}, but the server is ${result.version ?? "unversioned"} and this CLI ${VERSION}`, "update the plugin and the global CLI to the same version");
        }
        else {
            this.add(group, id, "ok", `serves ${result.tools.length} tools (version ${result.version}); read returned ${result.goal}`);
        }
    }
    /**
     * X7: the guard hook in Codex's plugin copy, which has no node_modules and so
     * hands the call to the diarchy on PATH. Run in the probe project, as C7 is,
     * so it never writes the real project's diagnostics trail.
     */
    async codexGuard(pluginVersion) {
        const base = join(this.codexHome(), "plugins", "cache", "diarchy", "diarchy");
        let version = pluginVersion;
        if (version === null || !existsSync(join(base, version))) {
            const dirs = existsSync(base) ? readdirSync(base).filter((name) => statSync(join(base, name)).isDirectory()) : [];
            version = dirs.sort().at(-1) ?? null;
        }
        if (version === null) {
            this.add("codex", "X7", "skip", `no Codex plugin copy under ${base}`);
            return;
        }
        const hooks = join(base, version, "hooks");
        const probe = await this.probeOrWarn("codex", "X7");
        if (probe === null)
            return;
        const problems = this.guardProbe(hooks, "codex", { ...this.deps.env, DIARCHY_PROJECT: probe.dir }, probe.dir, false);
        if (problems.length === 0)
            this.add("codex", "X7", "ok", `the plugin copy's guard denies diarchy reply (${hooks})`);
        else
            this.add("codex", "X7", "fail", problems.join("; "), `${INSTALL_CLI}: the plugin copy has no node_modules and hands every hook to the diarchy on PATH`);
    }
    /** X8 and X9: hook trust and project trust in config.toml. Read with anchored patterns, so they only ever warn. */
    codexTrust(codex) {
        const configPath = join(this.codexHome(), "config.toml");
        const toml = readText(configPath) ?? "";
        const untrusted = CODEX_HOOK_EVENTS.filter((event) => {
            const table = tomlTable(toml, quotedHeader("hooks.state", `${PLUGIN_ID}:hooks/codex-hooks.json:${event}:0:0`));
            return table === null || !/^\s*trusted_hash\s*=/m.test(table);
        });
        const trusted = `${CODEX_HOOK_EVENTS.length - untrusted.length} of ${CODEX_HOOK_EVENTS.length} diarchy hooks trusted in ${configPath}`;
        if (codex.launch.args.includes(HOOK_TRUST_BYPASS)) {
            this.add("codex", "X8", "ok", `agents.${codex.agent}.args passes ${HOOK_TRUST_BYPASS}, so headless runs need no trust; interactive sessions still need /hooks (${trusted})`);
        }
        else if (untrusted.length === 0) {
            this.add("codex", "X8", "ok", trusted);
        }
        else {
            this.add("codex", "X8", "warn", `${trusted}; without ${HOOK_TRUST_BYPASS} codex exec skips untrusted hooks silently`, "start codex in the project, run /hooks, and approve the three diarchy hooks");
        }
        const project = realOrSame(this.projectDir);
        const table = tomlTable(toml, quotedHeader("projects", project));
        if (table !== null && /^\s*trust_level\s*=\s*["']trusted["']/m.test(table))
            this.add("codex", "X9", "ok", `${project} is trusted`);
        else
            this.add("codex", "X9", "warn", `${project} is not trusted in ${configPath}, so the subagents in .codex/agents do not load`, `start codex in the project once and accept the trust prompt, or add [projects."${project}"] trust_level = "trusted"`);
    }
    // -- live -----------------------------------------------------------------
    async live(out) {
        if (this.checks.some((check) => check.status === "fail")) {
            this.add("live", "L0", "skip", "not run: fix the failures above first");
            return;
        }
        const agents = Object.entries(this.agents).filter(([, launch]) => flavorOf(launch.command) !== "generic");
        if (agents.length === 0) {
            this.add("live", "L0", "skip", "no agent launches claude or codex");
            return;
        }
        let probe;
        try {
            probe = await probeProject(Object.keys(this.agents), true, this.deps, (dir) => this.temps.push(dir));
        }
        catch (error) {
            this.add("live", "L0", "fail", `could not make the live probe project: ${error instanceof Error ? error.message : String(error)}`, "check that the temp directory is writable and git works");
            return;
        }
        if (out !== undefined)
            mkdirSync(out, { recursive: true });
        for (const [agent, launch] of agents) {
            // A signal during the checks or the last turn stops the doctor here, before another model call.
            await settleSignals();
            this.liveTurn(probe, agent, launch, out);
        }
        if (out !== undefined && existsSync(join(probe.dir, DIAG_LOG)))
            copyFileSync(join(probe.dir, DIAG_LOG), join(out, "diag.log"));
    }
    /** One real turn: realPlan's command, args, and env, with the probe prompt in place of the PM prompt. */
    liveTurn(probe, agent, launch, out) {
        const plan = realPlan({ projectDir: probe.dir, agent, goalId: probe.goalId, launch, cwd: probe.dir, worktree: null, session: null, inGitRepo: true });
        const args = liveArgs(plan.flavor, plan.args, this.claude?.flags ?? null);
        const result = this.deps.run(plan.command, args, { cwd: plan.cwd, env: liveEnv(plan.env), timeoutMs: LIVE_TIMEOUT_MS });
        if (out !== undefined) {
            writeFileSync(join(out, `${agent}.stdout.txt`), result.stdout);
            writeFileSync(join(out, `${agent}.stderr.txt`), result.stderr);
        }
        const trail = readTrail(probe.dir).filter((line) => line.agent === agent);
        const output = `${result.stdout}\n${result.stderr}`;
        const passed = [];
        const failed = [];
        const check = (ok, yes, no) => {
            if (ok)
                passed.push(yes);
            else
                failed.push(no);
        };
        check(result.code === 0, "exit 0", failure(plan.command, result));
        check(result.stdout.includes(probe.goalId), "named the probe goal", "the output does not name the probe goal");
        const start = trail.find((line) => line.event === "mcp.start");
        check(start?.project_source === "env", "MCP server found the project through DIARCHY_PROJECT", start === undefined ? "no diarchy MCP server started" : `the MCP server found the project by ${String(start.project_source)}, not DIARCHY_PROJECT`);
        check(trail.some((line) => line.event === "mcp.tool" && line.tool === "read" && line.ok === true), "read answered", "read was not called, or failed");
        check(trail.some((line) => line.event === "hook.session_start"), "SessionStart hook ran", "the SessionStart hook did not run");
        check(trail.some((line) => line.event === "hook.stop"), "Stop hook ran", "the Stop hook did not run");
        if (plan.flavor === "codex")
            check(output.split("\n").some((line) => detectSessionId(line) !== null), "session id readable", "no session id in the output, so a restart cannot resume");
        if (plan.flavor === "claude" && plan.minted !== null) {
            const directory = this.claude?.projectsDirectory ?? null;
            if (directory !== null)
                check(transcriptExists(directory, plan.minted.session_id), "transcript saved", `no ${plan.minted.session_id}.jsonl under ${directory}, so a restart cannot resume`);
        }
        if (failed.length === 0)
            this.add("live", `L-${agent}`, "ok", `${agent}: ${passed.join(", ")}`);
        else
            this.add("live", `L-${agent}`, "fail", `${agent}: ${failed.join("; ")}`, liveHint(plan.flavor, agent, output, result, failed));
    }
}
/** The fields of `codex mcp get <name> --json` the checks need; null when the shape is not recognised. */
export function codexTransport(raw) {
    if (!isRecord(raw))
        return null;
    const transport = isRecord(raw.transport) ? raw.transport : raw;
    if (typeof transport.command !== "string")
        return null;
    const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    const envVars = Array.isArray(transport.env_vars)
        ? transport.env_vars.map((item) => (typeof item === "string" ? item : isRecord(item) && typeof item.name === "string" ? item.name : "")).filter((name) => name !== "")
        : [];
    const env = {};
    if (isRecord(transport.env))
        for (const [key, value] of Object.entries(transport.env))
            if (typeof value === "string")
                env[key] = value;
    const seconds = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
        enabled: raw.enabled !== false,
        type: typeof transport.type === "string" ? transport.type : "stdio",
        command: transport.command,
        args: strings(transport.args),
        env,
        envVars,
        cwd: typeof transport.cwd === "string" ? transport.cwd : null,
        startupTimeoutSec: seconds(raw.startup_timeout_sec ?? transport.startup_timeout_sec),
        toolTimeoutSec: seconds(raw.tool_timeout_sec ?? transport.tool_timeout_sec),
    };
}
/** The DIARCHY_* variables realPlan sets for a turn. */
const PLAN_VARS = new Set(["DIARCHY_AGENT", "DIARCHY_PROJECT", "DIARCHY_GOAL", "DIARCHY_WORKTREE"]);
/**
 * realPlan's env without any other DIARCHY_* variable the caller exported: a
 * DIARCHY_DIAG=0 would turn off the probe project's trail the checks read.
 * C6 starts its server from the same, with DIARCHY_DIAG=0 of its own.
 */
export function liveEnv(env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("DIARCHY_") || PLAN_VARS.has(key)));
}
/** realPlan's args with the probe prompt in place of the PM prompt, and Claude's spend cap when its --help lists the flag. */
export function liveArgs(flavor, planArgs, claudeFlags) {
    const args = planArgs.slice(0, -1);
    if (flavor === "claude" && claudeFlags?.has("--max-budget-usd") === true)
        args.push("--max-budget-usd", CLAUDE_SPEND_CAP_USD);
    args.push(PROBE_PROMPT);
    return args;
}
function readTrail(projectDir) {
    const text = readText(join(projectDir, DIAG_LOG)) ?? "";
    return text
        .split("\n")
        .map((line) => parseJson(line))
        .filter((line) => isRecord(line));
}
function transcriptExists(projectsDirectory, sessionId) {
    try {
        return readdirSync(projectsDirectory).some((dir) => existsSync(join(projectsDirectory, dir, `${sessionId}.jsonl`)));
    }
    catch {
        return false;
    }
}
/** The fix for a failed live turn, from what the CLI printed. */
export function liveHint(flavor, agent, output, result, failed) {
    if (result.error === "ETIMEDOUT")
        return `the turn took longer than ${LIVE_TIMEOUT_MS / 1000} s; run it by hand with --out to read the output`;
    if (/not logged in|please run \/login|login required/i.test(output))
        return flavor === "codex" ? "codex login" : "claude auth login";
    if (/NO_GOAL/.test(output) || failed.some((line) => line.includes("not DIARCHY_PROJECT"))) {
        return flavor === "codex" ? 'add env_vars = ["DIARCHY_PROJECT"] to [mcp_servers.diarchy] in ~/.codex/config.toml' : "the MCP server did not get DIARCHY_PROJECT; check the plugin's .mcp.json";
    }
    if (/not inside a trusted directory/i.test(output))
        return "codex exec runs only in a git repository or a trusted directory: start diarchy from a git repository";
    if (/permission|not allowed|denied|requires approval/i.test(output)) {
        return `the diarchy tools were not allowed: the --allowedTools rule in agents.${agent}.args must name the server's tools (mcp__plugin_diarchy_diarchy__* for the plugin, mcp__diarchy__* for claude mcp add)`;
    }
    if (failed.some((line) => line.includes("hook did not run"))) {
        return flavor === "codex" ? `keep ${HOOK_TRUST_BYPASS} in agents.${agent}.args, or trust the hooks in /hooks` : "enable the plugin (claude plugin enable diarchy@diarchy) and check that disableAllHooks is off";
    }
    if (failed.some((line) => line.includes("no diarchy MCP server started")))
        return flavor === "codex" ? "check [mcp_servers.diarchy] (codex mcp get diarchy)" : "check /mcp in Claude Code";
    return `run diarchy doctor --live --out <dir> and read ${agent}.stdout.txt and ${agent}.stderr.txt`;
}
function stringEnv(env) {
    const out = {};
    for (const [key, value] of Object.entries(env))
        if (value !== undefined)
            out[key] = value;
    return out;
}
// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
const GROUPS = ["env", "project", "claude", "codex", "live"];
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
export async function doctorReport(projectDir, options = {}, deps = defaultDeps()) {
    const doctor = new Doctor(projectDir, deps);
    // A signal's default action skips the finally below, so a handler kills a
    // probe's MCP server still running, deletes the probe projects, and exits.
    // It runs only when the event loop polls, which a spawnSync in progress (a
    // check, or a live turn of up to 180 s) does not let it do: hence
    // settleSignals before each live turn and before the handlers come off, or
    // a signal would be dropped and the run go on.
    const onSignal = (signal) => {
        doctor.killProbe();
        doctor.cleanup();
        process.exit(128 + constants.signals[signal]);
    };
    for (const signal of SIGNALS)
        process.on(signal, onSignal);
    try {
        await doctor.offline();
        if (options.live === true)
            await doctor.live(options.out === undefined ? undefined : resolve(options.out));
    }
    finally {
        await settleSignals();
        for (const signal of SIGNALS)
            process.off(signal, onSignal);
        doctor.cleanup();
    }
    // The config is read first because it names the agents, but env leads the report.
    const checks = [...doctor.checks].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
    return { version: VERSION, platform: deps.platform, project: projectDir, checks };
}
export function formatReport(report) {
    const lines = [`diarchy doctor ${report.version} · ${report.platform} · ${report.project}`];
    for (const group of GROUPS) {
        const checks = report.checks.filter((check) => check.group === group);
        if (checks.length === 0)
            continue;
        lines.push("", group);
        for (const check of checks) {
            lines.push(`  ${check.status.padEnd(4)}  ${check.id.padEnd(8)}  ${check.summary}`);
            if (check.fix !== undefined)
                lines.push(`${" ".repeat(18)}fix: ${check.fix}`);
        }
    }
    const count = (status) => report.checks.filter((check) => check.status === status).length;
    lines.push("", `${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip`);
    return lines.join("\n");
}
export async function runDoctor(projectDir, options = {}, deps = defaultDeps()) {
    const report = await doctorReport(projectDir, options, deps);
    if (options.json === true)
        printJson(report);
    else
        process.stdout.write(`${formatReport(report)}\n`);
    return report.checks.some((check) => check.status === "fail") ? 1 : 0;
}
//# sourceMappingURL=doctor.js.map