/**
 * `diarchy smoke` end to end with `--driver fake` (no model calls), run from
 * source as a subprocess with a PATH that holds node, git, and tar but no
 * claude or codex, plus a stub `gh` and a local bare repository for --github.
 * The helpers (redaction, transcript discovery, the verdict) are tested
 * directly.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runInit } from "../src/cli/init.js";
import { findTranscripts, redact, supervisorEvents, verdictOf, type SmokeSummary } from "../src/cli/smoke.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const RUN_TIMEOUT = 240_000;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let world = "";
let bin = "";
let path = "";
const temps: string[] = [];

beforeAll(() => {
  world = realpathSync(mkdtempSync(join(tmpdir(), "diarchy-smoke-test-")));
  temps.push(world);
  bin = join(world, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  // gh answers from $GH_STUB: { "repo": { ...gh repo view --json output } }.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      '  "auth status") echo "Logged in to github.com"; exit 0 ;;',
      `  "repo view") exec "${process.execPath}" -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.GH_STUB, "utf8")).repo))' ;;`,
      '  "pr list") echo "[]"; exit 0 ;;',
      "esac",
      'case "$1" in --version) echo "gh version 2.0.0 (stub)"; exit 0 ;; esac',
      'echo "unknown gh command: $*" >&2; exit 1',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // No claude, no codex: node from the symlink, git and tar from the system.
  path = [bin, "/usr/bin", "/bin"].join(":");
});

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `diarchy smoke <args>` from source with no DIARCHY_* variable but those in `env`. */
function smoke(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const full: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DIARCHY_")));
    Object.assign(full, { PATH: path }, env);
    const child = spawn(process.execPath, ["--import", TSX, CLI, "smoke", ...args], { cwd: world, env: full, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function outDir(name: string): string {
  const dir = join(world, name);
  mkdirSync(dir);
  return dir;
}

/** The one bundle directory `diarchy smoke` wrote into `out`. */
function bundleIn(out: string): string {
  const dirs = readdirSync(out).filter((name) => /^diarchy-smoke-\d{8}T\d{6}Z$/.test(name));
  expect(dirs).toHaveLength(1);
  return join(out, dirs[0]);
}

const read = (...parts: string[]): string => readFileSync(join(...parts), "utf8");
const json = <T>(...parts: string[]): T => JSON.parse(read(...parts)) as T;
const summaryOf = (bundle: string): SmokeSummary => json<SmokeSummary>(bundle, "summary.json");

function cleanUp(summary: SmokeSummary): void {
  // The temp project is kept by default; drop it here.
  const root = join(summary.project, "..");
  if (root.includes("diarchy-smoke-")) rmSync(root, { recursive: true, force: true });
}

describe("diarchy smoke --driver fake", () => {
  it(
    "runs the goal to DONE in a throwaway repo and bundles the evidence, whatever DIARCHY_* the caller set",
    async () => {
      // Another project the caller's environment points at: the run must never touch it.
      const other = join(world, "other");
      mkdirSync(other);
      runInit(other, {}, () => undefined);
      const out = outDir("out-done");
      const run = await smoke(["--driver", "fake", "--no-ping", "--no-transcripts", "--out", out], { DIARCHY_PROJECT: other, DIARCHY_FAKE_MODE: "slop" });
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

      const bundle = bundleIn(out);
      expect(existsSync(`${bundle}.tar.gz`)).toBe(true);
      const summary = summaryOf(bundle);
      cleanUp(summary);
      expect(summary).toMatchObject({ verdict: "DONE", exit_code: 0, phase: "DONE", mode: "local", levels: { L1: true, L2: true, L3: true }, transcripts: null });
      for (const agent of ["claude", "codex"]) expect(summary.agents[agent].posted).toBeGreaterThanOrEqual(1);
      expect(summary.goal).toMatch(/^\d{8}-smoke$/);
      expect(json<{ goal_id: string }>(bundle, "kickoff.json").goal_id).toBe(summary.goal);
      expect(read(bundle, "start.log")).toContain("attached to 20");
      expect(read(bundle, "vault", "chat.md")).toContain("## → DONE");
      expect(read(bundle, "summary.txt")).toContain("verdict  DONE (exit 0)");
      for (const file of ["doctor.json", "init.log", "watch.log", "status.json", "versions.txt", "git/log.txt", "git/worktrees.txt", "git/claude.diff-stat.txt"]) {
        expect(existsSync(join(bundle, file)), file).toBe(true);
      }
      expect(existsSync(join(bundle, "transcripts"))).toBe(false);
      const config = json<{ review: { required: boolean }; launcher: Record<string, number> }>(bundle, "diarchy.config.json");
      expect(config.review.required).toBe(false);
      expect(config.launcher).toMatchObject({ max_restarts: 1, wall_clock_grace_ms: 60_000 });
      // The fake PM needs neither CLI, so the doctor's fails are reported without stopping the run.
      expect(summary.doctor.gated).toBe(false);

      expect(existsSync(join(other, "other brain", "diarchy", "goals"))).toBe(false);
      expect(existsSync(join(other, ".diarchy"))).toBe(false);
    },
    RUN_TIMEOUT,
  );

  it(
    "--github pushes main to the empty repository, turns review on, and lists its PRs",
    async () => {
      const remote = join(world, "remote.git");
      expect(spawnSync("git", ["init", "-q", "--bare", remote]).status).toBe(0);
      const stub = join(world, "gh-empty.json");
      writeFileSync(stub, JSON.stringify({ repo: { isEmpty: true, url: remote, viewerPermission: "ADMIN" } }));
      const out = outDir("out-github");
      const run = await smoke(["--driver", "fake", "--no-ping", "--no-transcripts", "--github", "someone/throwaway", "--out", out], { GH_STUB: stub });
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

      const bundle = bundleIn(out);
      const summary = summaryOf(bundle);
      cleanUp(summary);
      expect(summary).toMatchObject({ verdict: "DONE", mode: "github", repo: "someone/throwaway", prs: 0 });
      expect(json<{ review: { required: boolean } }>(bundle, "diarchy.config.json").review.required).toBe(true);
      expect(read(bundle, "git", "prs.json").trim()).toBe("[]");
      expect(spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", "refs/heads/main"]).status).toBe(0);
    },
    RUN_TIMEOUT,
  );

  it(
    "--github stops before making anything when the repository is not empty",
    async () => {
      const stub = join(world, "gh-full.json");
      writeFileSync(stub, JSON.stringify({ repo: { isEmpty: false, url: "https://github.com/someone/used", viewerPermission: "ADMIN" } }));
      const out = outDir("out-github-used");
      const run = await smoke(["--driver", "fake", "--no-transcripts", "--github", "someone/used", "--out", out], { GH_STUB: stub });
      expect(run.code).toBe(1);
      const bundle = bundleIn(out);
      const summary = summaryOf(bundle);
      expect(summary).toMatchObject({ verdict: "aborted", aborted: { step: "github" }, goal: null });
      expect(summary.aborted?.reason).toContain("not empty");
      expect(existsSync(join(bundle, "init.log"))).toBe(false);
      expect(existsSync(summary.project)).toBe(false);
      rmSync(join(summary.project, ".."), { recursive: true, force: true });
    },
    RUN_TIMEOUT,
  );

  it(
    "a watchdog stops a start that never finishes, and the bundle is still written",
    async () => {
      const sleeper = join(world, "sleeper.mjs");
      writeFileSync(sleeper, "setInterval(() => undefined, 1000);\n");
      const out = outDir("out-watchdog");
      const run = await smoke(["--driver", "fake", "--no-transcripts", "--out", out], { DIARCHY_SMOKE_WATCHDOG_MS: "3000", DIARCHY_SMOKE_FAKE_SCRIPT: sleeper });
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
      const bundle = bundleIn(out);
      expect(existsSync(`${bundle}.tar.gz`)).toBe(true);
      const summary = summaryOf(bundle);
      cleanUp(summary);
      expect(summary).toMatchObject({ verdict: "stalled", exit_code: 1, watchdog: { after_s: 3, fired: true }, levels: { L1: false, L3: false } });
      expect(read(bundle, "start.log")).toContain("received SIGTERM");
      expect(summary.start_exit).toBe("code 1");
    },
    RUN_TIMEOUT,
  );
});

describe("diarchy smoke --driver real", () => {
  it(
    "stops after a failing doctor, before a goal exists",
    async () => {
      const out = outDir("out-doctor");
      const run = await smoke(["--no-ping", "--no-transcripts", "--out", out]);
      expect(run.code).toBe(1);
      const bundle = bundleIn(out);
      const summary = summaryOf(bundle);
      cleanUp(summary);
      expect(summary).toMatchObject({ verdict: "aborted", aborted: { step: "doctor" }, goal: null, doctor: { gated: true } });
      expect(summary.doctor.fail).toEqual(expect.arrayContaining(["C1", "X1"]));
      expect(json<{ checks: unknown[] }>(bundle, "doctor.json").checks.length).toBeGreaterThan(0);
      expect(existsSync(join(bundle, "kickoff.json"))).toBe(false);
      expect(json<{ goal: string | null }>(bundle, "status.json").goal).toBeNull();
    },
    RUN_TIMEOUT,
  );
});

describe("smoke helpers", () => {
  it("redacts tokens, emails, and the home directory", () => {
    const text = [
      'key sk-ant-xxxx and "sk-proj-AbC123_def"',
      "ghp_0123456789abcdefABCDEF and github_pat_11ABCDEFG_0123456789",
      "xoxb-1234-5678-abcd AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer eyJhbGciOi.payload.sig",
      "by Ada <ada@example.com> in /home/ada/work, not /home/adam",
      "a disk-usage report and task-1234",
    ].join("\n");
    const clean = redact(text, "/home/ada");
    expect(clean).toContain("key sk-…REDACTED and \"sk-…REDACTED\"");
    expect(clean).toContain("ghp_…REDACTED and github_pat_…REDACTED");
    expect(clean).toContain("xoxb-…REDACTED AKIA…REDACTED");
    expect(clean).toContain("Bearer …REDACTED");
    expect(clean).toContain("by Ada <[email]> in ~/work, not /home/adam");
    expect(clean).toContain("a disk-usage report and task-1234");
    expect(redact("sk-ant-xxxx")).toBe("sk-…REDACTED");
  });

  it("finds this run's transcripts by session id and by cwd, and nothing else", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "diarchy-smoke-transcripts-")));
    temps.push(dir);
    const worktree = join(dir, "smoke-app", ".diarchy", "worktrees", "claude");
    const codexWorktree = join(dir, "smoke-app", ".diarchy", "worktrees", "codex");
    const projects = join(dir, "claude-projects");
    const byCwd = join(projects, worktree.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(byCwd, { recursive: true });
    writeFileSync(join(byCwd, "minted.jsonl"), "{}\n");
    mkdirSync(join(projects, "-elsewhere"), { recursive: true });
    writeFileSync(join(projects, "-elsewhere", "resumed.jsonl"), "{}\n");
    writeFileSync(join(projects, "-elsewhere", "unrelated.jsonl"), "{}\n");

    const day = join(dir, "codex-home", "sessions", "2026", "10", "26");
    mkdirSync(day, { recursive: true });
    const meta = (cwd: string): string => `${JSON.stringify({ type: "session_meta", payload: { id: "x", cwd } })}\n{}\n`;
    writeFileSync(join(day, "rollout-2026-10-26T10-00-00-thread-1.jsonl"), meta("/somewhere/else"));
    writeFileSync(join(day, "rollout-2026-10-26T10-01-00-by-cwd.jsonl"), meta(codexWorktree));
    writeFileSync(join(day, "rollout-2026-10-26T10-02-00-other.jsonl"), meta("/somewhere/else"));
    writeFileSync(join(day, "rollout-2026-10-26T09-00-00-old.jsonl"), meta(codexWorktree));
    const since = Date.now() - 60_000;
    const old = new Date(since - 3_600_000);
    for (const name of ["rollout-2026-10-26T10-00-00-thread-1.jsonl", "rollout-2026-10-26T09-00-00-old.jsonl"]) utimesSync(join(day, name), old, old);

    const copies = findTranscripts({
      claudeProjects: projects,
      codexHome: join(dir, "codex-home"),
      claudeSessions: ["resumed"],
      codexSessions: ["thread-1"],
      cwds: [join(dir, "smoke-app"), worktree, codexWorktree],
      since,
    });
    expect(copies.map((copy) => copy.to).sort()).toEqual(
      [
        join("claude", "-elsewhere", "resumed.jsonl"),
        join("claude", worktree.replace(/[^A-Za-z0-9]/g, "-")),
        join("codex", "rollout-2026-10-26T10-00-00-thread-1.jsonl"),
        join("codex", "rollout-2026-10-26T10-01-00-by-cwd.jsonl"),
      ].sort(),
    );
  });

  it("grades the run: DONE 0, BLOCKED after both PMs posted 2, anything else 1", () => {
    const base = { aborted: false, phase: "EXECUTE", blockedFrom: null, chatMd: "## → EXECUTE", posted: [3, 2] };
    expect(verdictOf({ ...base, phase: "DONE" })).toMatchObject({ verdict: "DONE", exitCode: 0, levels: { L1: true, L2: true, L3: true } });
    expect(verdictOf({ ...base, phase: "BLOCKED", blockedFrom: "EXECUTE" })).toMatchObject({ verdict: "BLOCKED", exitCode: 2, levels: { L1: true, L2: true, L3: false } });
    expect(verdictOf({ ...base, phase: "BLOCKED", blockedFrom: "PLAN", chatMd: "", posted: [1, 0] })).toMatchObject({ verdict: "BLOCKED", exitCode: 1, levels: { L1: false, L2: false } });
    expect(verdictOf(base)).toMatchObject({ verdict: "stalled", exitCode: 1, levels: { L1: true, L2: true } });
    expect(verdictOf({ ...base, aborted: true, phase: null })).toMatchObject({ verdict: "aborted", exitCode: 1 });

    const log = [
      "[   2s] 23:20:58 claude started: claude 9 args, cwd /x",
      "[   2s] [claude] 23:20:59 codex started: quoted PM output is not the supervisor",
      "[  40s] 23:21:40 codex started: codex 4 args, cwd /y",
      "[  90s] 23:22:30 codex exited (code 1)",
      "[  90s] 23:22:30 codex restarting in 3 s (restart 1 of 1)",
      "[  93s] 23:22:33 codex started (resumed session): codex 6 args, cwd /y",
    ].join("\n");
    expect(supervisorEvents(log, "codex")).toEqual({ spawned: 2, exits: ["code 1"], restarts: 1 });
    expect(supervisorEvents(log, "claude")).toEqual({ spawned: 1, exits: [], restarts: 0 });
  });
});
