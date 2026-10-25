/**
 * `diarchy start` supervision and portability: the run record in
 * `.diarchy/start.pid`, PMs left behind by a supervisor that died, a hangup,
 * children that cannot be spawned, revival of a PM left dead, the Codex git
 * check, and the supported-platform statement. The CLI runs from source as in e2e.test.ts,
 * with small stand-in PM scripts instead of model calls.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { fakePlan, loadSession, realPlan, saveSession, SKIP_GIT_REPO_CHECK } from "../src/cli/drivers.js";
import { DEFAULT_AGENT_LAUNCH } from "../src/cli/launcher-config.js";
import { platformProblem } from "../src/cli/preflight.js";
import { claimRunRecord, identify, pidPath, psStartTime, readRunRecord, reapLeftovers, runningSupervisor } from "../src/cli/run-record.js";
import { VaultStore, loadConfig } from "../src/vault/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Background {
  proc: ChildProcess;
  out: () => string;
  done: Promise<Run>;
}

const temps: string[] = [];
const spawned: ChildProcess[] = [];
const strays: number[] = [];

afterEach(() => {
  for (const proc of spawned.splice(0)) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function launch(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Background {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.DIARCHY_PROJECT;
  delete env.DIARCHY_FAKE_MODE;
  const proc = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  spawned.push(proc);
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Run>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code, signal) => resolve({ code: code ?? (signal === null ? -1 : 128), stdout, stderr }));
  });
  return { proc, out: () => stdout + stderr, done };
}

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  return launch(args, extraEnv).done;
}

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "diarchy-sup-"));
  temps.push(root);
  return root;
}

interface Config {
  agents: Record<string, { command: string; args?: string[] }>;
  launcher: Record<string, number>;
  [key: string]: unknown;
}

/** `diarchy init` in a fresh non-git directory, with fast supervisor knobs. */
async function initProject(name: string, edit: (config: Config) => void = () => undefined): Promise<string> {
  const dir = join(tempDir(), name);
  mkdirSync(dir);
  const init = await cli(["init", "--project", dir]);
  expect(init.code, init.stderr).toBe(0);
  const path = join(dir, "diarchy.config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  config.launcher = { ...config.launcher, poll_ms: 100, restart_backoff_ms: 200, stop_grace_ms: 1000 };
  edit(config);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

/** Running (a zombie waiting for a reaper that never comes counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
  } catch {
    return true;
  }
}

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** A stand-in PM: records its pid in $STANDIN_DIR/<agent>.pid, then idles silently like a `claude -p` turn. */
function sleeperScript(): string {
  const path = join(tempDir(), "sleeper.mjs");
  writeFileSync(
    path,
    [
      'import { appendFileSync } from "node:fs";',
      "appendFileSync(`${process.env.STANDIN_DIR}/${process.env.DIARCHY_AGENT}.pid`, `${process.pid}\\n`);",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
  );
  return path;
}

function pids(dir: string, agent: string): number[] {
  const path = join(dir, `${agent}.pid`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(Number);
}

// ---------------------------------------------------------------------------
// The run record (F026)
// ---------------------------------------------------------------------------

describe("start.pid identity", () => {
  it("trusts a recorded pid only while the same process holds it", () => {
    const dir = tempDir();
    const sleeper = spawn("sleep", ["30"]);
    spawned.push(sleeper);
    const pid = sleeper.pid as number;
    mkdirSync(join(dir, ".diarchy"));

    writeFileSync(pidPath(dir), `${pid}\n`);
    expect(readRunRecord(dir)).toMatchObject({ pid, started: null });
    expect(runningSupervisor(dir)).toBeNull();

    writeFileSync(pidPath(dir), JSON.stringify({ pid, started: "not when it started", children: {} }));
    expect(runningSupervisor(dir)).toBeNull();

    writeFileSync(pidPath(dir), JSON.stringify({ ...identify(pid), children: {} }));
    expect(runningSupervisor(dir)).toBe(pid);
    expect(() => claimRunRecord(dir)).toThrow(/another diarchy start claimed/);
  });

  it("stop neither signals nor trusts a stale pid the kernel gave to another process, and drops the file", async () => {
    const dir = await initProject("recycled");
    expect((await cli(["kickoff", "Recycle a pid", "--ac", "Nothing is killed.", "--project", dir])).code).toBe(0);
    const sleeper = spawn("sleep", ["30"]);
    spawned.push(sleeper);
    const pid = sleeper.pid as number;
    mkdirSync(join(dir, ".diarchy"), { recursive: true });
    writeFileSync(pidPath(dir), `${pid}\n`);

    const stop = await cli(["stop", "--project", dir]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stdout).toContain("no diarchy start is running");
    expect(stop.stdout).not.toContain(`pid ${pid}`);
    await new Promise((done) => setTimeout(done, 300));
    expect(sleeper.exitCode).toBeNull();
    expect(sleeper.signalCode).toBeNull();
    expect(existsSync(pidPath(dir))).toBe(false);
  });

  it("ps reads the start time in the C locale and UTC, whatever the caller's TZ and locale", () => {
    const bin = tempDir();
    writeFileSync(join(bin, "ps"), '#!/bin/sh\nprintf \'%s %s\\n\' "$LC_ALL" "$TZ"\n');
    chmodSync(join(bin, "ps"), 0o755);
    const saved = { PATH: process.env.PATH, TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
    process.env.TZ = "Asia/Kolkata";
    process.env.LC_ALL = "de_DE.UTF-8";
    try {
      expect(psStartTime(process.pid)).toBe("C UTC");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reapLeftovers leaves a live supervisor's record alone", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".diarchy"));
    writeFileSync(pidPath(dir), JSON.stringify({ ...identify(process.pid), children: { claude: identify(process.pid) } }));
    expect(await reapLeftovers(dir)).toEqual([]);
    expect(existsSync(pidPath(dir))).toBe(true);
  });
});

describe("claimRunRecord on a filesystem without hard links", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it.each(["EPERM", "ENOTSUP"])("falls back to an exclusive create when link fails with %s", async (code) => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      const linkSync = (): never => {
        throw Object.assign(new Error(`${code}: link not supported`), { code });
      };
      return { ...fs, default: { ...fs, linkSync }, linkSync };
    });
    const records = await import("../src/cli/run-record.js");
    const dir = tempDir();
    const record = records.claimRunRecord(dir);
    expect(record.pid).toBe(process.pid);
    expect(records.readRunRecord(dir)).toEqual(record);
    expect(() => records.claimRunRecord(dir)).toThrow(/another diarchy start claimed/);
    expect(readdirSync(join(dir, ".diarchy"))).toEqual(["start.pid"]);
  });
});

// ---------------------------------------------------------------------------
// PMs left behind by a supervisor that died (F028)
// ---------------------------------------------------------------------------

describe("PMs left behind by a killed supervisor", () => {
  async function killedRun(name: string): Promise<{ dir: string; standin: string; script: string; orphans: number[] }> {
    const dir = await initProject(name);
    const standin = tempDir();
    const script = sleeperScript();
    const first = launch(["start", "Outlive the supervisor", "--ac", "Nothing is orphaned.", "--lead", "claude", "--driver", "fake", "--fake-script", script, "--no-worktrees", "--project", dir], { STANDIN_DIR: standin });
    await until("both PMs recorded", () => Object.keys(readRunRecord(dir)?.children ?? {}).length === 2 && pids(standin, "claude").length === 1 && pids(standin, "codex").length === 1);
    const orphans = [...pids(standin, "claude"), ...pids(standin, "codex")];
    strays.push(...orphans);
    first.proc.kill("SIGKILL");
    await first.done;
    expect(orphans.every(alive)).toBe(true);
    return { dir, standin, script, orphans };
  }

  it("diarchy stop stops them and drops the stale start.pid", async () => {
    const { dir, orphans } = await killedRun("orphans-stop");
    const stop = await cli(["stop", "--project", dir]);
    expect(stop.code, stop.stderr).toBe(0);
    expect(stop.stdout).toContain("no diarchy start is running");
    expect(stop.stdout).toContain(`stopped claude (pid ${orphans[0]})`);
    expect(stop.stdout).toContain(`stopped codex (pid ${orphans[1]})`);
    await until("orphans gone", () => !orphans.some(alive), 3_000);
    expect(existsSync(pidPath(dir))).toBe(false);
  }, 30_000);

  it("the next diarchy start stops them before spawning its own, so one process acts as each agent", async () => {
    const { dir, standin, script, orphans } = await killedRun("orphans-start");
    const second = launch(["start", "--driver", "fake", "--fake-script", script, "--no-worktrees", "--project", dir], { STANDIN_DIR: standin });
    await until("the new PMs", () => pids(standin, "claude").length === 2 && pids(standin, "codex").length === 2);
    strays.push(...pids(standin, "claude"), ...pids(standin, "codex"));
    expect(second.out()).toContain(`stopped claude (pid ${orphans[0]}), left running by an earlier diarchy start`);
    await until("orphans gone", () => !orphans.some(alive), 3_000);
    const fresh = [pids(standin, "claude")[1], pids(standin, "codex")[1]];
    expect(fresh.every(alive)).toBe(true);
    expect(readRunRecord(dir)).toMatchObject({ pid: second.proc.pid, children: { claude: { pid: fresh[0] }, codex: { pid: fresh[1] } } });

    const stop = await cli(["stop", "--project", dir]);
    expect(stop.stdout).toContain(`signalled diarchy start (pid ${second.proc.pid})`);
    expect((await second.done).code).toBe(2);
    expect(fresh.some(alive)).toBe(false);
    expect(existsSync(pidPath(dir))).toBe(false);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// A hangup (closed terminal, nohup included: Node resets SIGHUP's SIG_IGN)
// ---------------------------------------------------------------------------

describe("a hangup", () => {
  it("SIGHUP to the supervisor alone stops both PMs and removes start.pid", async () => {
    const dir = await initProject("hangup");
    const standin = tempDir();
    const script = sleeperScript();
    const run = launch(["start", "Survive no hangup", "--ac", "Nothing is orphaned.", "--lead", "claude", "--driver", "fake", "--fake-script", script, "--no-worktrees", "--project", dir], { STANDIN_DIR: standin });
    await until("both PMs recorded", () => Object.keys(readRunRecord(dir)?.children ?? {}).length === 2 && pids(standin, "claude").length === 1 && pids(standin, "codex").length === 1);
    const children = [...pids(standin, "claude"), ...pids(standin, "codex")];
    strays.push(...children);

    run.proc.kill("SIGHUP");
    const result = await run.done;
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("received SIGHUP: stopping claude, codex");
    expect(children.some(alive)).toBe(false);
    expect(existsSync(pidPath(dir))).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Agent commands that cannot be spawned (F029)
// ---------------------------------------------------------------------------

describe("start --driver real with an agent command that cannot run", () => {
  it("fails before kickoff when a command is not on PATH", async () => {
    const dir = await initProject("missing-cli", (config) => {
      config.agents.claude.command = "nope-claude-xyz";
      config.agents.codex.command = "nope-codex-xyz";
    });
    const run = await cli(["start", "Never kicked off", "--ac", "Nothing runs.", "--driver", "real", "--no-worktrees", "--project", dir]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('agents.claude.command "nope-claude-xyz" is not an executable file on PATH');
    expect(run.stderr).toContain('agents.codex.command "nope-codex-xyz"');
    expect(new VaultStore({ projectDir: dir, config: loadConfig(dir), agent: "human" }).listGoals()).toHaveLength(0);
  });

  it("counts a spawn that fails at exec as an exit, so the run ends instead of idling to the wall clock", async () => {
    const bin = tempDir();
    const broken = join(bin, "broken-pm");
    writeFileSync(broken, "#!/nonexistent/interpreter\n");
    chmodSync(broken, 0o755);
    const dir = await initProject("exec-fails", (config) => {
      config.agents.claude = { command: broken, args: [] };
      config.agents.codex = { command: broken, args: [] };
    });
    const run = await cli(["start", "Spawn nothing", "--ac", "The run ends.", "--driver", "real", "--no-worktrees", "--project", dir]);
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain("[claude] spawn error");
    expect(run.stdout).toContain("claude exited (never started)");
    expect(run.stdout).toContain("codex will not be restarted (3 restarts used)");
    expect(run.stdout).toContain("every agent exited while the goal is still PLAN");
    expect(existsSync(pidPath(dir))).toBe(false);
  }, 30_000);

  it("keeps the saved session when a resumed spawn fails before the CLI runs", async () => {
    const bin = tempDir();
    // Named claude so the plan resumes the saved session with --resume.
    const broken = join(bin, "claude");
    writeFileSync(broken, "#!/nonexistent/interpreter\n");
    chmodSync(broken, 0o755);
    const dir = await initProject("resume-never-ran", (config) => {
      config.agents.claude = { command: broken, args: [] };
      config.agents.codex = { command: broken, args: [] };
      config.launcher.max_restarts = 0;
    });
    expect((await cli(["kickoff", "Keep the session", "--ac", "The session survives.", "--project", dir])).code).toBe(0);
    const goalId = new VaultStore({ projectDir: dir, config: loadConfig(dir), agent: "human" }).activeGoal()?.goalId ?? "";
    const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    saveSession(dir, { agent: "claude", goal: goalId, session_id: sessionId, source: "captured", updated: "" });

    const run = await cli(["start", "--driver", "real", "--no-worktrees", "--project", dir]);
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain("claude started (resumed session)");
    expect(run.stdout).toContain("claude exited (never started)");
    expect(run.stdout).not.toContain("resume failed fast");
    expect(loadSession(dir, "claude", goalId)?.session_id).toBe(sessionId);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A PM left dead comes back when a message lands (F030)
// ---------------------------------------------------------------------------

describe("a PM out of restarts", () => {
  it("is respawned with a fresh count when the next message lands", async () => {
    const dir = await initProject("revive");
    const standin = tempDir();
    const script = join(tempDir(), "turn-ender.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(`${process.env.STANDIN_DIR}/${process.env.DIARCHY_AGENT}.pid`, `${process.pid}\\n`);",
        // codex ends its turn at once, as a headless CLI does when the Stop gate lets it; claude works silently.
        'if (process.env.DIARCHY_AGENT === "codex") process.exit(0);',
        "setInterval(() => undefined, 1000);",
        "",
      ].join("\n"),
    );
    const run = launch(["start", "Revive the idle PM", "--ac", "Both PMs stay reachable.", "--lead", "claude", "--driver", "fake", "--fake-script", script, "--no-worktrees", "--project", dir], { STANDIN_DIR: standin });
    await until("codex out of restarts", () => run.out().includes("codex will not be restarted (3 restarts used)"));
    strays.push(...pids(standin, "claude"));
    expect(pids(standin, "codex")).toHaveLength(4);

    const claude = new VaultStore({ projectDir: dir, config: loadConfig(dir), agent: "claude", pollIntervalMs: 20 });
    const propose = await claude.post({
      type: "PROPOSE",
      to: "all",
      re: ["AC1"],
      decision_id: "plan",
      claim: "Respawning the dead PM on a new message keeps both PMs reachable.",
      body: "Two tasks: respawn and test.",
    });
    expect(propose.ok).toBe(true);
    await until("codex respawned", () => pids(standin, "codex").length > 4);
    expect(run.out()).toContain("codex respawning: a message landed");

    await cli(["stop", "--project", dir]);
    expect((await run.done).code).toBe(2);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// codex exec outside a git repository (F073)
// ---------------------------------------------------------------------------

describe("codex outside a git repository", () => {
  it("realPlan adds --skip-git-repo-check for codex only when the cwd is not in a git repository", () => {
    const base = { projectDir: "/p", agent: "codex", goalId: "g", cwd: "/p", worktree: null, session: null };
    const codex = DEFAULT_AGENT_LAUNCH.codex;
    expect(realPlan({ ...base, launch: codex, inGitRepo: true }).args).not.toContain(SKIP_GIT_REPO_CHECK);
    expect(realPlan({ ...base, launch: codex }).args).not.toContain(SKIP_GIT_REPO_CHECK);
    const fresh = realPlan({ ...base, launch: codex, inGitRepo: false }).args;
    expect(fresh.slice(0, -1)).toEqual([...codex.args, SKIP_GIT_REPO_CHECK]);
    const session = { agent: "codex", goal: "g", session_id: "abc12345", source: "captured" as const, updated: "" };
    const resumed = realPlan({ ...base, launch: codex, inGitRepo: false, session }).args;
    expect(resumed.indexOf(SKIP_GIT_REPO_CHECK)).toBeLessThan(resumed.indexOf("resume"));
    expect(realPlan({ ...base, agent: "claude", launch: DEFAULT_AGENT_LAUNCH.claude, inGitRepo: false }).args).not.toContain(SKIP_GIT_REPO_CHECK);
  });

  it("diarchy start passes it to the codex it spawns in a project with no git repository", async () => {
    const bin = tempDir();
    const standin = tempDir();
    for (const name of ["claude", "codex"]) {
      const path = join(bin, name);
      writeFileSync(path, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STANDIN_DIR/$DIARCHY_AGENT.args"\nexit 1\n');
      chmodSync(path, 0o755);
    }
    const dir = await initProject("no-git", (config) => {
      config.agents.claude.command = join(bin, "claude");
      config.agents.codex.command = join(bin, "codex");
      config.launcher.max_restarts = 0;
    });
    const run = await cli(["start", "Run codex without git", "--ac", "Codex starts.", "--driver", "real", "--project", dir], { STANDIN_DIR: standin });
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain("is not a git repository");
    const codexArgs = readFileSync(join(standin, "codex.args"), "utf8").split("\n");
    expect(codexArgs).toContain(SKIP_GIT_REPO_CHECK);
    expect(readFileSync(join(standin, "claude.args"), "utf8").split("\n")).not.toContain(SKIP_GIT_REPO_CHECK);
  });
});

// ---------------------------------------------------------------------------
// Supported platforms (F074)
// ---------------------------------------------------------------------------

describe("supported platforms", () => {
  it("diarchy start --driver real refuses native Windows with a pointer to WSL", () => {
    expect(platformProblem("linux", "real")).toBeNull();
    expect(platformProblem("darwin", "real")).toBeNull();
    expect(platformProblem("win32", "fake")).toBeNull();
    const problem = platformProblem("win32", "real") ?? "";
    expect(problem).toContain("Linux and macOS");
    expect(problem).toContain("WSL");
  });

  it("README, QUICKSTART, and both install guides state Linux or macOS and that native Windows is untested", () => {
    for (const doc of ["README.md", "docs/QUICKSTART.md", "docs/INSTALL-CLAUDE.md", "docs/INSTALL-CODEX.md"]) {
      const text = readFileSync(join(ROOT, doc), "utf8").replace(/\s+/g, " ");
      expect(text, doc).toContain("Linux or macOS");
      expect(text, doc).toMatch(/native Windows is untested and `diarchy start --driver real` refuses to run there/i);
      expect(text, doc).toContain("WSL");
    }
  });

  it("the fake driver passes the tsx loader to --import as a file URL", () => {
    const plan = fakePlan({ projectDir: "/p", agent: "claude", goalId: "g", cwd: "/p", worktree: null, script: "/x/fake-pm.ts", mode: "good" });
    expect(plan.args[0]).toBe("--import");
    expect(plan.args[1]).toMatch(/^file:\/\/\/.*loader\.mjs$/);
  });
});
