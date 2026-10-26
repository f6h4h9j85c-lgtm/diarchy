/**
 * `diarchy smoke`: one live run of both PMs on a two-criterion goal in a
 * throwaway git repository, then a diagnostics bundle to send back.
 *
 * Setup: `<tmp>/smoke-app`, whose vault `smoke-app brain/diarchy` has a space
 * in its path; `git init` on main with a local identity; a package.json whose
 * `npm test` runs `node --test`; `diarchy init`; a config patch (review off,
 * or on with --github; one restart per agent; a 60 s wall-clock grace;
 * `--max-budget-usd` for Claude when its --help lists it); a commit; and the
 * diagnostics marker (diag.ts). Then `diarchy doctor --json`, with `--live`
 * unless --no-ping: any fail ends the run before a goal exists, so a broken
 * setup costs cents, not minutes. `--github owner/repo` first checks that gh is
 * logged in and the repository is empty and writable, and once the doctor
 * passes pushes main to it, so the PMs open and cross-review real PRs.
 *
 * Run: `diarchy kickoff` (lead claude, slug smoke), then `diarchy watch` and
 * `diarchy start`, each line teed to the terminal and to its log, prefixed with
 * the seconds since the run began. A watchdog sends start SIGTERM 3 min after the
 * wall clock and SIGKILL after it has had time to stop both PMs.
 *
 * Every child runs with every DIARCHY_* variable removed from its environment
 * and an explicit --project, so nothing reaches a real project. `--driver fake`
 * runs the same pipeline with the scripted PM and no model calls, and saves the
 * doctor report without gating on it, since the fake PM needs neither CLI.
 *
 * The bundle `<out>/diarchy-smoke-<stamp>/` and its .tar.gz hold the logs, the
 * goal's vault directory, the launcher state, git state, versions, the
 * transcripts of both CLIs (unless --no-transcripts), and the verdict in
 * summary.json and summary.txt. Every file in it is redacted: home paths,
 * emails, and common token shapes.
 *
 * Exit codes: 0 DONE, 2 BLOCKED once both PMs posted, 1 otherwise.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VERSION } from "../index.js";
import { parseMessageId } from "../protocol/index.js";
import { CONFIG_FILENAME, loadConfig, vaultPaths } from "../vault/index.js";
import { CliError, EXIT_BLOCKED, EXIT_ERROR, EXIT_OK, onBrokenPipe, sleep } from "./common.js";
import { DIAG_LOG, DIAG_MARKER } from "./diag.js";
import { helpFlags, spawnRunner } from "./doctor.js";
import { flavorOf, tsxLoader } from "./drivers.js";
import { loadLauncherConfig } from "./launcher-config.js";
import { pidPath, reapLeftovers } from "./run-record.js";
export const SMOKE_SLUG = "smoke";
export const SMOKE_GOAL = "Add greet.mjs at the repository root exporting greet(name): greet('Ada') returns 'Hello, Ada!' and greet('') throws a TypeError. " +
    "Add node:test tests under test/ that npm test runs. This is a diarchy smoke run: keep the change that small.";
export const SMOKE_ACS = ["npm test passes and a test asserts greet('Ada') returns 'Hello, Ada!'", "a test asserts greet('') throws a TypeError"];
export const SMOKE_LAUNCHER = { max_restarts: 1, restart_backoff_ms: 3_000, stop_grace_ms: 15_000, wall_clock_grace_ms: 60_000 };
/** After the wall clock: the 60 s grace plus room for start to stop both PMs. */
export const WATCHDOG_MARGIN_MS = 3 * 60_000;
/** After the watchdog's SIGTERM: start waits stop_grace_ms twice (for the PMs to exit, then after its SIGTERM) before its own SIGKILL. */
export const KILL_AFTER_MS = 2 * SMOKE_LAUNCHER.stop_grace_ms + 15_000;
/** Test hooks, read by this process only (every child loses DIARCHY_*): the watchdog deadline in ms, and the script for --driver fake. */
const WATCHDOG_ENV = "DIARCHY_SMOKE_WATCHDOG_MS";
const FAKE_SCRIPT_ENV = "DIARCHY_SMOKE_FAKE_SCRIPT";
const DOCTOR_TIMEOUT_MS = 15 * 60_000;
const STEP_TIMEOUT_MS = 120_000;
const WRITERS = ["ADMIN", "MAINTAIN", "WRITE"];
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** The argv after `node` that runs this same diarchy: the built entry, or the source entry through tsx. */
export function selfArgs() {
    const here = fileURLToPath(import.meta.url);
    const source = here.endsWith(".ts");
    const entry = join(dirname(here), source ? "index.ts" : "index.js");
    return source ? ["--import", tsxLoader(), entry] : [entry];
}
/** `env` without any DIARCHY_* variable, so a child cannot find a project or a mode the caller set. */
export function childEnv(env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("DIARCHY_")));
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Text safe to send back: common token shapes (sk-, ghp_ and the other GitHub
 * prefixes, github_pat_, xox, AKIA and ASIA, Bearer) keep their prefix only,
 * emails become `[email]`, and the home directory becomes `~`.
 */
export function redact(text, home = homedir()) {
    let out = text
        .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-…REDACTED")
        .replace(/\b(gh[pousr]_)[A-Za-z0-9]{8,}/g, "$1…REDACTED")
        .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "github_pat_…REDACTED")
        .replace(/\b(xox[abposr]-)[A-Za-z0-9-]{4,}/g, "$1…REDACTED")
        .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1…REDACTED")
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 …REDACTED")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]");
    if (home.length > 1)
        out = out.replace(new RegExp(`${escapeRegExp(home)}(?![A-Za-z0-9._-])`, "g"), "~");
    return out;
}
function firstLine(text) {
    return text.trim().split("\n")[0]?.trim() ?? "";
}
/** Why a command failed, in a few words. */
function why(result) {
    if (result.error !== null)
        return result.error;
    return firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code ?? "on a signal"}`;
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
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
const str = (value) => (typeof value === "string" ? value : null);
function positiveInt(flag, value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1)
        throw new CliError(`${flag} must be a whole number of at least 1, got "${value}"`);
    return number;
}
function positiveNumber(flag, value) {
    const number = Number(value);
    if (value.trim() === "" || !Number.isFinite(number) || number <= 0)
        throw new CliError(`${flag} must be a positive number, got "${value}"`);
    return number;
}
export function parseRepo(value) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
        throw new CliError(`--github expects owner/repo, got "${value}"`);
    return value;
}
/** Every regular file under `dir`, relative to it; a broken link is skipped. */
function filesUnder(dir) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((rel) => statSync(join(dir, rel), { throwIfNoEntry: false })?.isFile() === true);
}
/** Claude Code's directory name for a cwd under its projects directory. */
const claudeDirName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");
/** The first line of a file, reading at most 1 MB. */
function headLine(path) {
    const fd = openSync(path, "r");
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
    }
    catch {
        return "";
    }
    finally {
        closeSync(fd);
    }
}
/**
 * The transcripts of this run. Claude: each projects/ directory named after a
 * PM's cwd, and any holding a saved session id's `<id>.jsonl` (with its
 * `<id>/` subagent directory). Codex: `sessions/**\/rollout-*-<id>.jsonl` for a
 * saved thread id, and any rollout written since the run began whose
 * session_meta cwd is one of the PMs' cwds.
 */
export function findTranscripts(sources) {
    const copies = [];
    const cwdDirs = new Set(sources.cwds.map(claudeDirName));
    const projects = existsSync(sources.claudeProjects) ? readdirSync(sources.claudeProjects) : [];
    for (const name of projects) {
        const dir = join(sources.claudeProjects, name);
        if (cwdDirs.has(name)) {
            copies.push({ from: dir, to: join("claude", name) });
            continue;
        }
        for (const id of sources.claudeSessions) {
            for (const entry of [`${id}.jsonl`, id]) {
                if (existsSync(join(dir, entry)))
                    copies.push({ from: join(dir, entry), to: join("claude", name, entry) });
            }
        }
    }
    const sessions = join(sources.codexHome, "sessions");
    const cwds = new Set(sources.cwds);
    for (const rel of filesUnder(sessions)) {
        const name = basename(rel);
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl"))
            continue;
        const path = join(sessions, rel);
        let match = sources.codexSessions.some((id) => name.endsWith(`-${id}.jsonl`));
        if (!match && statSync(path).mtimeMs >= sources.since) {
            const meta = parseJson(headLine(path));
            const cwd = isRecord(meta) && isRecord(meta.payload) ? str(meta.payload.cwd) : null;
            match = cwd !== null && cwds.has(cwd);
        }
        if (match)
            copies.push({ from: path, to: join("codex", name) });
    }
    return copies;
}
/** Per-agent counts from the diagnostics trail. */
export function trailCounts(log, agent) {
    const counts = { mcp_start: 0, project_sources: [], tools_ok: 0, tools_rejected: 0, rejected_rules: [], session_start: 0, stop: 0, stop_blocks: 0, guard_denies: 0 };
    for (const text of log.split("\n")) {
        const line = parseJson(text);
        if (!isRecord(line) || line.agent !== agent)
            continue;
        if (line.event === "mcp.start") {
            counts.mcp_start += 1;
            const source = str(line.project_source) ?? "unknown";
            if (!counts.project_sources.includes(source))
                counts.project_sources.push(source);
        }
        else if (line.event === "mcp.tool") {
            if (line.ok === true)
                counts.tools_ok += 1;
            else {
                counts.tools_rejected += 1;
                const rule = str(line.rule);
                if (rule !== null && !counts.rejected_rules.includes(rule))
                    counts.rejected_rules.push(rule);
            }
        }
        else if (line.event === "hook.session_start")
            counts.session_start += 1;
        else if (line.event === "hook.stop") {
            counts.stop += 1;
            if (line.decision === "block")
                counts.stop_blocks += 1;
        }
        else if (line.event === "hook.pre_tool_use" && line.decision === "deny")
            counts.guard_denies += 1;
    }
    return counts;
}
/** Spawns, exits, and restarts per agent from the supervisor's lines in start.log. */
export function supervisorEvents(log, agent) {
    const events = { spawned: 0, exits: [], restarts: 0 };
    const pattern = /^\[\s*\d+s\] \d\d:\d\d:\d\d (\S+) (started|exited \(([^)]*)\)|restarting in)/;
    for (const line of log.split("\n")) {
        const match = pattern.exec(line);
        if (match === null || match[1] !== agent)
            continue;
        if (match[2] === "started")
            events.spawned += 1;
        else if (match[2] === "restarting in")
            events.restarts += 1;
        else
            events.exits.push(match[3] ?? "");
    }
    return events;
}
/** The tiered verdict: L1 both PMs posted, L2 the goal reached EXECUTE, L3 DONE. */
export function verdictOf(input) {
    const L3 = input.phase === "DONE";
    const L2 = L3 || input.phase === "EXECUTE" || input.blockedFrom === "EXECUTE" || input.chatMd.includes("## → EXECUTE");
    const L1 = input.posted.length > 0 && input.posted.every((count) => count > 0);
    const levels = { L1, L2, L3 };
    if (input.aborted)
        return { verdict: "aborted", exitCode: EXIT_ERROR, levels };
    if (L3)
        return { verdict: "DONE", exitCode: EXIT_OK, levels };
    if (input.phase === "BLOCKED")
        return { verdict: "BLOCKED", exitCode: L1 ? EXIT_BLOCKED : EXIT_ERROR, levels };
    return { verdict: "stalled", exitCode: EXIT_ERROR, levels };
}
const yes = (value) => (value ? "yes" : "no");
export function formatSummary(summary) {
    const minutes = Math.floor(summary.duration_s / 60);
    const head = `diarchy smoke ${summary.version} · driver ${summary.driver} · ${summary.mode === "github" ? `github ${summary.repo ?? ""}` : "local"} · ${minutes}m ${summary.duration_s % 60}s`;
    const verdict = summary.verdict === "aborted" && summary.aborted !== null
        ? `aborted at ${summary.aborted.step}: ${summary.aborted.reason}`
        : summary.verdict === "BLOCKED"
            ? `BLOCKED: ${summary.block ?? "no reason recorded"}`
            : summary.verdict;
    const lines = [
        head,
        `verdict  ${verdict} (exit ${summary.exit_code})`,
        `levels   L1 both PMs posted ${yes(summary.levels.L1)} · L2 reached EXECUTE ${yes(summary.levels.L2)} · L3 DONE ${yes(summary.levels.L3)}`,
        `goal     ${summary.goal ?? "none"} · phase ${summary.phase ?? "none"}${summary.blocked_from === null ? "" : ` (from ${summary.blocked_from})`} · start ${summary.start_exit ?? "not run"}`,
    ];
    if (summary.watchdog.fired)
        lines.push(`watchdog fired after ${summary.watchdog.after_s} s${summary.watchdog.killed ? "; start was killed" : ""}`);
    if (summary.interrupted)
        lines.push("interrupted by a signal");
    for (const [agent, info] of Object.entries(summary.agents)) {
        const session = info.session_id === null ? "no session" : `session ${info.session_id} (${info.session_source ?? "?"})`;
        lines.push(`${agent.padEnd(8)} posted ${info.posted} · spawned ${info.spawned} · restarts ${info.restarts} · early exits ${info.exits.join(", ") || "none"} · ${session}`);
        const trail = info.trail;
        const sources = trail.project_sources.length === 0 ? "" : ` via ${trail.project_sources.join(", ")}`;
        const rules = trail.rejected_rules.length === 0 ? "" : ` (${trail.rejected_rules.join(", ")})`;
        lines.push(`${" ".repeat(9)}MCP starts ${trail.mcp_start}${sources} · tools ${trail.tools_ok} ok, ${trail.tools_rejected} rejected${rules} · SessionStart ${trail.session_start} · Stop ${trail.stop} (${trail.stop_blocks} block) · guard denies ${trail.guard_denies}`);
    }
    if (summary.prs !== null)
        lines.push(`PRs      ${summary.prs} in ${summary.repo ?? ""}`);
    if (summary.doctor.fail.length > 0)
        lines.push(`doctor   ${summary.doctor.fail.length} fail${summary.doctor.gated ? "" : " (not gating: --driver fake)"}: ${summary.doctor.fail.join(", ")}`);
    for (const note of summary.notes)
        lines.push(`note     ${note}`);
    lines.push(`project  ${summary.project}${summary.project_kept ? " (kept; delete it when done)" : " (removed)"}`);
    lines.push(`bundle   ${summary.bundle}`);
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
class Abort extends Error {
    step;
    constructor(step, message) {
        super(message);
        this.step = step;
    }
}
class SmokeRun {
    settings;
    started = Date.now();
    root;
    project;
    bundle;
    env;
    self = selfArgs();
    quiet = false;
    interrupted = 0;
    start = null;
    goalId = null;
    aborted = null;
    doctorFail = [];
    spendCap = null;
    startExit = null;
    watchdog = { after_s: 0, fired: false, killed: false };
    transcriptCount = null;
    notes = [];
    constructor(settings, outDir) {
        this.settings = settings;
        const stamp = new Date(this.started).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
        this.bundle = join(outDir, `diarchy-smoke-${stamp}`);
        mkdirSync(this.bundle, { recursive: true });
        this.root = realpathSync(mkdtempSync(join(tmpdir(), "diarchy-smoke-")));
        this.project = join(this.root, "smoke-app");
        this.env = childEnv(process.env);
    }
    elapsed() {
        return `[${String(Math.floor((Date.now() - this.started) / 1000)).padStart(4)}s]`;
    }
    say(line) {
        if (this.quiet)
            return;
        try {
            process.stdout.write(`${this.elapsed()} smoke | ${line}\n`);
        }
        catch {
            this.quiet = true;
        }
    }
    /** The terminal went away: keep running and writing the bundle, print nothing more. */
    silence() {
        this.quiet = true;
    }
    checkInterrupted(step) {
        if (this.interrupted > 0)
            throw new Abort(step, "interrupted by a signal");
    }
    put(rel, text) {
        const path = join(this.bundle, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    }
    run(command, args, cwd, timeoutMs = STEP_TIMEOUT_MS) {
        return spawnRunner(command, args, { cwd, env: this.env, timeoutMs });
    }
    /** `diarchy <args> --project <project>`, run to completion. */
    diarchy(args, timeoutMs = STEP_TIMEOUT_MS) {
        return this.run(process.execPath, [...this.self, ...args, "--project", this.project], this.project, timeoutMs);
    }
    git(step, args, timeoutMs = STEP_TIMEOUT_MS) {
        const result = this.run("git", args, this.project, timeoutMs);
        if (result.code !== 0)
            throw new Abort(step, `git ${args.join(" ")}: ${why(result)}`);
        return result.stdout;
    }
    // -- setup ----------------------------------------------------------------
    /** gh logged in, and `repo` empty and writable; returns the URL to push to. */
    github(repo) {
        const auth = this.run("gh", ["auth", "status"], this.root);
        if (auth.code !== 0)
            throw new Abort("github", `gh is not logged in (${why(auth)}); run gh auth login`);
        const view = this.run("gh", ["repo", "view", repo, "--json", "isEmpty,url,viewerPermission"], this.root);
        if (view.code !== 0)
            throw new Abort("github", `gh repo view ${repo} failed (${why(view)}); create it first: gh repo create ${repo} --private`);
        const info = parseJson(view.stdout);
        const url = isRecord(info) ? str(info.url) : null;
        if (!isRecord(info) || url === null)
            throw new Abort("github", `could not read gh repo view ${repo} output`);
        if (info.isEmpty !== true) {
            throw new Abort("github", `${repo} is not empty: smoke pushes a new main branch to it and the PMs open PRs against that, so give it a new empty repository (gh repo create <name> --private) for each run`);
        }
        if (!WRITERS.includes(String(info.viewerPermission)))
            throw new Abort("github", `you cannot push to ${repo} (permission ${String(info.viewerPermission)})`);
        this.say(`github: ${repo} is empty and writable`);
        return url.startsWith("https://") ? `${url}.git` : url;
    }
    setup(remote) {
        mkdirSync(this.project);
        this.git("setup", ["init", "-q"]);
        this.git("setup", ["symbolic-ref", "HEAD", "refs/heads/main"]);
        for (const [key, value] of [
            ["user.name", "diarchy smoke"],
            ["user.email", "smoke@diarchy.invalid"],
            ["commit.gpgsign", "false"],
        ]) {
            this.git("setup", ["config", key, value]);
        }
        if (remote !== null) {
            this.git("setup", ["remote", "add", "origin", remote]);
            if (remote.startsWith("https://")) {
                // What `gh auth setup-git` writes, kept in this repository: the PMs push through gh's login.
                const key = `credential.${new URL(remote).origin}.helper`;
                this.git("setup", ["config", "--add", key, ""]);
                this.git("setup", ["config", "--add", key, "!gh auth git-credential"]);
            }
        }
        writeFileSync(join(this.project, "package.json"), `${JSON.stringify({ name: "smoke-app", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
        writeFileSync(join(this.project, "README.md"), "# smoke-app\n\nA throwaway project for `diarchy smoke`.\n");
        this.git("setup", ["add", "-A"]);
        this.git("setup", ["commit", "-q", "-m", "Initial commit"]);
        this.say(`project ${this.project}`);
        this.checkInterrupted("setup");
        const init = this.diarchy(["init"]);
        this.put("init.log", `${init.stdout}${init.stderr}`);
        if (init.code !== 0)
            throw new Abort("init", `diarchy init: ${why(init)}`);
        this.patchConfig(remote !== null);
        this.git("setup", ["add", "-A"]);
        this.git("setup", ["commit", "-q", "-m", "Add diarchy"]);
        mkdirSync(join(this.project, ".diarchy"), { recursive: true });
        writeFileSync(join(this.project, DIAG_MARKER), "");
        this.checkInterrupted("setup");
    }
    /** After the doctor passed, so a failed setup leaves the repository empty for the next try. */
    push() {
        this.git("github", ["push", "-q", "-u", "origin", "main"]);
        this.say("github: pushed main");
    }
    patchConfig(review) {
        const path = join(this.project, CONFIG_FILENAME);
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.review = { required: review };
        config.launcher = { ...config.launcher, ...SMOKE_LAUNCHER };
        if (this.settings.driver === "real") {
            for (const launch of Object.values(config.agents ?? {})) {
                if (flavorOf(launch.command) !== "claude")
                    continue;
                const help = this.run(launch.command, ["--help"], this.project);
                if (help.code !== 0 || !helpFlags(help.stdout).has("--max-budget-usd"))
                    continue;
                this.spendCap = String(this.settings.maxUsd);
                launch.args = [...(launch.args ?? []), "--max-budget-usd", this.spendCap];
            }
            if (this.spendCap === null)
                this.notes.push("claude does not list --max-budget-usd, so its spend is capped only by --minutes");
        }
        writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    }
    /** `diarchy doctor --json`, with --live unless --no-ping; a real run stops here on any fail. */
    doctor() {
        const live = this.settings.driver === "real" && this.settings.ping;
        this.say(`doctor${live ? " --live (one short real turn per CLI)" : ""}`);
        const result = this.diarchy(["doctor", "--json", ...(live ? ["--live", "--out", join(this.bundle, "ping")] : [])], DOCTOR_TIMEOUT_MS);
        this.put("doctor.json", result.stdout);
        if (result.stderr.trim() !== "")
            this.put("doctor.stderr.txt", result.stderr);
        const report = parseJson(result.stdout);
        const checks = isRecord(report) && Array.isArray(report.checks) ? report.checks.filter(isRecord) : null;
        const gated = this.settings.driver === "real";
        if (checks === null) {
            if (gated)
                throw new Abort("doctor", `diarchy doctor did not report (${why(result)})`);
            this.notes.push(`diarchy doctor did not report (${why(result)})`);
            return;
        }
        const fails = checks.filter((check) => check.status === "fail");
        this.doctorFail = fails.map((check) => String(check.id));
        if (gated && fails.length > 0) {
            const list = fails.map((check) => `${String(check.id)} ${String(check.summary)}`).join("; ");
            throw new Abort("doctor", `${fails.length} doctor check${fails.length === 1 ? "" : "s"} failed: ${list}. doctor.json has a fix line for each; fix them and run diarchy smoke again`);
        }
        this.say(`doctor: ${checks.length} checks, ${fails.length} fail${gated || fails.length === 0 ? "" : " (not gating: --driver fake needs neither CLI)"}`);
        this.checkInterrupted("doctor");
    }
    kickoff() {
        const args = ["kickoff", SMOKE_GOAL, ...SMOKE_ACS.flatMap((ac) => ["--ac", ac]), "--lead", "claude", "--slug", SMOKE_SLUG];
        for (const budget of [`wall_clock_minutes=${this.settings.minutes}`, "messages_total=40", "plan_messages=8"])
            args.push("--budget", budget);
        const result = this.diarchy([...args, "--json"]);
        this.put("kickoff.json", result.stdout === "" ? result.stderr : result.stdout);
        const parsed = parseJson(result.stdout);
        this.goalId = isRecord(parsed) ? str(parsed.goal_id) : null;
        if (result.code !== 0 || this.goalId === null)
            throw new Abort("kickoff", `diarchy kickoff: ${why(result)}`);
        this.say(`kickoff ${this.goalId}`);
        this.checkInterrupted("kickoff");
    }
    // -- the run --------------------------------------------------------------
    /** Spawn `diarchy <args>`, writing each line to `log` and the terminal, prefixed with the seconds since the run began. */
    spawnLogged(name, args, log) {
        const file = join(this.bundle, log);
        writeFileSync(file, "");
        const proc = spawn(process.execPath, [...this.self, ...args, "--project", this.project], { cwd: this.project, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
        for (const stream of [proc.stdout, proc.stderr]) {
            createInterface({ input: stream }).on("line", (line) => {
                const stamped = `${this.elapsed()} ${line}`;
                appendFileSync(file, `${stamped}\n`);
                if (!this.quiet) {
                    try {
                        process.stdout.write(`${this.elapsed()} ${name} | ${line}\n`);
                    }
                    catch {
                        this.quiet = true;
                    }
                }
            });
        }
        const closed = new Promise((done) => {
            proc.on("error", (error) => done(`spawn error ${error.message}`));
            proc.on("close", (code, signal) => done(signal !== null ? `signal ${signal}` : `code ${code ?? "?"}`));
        });
        return { proc, closed };
    }
    async runGoal() {
        const watch = this.spawnLogged("watch", ["watch"], "watch.log");
        const startArgs = ["start"];
        if (this.settings.driver === "fake") {
            startArgs.push("--driver", "fake");
            const script = process.env[FAKE_SCRIPT_ENV];
            if (script !== undefined && script !== "")
                startArgs.push("--fake-script", resolve(script));
        }
        const start = this.spawnLogged("start", startArgs, "start.log");
        this.start = start.proc;
        const override = Number(process.env[WATCHDOG_ENV]);
        const deadline = Number.isInteger(override) && override > 0 ? override : this.settings.minutes * 60_000 + WATCHDOG_MARGIN_MS;
        this.watchdog.after_s = Math.round(deadline / 1000);
        let kill;
        const dog = setTimeout(() => {
            this.watchdog.fired = true;
            this.say(`watchdog: start still running after ${this.watchdog.after_s} s; sending SIGTERM`);
            start.proc.kill("SIGTERM");
            kill = setTimeout(() => {
                this.watchdog.killed = true;
                this.say("watchdog: start did not exit; sending SIGKILL");
                start.proc.kill("SIGKILL");
            }, KILL_AFTER_MS);
        }, deadline);
        this.startExit = await start.closed;
        clearTimeout(dog);
        clearTimeout(kill);
        this.start = null;
        this.say(`start exited (${this.startExit})`);
        // watch exits by itself on DONE or BLOCKED; otherwise it would follow the goal forever.
        if ((await Promise.race([watch.closed, sleep(5_000).then(() => null)])) === null) {
            watch.proc.kill("SIGTERM");
            if ((await Promise.race([watch.closed, sleep(5_000).then(() => null)])) === null)
                watch.proc.kill("SIGKILL");
        }
        // A start that was killed leaves its PMs and its record behind: keep the record, then stop them.
        const record = pidPath(this.project);
        if (existsSync(record))
            cpSync(record, join(this.bundle, "runtime", "start.pid"));
        for (const leftover of await reapLeftovers(this.project))
            this.notes.push(`stopped ${leftover.agent} (pid ${leftover.pid}), left running by start`);
    }
    /** Forward a signal: first SIGTERM to start (which stops both PMs), then SIGKILL. */
    onSignal(signal) {
        this.interrupted += 1;
        if (this.start !== null)
            this.start.kill(this.interrupted > 1 ? "SIGKILL" : "SIGTERM");
        this.say(`${signal}: stopping the run; the bundle is still written${this.interrupted > 1 ? "" : " (again to kill start)"}`);
    }
    // -- the bundle -----------------------------------------------------------
    attempt(what, work) {
        try {
            work();
        }
        catch (error) {
            this.notes.push(`could not collect ${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    collect() {
        if (!existsSync(join(this.project, CONFIG_FILENAME))) {
            this.attempt("versions", () => this.versions(null));
            return;
        }
        this.attempt("status", () => {
            const status = this.diarchy(["status", "--json"]);
            this.put("status.json", status.stdout === "" ? status.stderr : status.stdout);
        });
        this.attempt("the vault", () => {
            if (this.goalId === null)
                return;
            const goal = join(vaultPaths(this.project, loadConfig(this.project)).goals, this.goalId);
            if (existsSync(goal))
                cpSync(goal, join(this.bundle, "vault"), { recursive: true });
        });
        this.attempt("the launcher state", () => {
            const runtime = join(this.project, ".diarchy");
            if (!existsSync(runtime))
                return;
            for (const name of readdirSync(runtime)) {
                if (name === "sessions" || name.startsWith("gate-") || name === basename(DIAG_LOG) || name === "start.pid")
                    cpSync(join(runtime, name), join(this.bundle, "runtime", name), { recursive: true });
            }
        });
        this.attempt("diarchy.config.json", () => cpSync(join(this.project, CONFIG_FILENAME), join(this.bundle, CONFIG_FILENAME)));
        this.attempt("git state", () => this.gitState());
        this.attempt("versions", () => this.versions(loadLauncherConfig(this.project, Object.keys(loadConfig(this.project).agents)).agents));
        if (this.settings.repo !== null) {
            const repo = this.settings.repo;
            this.attempt("the PRs", () => {
                const prs = this.run("gh", ["pr", "list", "--repo", repo, "--state", "all", "--json", "number,title,state,headRefName,baseRefName,url,author,reviews"], this.root);
                this.put(join("git", "prs.json"), prs.code === 0 ? prs.stdout : `gh pr list failed: ${why(prs)}\n`);
            });
        }
        if (this.settings.transcripts)
            this.attempt("transcripts", () => this.transcripts());
    }
    gitState() {
        const log = this.run("git", ["log", "--all", "--graph", "--decorate"], this.project);
        this.put(join("git", "log.txt"), log.stdout + log.stderr);
        const list = this.run("git", ["worktree", "list", "--porcelain"], this.project);
        this.put(join("git", "worktrees.txt"), list.stdout + list.stderr);
        let path = null;
        for (const line of `${list.stdout}\n`.split("\n")) {
            if (line.startsWith("worktree "))
                path = line.slice("worktree ".length);
            else if (line.startsWith("branch ") && path !== null && path !== this.project) {
                const branch = line.slice("branch refs/heads/".length);
                const name = basename(path);
                const status = this.run("git", ["status", "--short", "--branch"], path);
                this.put(join("git", `${name}.status.txt`), status.stdout + status.stderr);
                const diff = this.run("git", ["diff", "--stat", `main...${branch}`], this.project);
                this.put(join("git", `${name}.diff-stat.txt`), `main...${branch}\n${diff.stdout}${diff.stderr}`);
            }
        }
    }
    versions(agents) {
        const version = (command, args) => {
            const result = this.run(command, args, this.root);
            return result.code === 0 ? firstLine(result.stdout) : `not available (${why(result)})`;
        };
        const lines = [`diarchy ${VERSION} (${this.self[this.self.length - 1] ?? ""})`, `node ${process.version}`, `git ${version("git", ["--version"])}`];
        for (const [agent, launch] of Object.entries(agents ?? { claude: { command: "claude" }, codex: { command: "codex" } }))
            lines.push(`${agent} (${launch.command}) ${version(launch.command, ["--version"])}`);
        if (this.settings.repo !== null)
            lines.push(`gh ${version("gh", ["--version"])}`);
        lines.push(`os ${platform()} ${release()} ${arch()}`, `driver ${this.settings.driver}, ${this.settings.repo === null ? "local" : `github ${this.settings.repo}`}`);
        this.put("versions.txt", `${lines.join("\n")}\n`);
    }
    transcripts() {
        const config = loadConfig(this.project);
        const launches = loadLauncherConfig(this.project, Object.keys(config.agents)).agents;
        const sessions = (flavor) => Object.entries(launches)
            .filter(([, launch]) => flavorOf(launch.command) === flavor)
            .map(([agent]) => readJson(join(this.project, ".diarchy", "sessions", `${agent}.json`)))
            .map((record) => (isRecord(record) ? str(record.session_id) : null))
            .filter((id) => id !== null);
        const home = homedir();
        let claudeProjects = join(this.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
        const claude = Object.values(launches).find((launch) => flavorOf(launch.command) === "claude");
        if (this.settings.driver === "real" && claude !== undefined) {
            const auth = parseJson(this.run(claude.command, ["auth", "status", "--json"], this.root).stdout);
            if (isRecord(auth) && typeof auth.projectsDirectory === "string")
                claudeProjects = auth.projectsDirectory;
        }
        const cwds = [this.project, ...Object.keys(config.agents).map((agent) => resolve(this.project, config.worktrees.root, agent))];
        const copies = findTranscripts({
            claudeProjects,
            codexHome: this.env.CODEX_HOME !== undefined && this.env.CODEX_HOME !== "" ? this.env.CODEX_HOME : join(home, ".codex"),
            claudeSessions: sessions("claude"),
            codexSessions: sessions("codex"),
            cwds,
            since: this.started,
        });
        for (const copy of copies)
            cpSync(copy.from, join(this.bundle, "transcripts", copy.to), { recursive: true });
        this.transcriptCount = filesUnder(join(this.bundle, "transcripts")).length;
    }
    /** Redact every file in the bundle in place. */
    redactBundle() {
        for (const rel of filesUnder(this.bundle)) {
            const path = join(this.bundle, rel);
            const text = readFileSync(path, "utf8");
            if (text.includes("\u0000"))
                continue;
            const clean = redact(text);
            if (clean !== text)
                writeFileSync(path, clean);
        }
    }
    summary() {
        const status = readJson(join(this.bundle, "status.json"));
        const phase = isRecord(status) ? str(status.phase) : null;
        const blockedFrom = isRecord(status) ? str(status.blocked_from) : null;
        const block = isRecord(status) ? str(status.block) : null;
        const chatDir = join(this.bundle, "vault", "chat");
        const authors = existsSync(chatDir)
            ? readdirSync(chatDir)
                .filter((name) => name.endsWith(".md"))
                .map((name) => parseMessageId(name.slice(0, -3))?.agent ?? null)
            : [];
        const startLog = existsSync(join(this.bundle, "start.log")) ? readFileSync(join(this.bundle, "start.log"), "utf8") : "";
        const trail = existsSync(join(this.bundle, "runtime", "diag.log")) ? readFileSync(join(this.bundle, "runtime", "diag.log"), "utf8") : "";
        const configured = readJson(join(this.bundle, CONFIG_FILENAME));
        const agentIds = isRecord(configured) && isRecord(configured.agents) ? Object.keys(configured.agents) : [];
        const agents = {};
        for (const agent of agentIds) {
            const session = readJson(join(this.bundle, "runtime", "sessions", `${agent}.json`));
            agents[agent] = {
                ...supervisorEvents(startLog, agent),
                posted: authors.filter((author) => author === agent).length,
                session_id: isRecord(session) ? str(session.session_id) : null,
                session_source: isRecord(session) ? str(session.source) : null,
                trail: trailCounts(trail, agent),
            };
        }
        const chatMd = existsSync(join(this.bundle, "vault", "chat.md")) ? readFileSync(join(this.bundle, "vault", "chat.md"), "utf8") : "";
        const judged = verdictOf({ aborted: this.aborted !== null, phase, blockedFrom, chatMd, posted: agentIds.map((agent) => agents[agent].posted) });
        const prs = this.settings.repo === null ? null : readJson(join(this.bundle, "git", "prs.json"));
        return {
            version: VERSION,
            driver: this.settings.driver,
            mode: this.settings.repo === null ? "local" : "github",
            repo: this.settings.repo,
            verdict: judged.verdict,
            exit_code: judged.exitCode,
            levels: judged.levels,
            goal: this.goalId,
            phase,
            blocked_from: blockedFrom,
            block,
            aborted: this.aborted,
            duration_s: Math.round((Date.now() - this.started) / 1000),
            start_exit: this.startExit,
            watchdog: this.watchdog,
            interrupted: this.interrupted > 0,
            doctor: { gated: this.settings.driver === "real", fail: this.doctorFail },
            claude_spend_cap_usd: this.spendCap,
            agents,
            prs: Array.isArray(prs) ? prs.length : null,
            transcripts: this.transcriptCount,
            project: this.project,
            project_kept: !this.settings.clean && existsSync(this.project),
            bundle: this.bundle,
            notes: this.notes,
        };
    }
    /** `<bundle>.tar.gz` beside the bundle directory; null when tar failed. */
    tarball() {
        const target = `${this.bundle}.tar.gz`;
        const result = this.run("tar", ["-czf", target, "-C", dirname(this.bundle), basename(this.bundle)], dirname(this.bundle));
        if (result.code === 0)
            return target;
        this.say(`could not write ${target}: ${why(result)}; send the ${basename(this.bundle)} directory instead`);
        return null;
    }
}
export const TRANSCRIPT_NOTICE = "the bundle includes both CLIs' transcripts of this run, redacted (home paths, emails, and common token shapes); a transcript can quote your global CLAUDE.md or AGENTS.md. Pass --no-transcripts to leave them out.";
export async function runSmoke(options) {
    if (options.driver !== "real" && options.driver !== "fake")
        throw new CliError(`--driver must be real or fake, got "${options.driver}"`);
    const settings = {
        driver: options.driver,
        minutes: positiveInt("--minutes", options.minutes),
        maxUsd: positiveNumber("--max-usd", options.maxUsd),
        repo: options.github === undefined ? null : parseRepo(options.github),
        transcripts: options.transcripts,
        ping: options.ping,
        clean: options.clean === true,
    };
    const smoke = new SmokeRun(settings, resolve(options.out ?? process.cwd()));
    const onSignal = (signal) => smoke.onSignal(signal);
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals)
        process.on(signal, onSignal);
    onBrokenPipe(() => smoke.silence());
    try {
        smoke.say(`diarchy smoke ${VERSION} · driver ${settings.driver} · ${settings.repo === null ? "local (no PRs)" : `github ${settings.repo}`} · ${settings.minutes} min`);
        if (settings.driver === "real") {
            smoke.say(`this spends real quota: up to ${settings.minutes} min of both CLIs${settings.ping ? " plus one short turn each first" : ""}; Claude is capped at $${settings.maxUsd} per process when it lists --max-budget-usd, Codex comes out of your plan`);
        }
        if (settings.transcripts)
            smoke.say(TRANSCRIPT_NOTICE);
        try {
            const remote = settings.repo === null ? null : smoke.github(settings.repo);
            smoke.setup(remote);
            smoke.doctor();
            if (remote !== null)
                smoke.push();
            smoke.kickoff();
            await smoke.runGoal();
        }
        catch (error) {
            if (!(error instanceof Abort))
                throw error;
            // A Ctrl-C reaches the child a step was waiting on too, so its failure is the interrupt's.
            const reason = smoke.interrupted > 0 && !error.message.startsWith("interrupted") ? `interrupted by a signal (${error.message})` : error.message;
            smoke.aborted = { step: error.step, reason };
            smoke.say(`aborted at ${error.step}: ${reason}`);
        }
        smoke.collect();
        smoke.redactBundle();
        const summary = smoke.summary();
        const text = redact(formatSummary(summary));
        writeFileSync(join(smoke.bundle, "summary.json"), `${redact(JSON.stringify(summary, null, 2))}\n`);
        writeFileSync(join(smoke.bundle, "summary.txt"), `${text}\n`);
        const tarball = smoke.tarball();
        if (!summary.project_kept)
            rmSync(smoke.root, { recursive: true, force: true });
        smoke.say(`send back ${tarball ?? smoke.bundle}`);
        try {
            process.stdout.write(`\n${formatSummary(summary)}\n${tarball === null ? "" : `tarball  ${tarball}\n`}`);
        }
        catch {
            // the terminal is gone; the bundle has it all
        }
        return summary.exit_code;
    }
    finally {
        for (const signal of signals)
            process.off(signal, onSignal);
    }
}
//# sourceMappingURL=smoke.js.map