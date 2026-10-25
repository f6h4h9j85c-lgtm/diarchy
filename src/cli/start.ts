/**
 * `diarchy start`: kick off (or attach), create worktrees, spawn one PM per
 * agent, and supervise them until the goal is DONE or BLOCKED.
 *
 * Exit codes: 0 DONE, 2 BLOCKED, 1 error (every agent dead, bad input, signal).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { AGENT_HUMAN, type DiarchyConfig, type GoalState, type Phase } from "../protocol/index.js";
import { VaultStore, loadConfig, type GoalRef } from "../vault/index.js";
import { blockReason, blockSummary, replyHint } from "./brief.js";
import { CliError, EXIT_BLOCKED, EXIT_ERROR, EXIT_OK, nowHms, onBrokenPipe, sleep } from "./common.js";
import {
  clearSession,
  defaultFakeScript,
  detectSessionId,
  fakePlan,
  loadSession,
  realPlan,
  saveSession,
  sandboxNotice,
  type DriverName,
  type SpawnPlan,
} from "./drivers.js";
import { kickoffInput, type KickoffCliOptions } from "./kickoff.js";
import { loadLauncherConfig, type LauncherConfig } from "./launcher-config.js";
import { ensureWorktrees, hasCommits, isGitRepo, missingFromWorktrees } from "./worktrees.js";

export interface StartOptions extends KickoffCliOptions {
  driver: string;
  fakeScript?: string;
  fakeMode?: string;
  /** commander: `--no-worktrees` sets this to false. */
  worktrees: boolean;
}

/** A resumed child that dies this fast is treated as a failed resume, not a crash. */
const FAST_FAIL_MS = 5_000;

export function pidPath(projectDir: string): string {
  return join(projectDir, ".diarchy", "start.pid");
}

/** The pid in `.diarchy/start.pid` when that process is still alive. */
export function runningSupervisor(projectDir: string): number | null {
  const path = pidPath(projectDir);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The kickoff inputs given on the command line; they only mean something when no goal is active. */
function newGoalArgs(goalText: string | undefined, options: KickoffCliOptions): string[] {
  const given: string[] = [];
  if (goalText !== undefined) given.push("the goal text");
  if (options.ac.length > 0) given.push("--ac");
  if (options.lead !== undefined) given.push("--lead");
  if (options.budget.length > 0) given.push("--budget");
  if (options.slug !== undefined) given.push("--slug");
  return given;
}

function parseDriver(value: string): DriverName {
  if (value === "real" || value === "fake") return value;
  throw new CliError(`--driver must be real or fake, got "${value}"`);
}

/** The fake PM's mode: --fake-mode, else DIARCHY_FAKE_MODE, else good. Checked before kickoff, since the fake PM rejects anything else at startup. */
function fakeMode(options: StartOptions): string {
  const mode = options.fakeMode ?? process.env.DIARCHY_FAKE_MODE ?? "good";
  if (mode === "good" || mode === "slop") return mode;
  throw new CliError(`--fake-mode (or DIARCHY_FAKE_MODE) must be good or slop, got "${mode}"`);
}

export async function runStart(projectDir: string, goalText: string | undefined, options: StartOptions): Promise<number> {
  const driver = parseDriver(options.driver);
  if (driver === "fake") fakeMode(options);
  const config = loadConfig(projectDir);
  const agents = Object.keys(config.agents);
  const launcher = loadLauncherConfig(projectDir, agents);
  const other = runningSupervisor(projectDir);
  if (other !== null) throw new CliError(`another diarchy start is running (pid ${other}); run diarchy stop first`);

  const human = new VaultStore({ projectDir, config, agent: AGENT_HUMAN, pollIntervalMs: Math.min(500, launcher.launcher.poll_ms) });
  let goal = human.activeGoal();
  if (goal === null) {
    const input = kickoffInput(goalText, options);
    const result = await human.kickoff(input);
    if (!result.ok) throw new CliError(`kickoff rejected ${result.rule}: ${result.message}`);
    goal = human.activeGoal();
    if (goal === null) throw new CliError("kickoff succeeded but no active goal was found");
    console.log(`${nowHms()} kickoff ${result.goal_id} · lead ${result.lead} · challenger ${result.challenger}`);
  } else {
    const kickoffArgs = newGoalArgs(goalText, options);
    if (kickoffArgs.length > 0) {
      throw new CliError(
        `${goal.goalId} is already active (phase ${goal.phase}), so ${kickoffArgs.join(", ")} would be ignored; run diarchy start with no goal text or kickoff options to attach to it`,
      );
    }
    console.log(`${nowHms()} attached to ${goal.goalId} (phase ${goal.phase}, lead ${goal.lead})`);
    if (goal.phase === "BLOCKED") {
      const state = human.state();
      const messages = human.listMessages();
      if (state !== null) console.log(`${nowHms()} human needed: ${blockSummary(state, messages)}. Run: ${replyHint(state, messages) ?? "diarchy reply"}`);
      return EXIT_BLOCKED;
    }
  }

  const worktrees = prepareWorktrees(projectDir, config, goal.goalId, agents, options.worktrees);
  if (driver === "real") {
    for (const agent of agents) {
      const notice = sandboxNotice(agent, launcher.agents[agent]);
      if (notice !== null) console.log(`${nowHms()} ${notice}`);
    }
  }
  const supervisor = new Supervisor({ projectDir, config, launcher, human, goal, agents, worktrees, driver, options });
  return supervisor.run();
}

function prepareWorktrees(projectDir: string, config: DiarchyConfig, goalId: string, agents: string[], wanted: boolean): Map<string, string> {
  const map = new Map<string, string>();
  if (!wanted) {
    console.log(`${nowHms()} worktrees skipped (--no-worktrees); agents run in ${projectDir}`);
    return map;
  }
  if (!isGitRepo(projectDir)) {
    console.log(`${nowHms()} worktrees skipped: ${projectDir} is not a git repository; agents run in the project directory`);
    return map;
  }
  if (!hasCommits(projectDir)) {
    console.log(`${nowHms()} worktrees skipped: the repository has no commits yet; agents run in the project directory`);
    return map;
  }
  for (const result of ensureWorktrees(projectDir, config, goalId, agents)) {
    const note = result.note === null ? "" : ` (${result.note})`;
    console.log(`${nowHms()} worktree ${result.outcome} ${result.path} on ${result.branch}${note}`);
    map.set(result.agent, result.path);
  }
  const missing = missingFromWorktrees(projectDir, [...map.values()]);
  if (missing.length > 0) {
    console.log(`${nowHms()} note: ${missing.join(" and ")} not in the worktrees (uncommitted?); Codex reads them only from its worktree. Commit them before the next diarchy start.`);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

interface SupervisorInput {
  projectDir: string;
  config: DiarchyConfig;
  launcher: LauncherConfig;
  human: VaultStore;
  goal: GoalRef;
  agents: string[];
  worktrees: Map<string, string>;
  driver: DriverName;
  options: StartOptions;
}

interface Child {
  agent: string;
  proc: ChildProcess | null;
  plan: SpawnPlan | null;
  spawnedAt: number;
  restarts: number;
  timer: NodeJS.Timeout | null;
  dead: boolean;
  exited: Promise<void>;
  markExited: () => void;
}

class Supervisor {
  private readonly input: SupervisorInput;
  private readonly children = new Map<string, Child>();
  private stopping = false;
  private lastPhase: Phase | null = null;
  private lastCount = -1;
  private resolveRun: ((code: number) => void) | null = null;

  constructor(input: SupervisorInput) {
    this.input = input;
  }

  async run(): Promise<number> {
    const { projectDir } = this.input;
    mkdirSync(dirname(pidPath(projectDir)), { recursive: true });
    writeFileSync(pidPath(projectDir), `${process.pid}\n`);
    const finished = new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });
    const interrupt = (reason: string): void => {
      const phase = this.readState()?.phase;
      void this.finish(phase === "BLOCKED" ? EXIT_BLOCKED : EXIT_ERROR, reason);
    };
    const onSignal = (signal: NodeJS.Signals): void => interrupt(`received ${signal}`);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    // `diarchy start | head`: once the reader goes away, stop the PMs as a signal would instead of crashing and orphaning them.
    // It stays in place after the run, so a late EPIPE cannot exit with the wrong code.
    onBrokenPipe(() => interrupt("output closed"));
    try {
      for (const agent of this.input.agents) this.spawnChild(this.child(agent));
      void this.loop();
      return await finished;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      rmSync(pidPath(projectDir), { force: true });
    }
  }

  private child(agent: string): Child {
    let child = this.children.get(agent);
    if (child === undefined) {
      let markExited: () => void = () => undefined;
      const exited = new Promise<void>((resolve) => {
        markExited = resolve;
      });
      child = { agent, proc: null, plan: null, spawnedAt: 0, restarts: 0, timer: null, dead: false, exited, markExited };
      this.children.set(agent, child);
    }
    return child;
  }

  private log(line: string): void {
    console.log(`${nowHms()} ${line}`);
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private planFor(agent: string): SpawnPlan {
    const { projectDir, goal, worktrees, driver, launcher, options } = this.input;
    const worktree = worktrees.get(agent) ?? null;
    const cwd = worktree ?? projectDir;
    if (driver === "fake") {
      return fakePlan({ projectDir, agent, goalId: goal.goalId, cwd, worktree, script: options.fakeScript ?? defaultFakeScript(), mode: fakeMode(options) });
    }
    const session = loadSession(projectDir, agent, goal.goalId);
    const plan = realPlan({ projectDir, agent, goalId: goal.goalId, launch: launcher.agents[agent], cwd, worktree, session });
    if (plan.minted !== null) saveSession(projectDir, plan.minted);
    return plan;
  }

  private spawnChild(child: Child): void {
    const plan = this.planFor(child.agent);
    const proc = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
    let exitedResolve: () => void = () => undefined;
    child.exited = new Promise<void>((resolve) => {
      exitedResolve = resolve;
    });
    child.markExited = exitedResolve;
    child.proc = proc;
    child.plan = plan;
    child.spawnedAt = Date.now();
    this.log(`${child.agent} started${plan.resumed ? " (resumed session)" : ""}: ${plan.command} ${plan.args.length} args, cwd ${plan.cwd}`);
    if (proc.stdout !== null) this.forward(child, proc.stdout, process.stdout);
    if (proc.stderr !== null) this.forward(child, proc.stderr, process.stderr);
    proc.on("error", (error) => {
      process.stderr.write(`[${child.agent}] spawn error: ${error.message}\n`);
    });
    proc.on("exit", (code, signal) => {
      child.proc = null;
      child.markExited();
      this.onExit(child, code, signal);
    });
  }

  private forward(child: Child, stream: NodeJS.ReadableStream, out: NodeJS.WritableStream): void {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => {
      out.write(`[${child.agent}] ${line}\n`);
      if (this.input.driver !== "real") return;
      const id = detectSessionId(line);
      if (id === null) return;
      const { projectDir, goal } = this.input;
      const current = loadSession(projectDir, child.agent, goal.goalId);
      if (current?.session_id === id) return;
      saveSession(projectDir, { agent: child.agent, goal: goal.goalId, session_id: id, source: "captured", updated: new Date().toISOString() });
      this.log(`${child.agent} session id captured: ${id}`);
    });
  }

  private onExit(child: Child, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping) return;
    const how = signal !== null ? `signal ${signal}` : `code ${code ?? "?"}`;
    this.log(`${child.agent} exited (${how})`);
    if (child.plan?.resumed === true && code !== 0 && Date.now() - child.spawnedAt < FAST_FAIL_MS) {
      clearSession(this.input.projectDir, child.agent);
      this.log(`${child.agent} resume failed fast; dropped the saved session, next start is fresh`);
    }
    this.observe();
    if (this.stopping) return;
    const { max_restarts, restart_backoff_ms } = this.input.launcher.launcher;
    if (child.restarts >= max_restarts) {
      child.dead = true;
      this.log(`${child.agent} will not be restarted (${max_restarts} restarts used)`);
      if ([...this.children.values()].every((entry) => entry.dead)) {
        void this.finish(EXIT_ERROR, `every agent exited while the goal is still ${this.lastPhase ?? "in progress"}`);
      }
      return;
    }
    child.restarts += 1;
    this.log(`${child.agent} restarting in ${restart_backoff_ms / 1000} s (restart ${child.restarts} of ${max_restarts})`);
    child.timer = setTimeout(() => {
      child.timer = null;
      if (!this.stopping) this.spawnChild(child);
    }, restart_backoff_ms);
  }

  // -------------------------------------------------------------------------
  // Watching the goal
  // -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    const pollMs = this.input.launcher.launcher.poll_ms;
    while (!this.stopping) {
      this.observe();
      if (this.stopping) return;
      try {
        // Doubles as the store tick so WALL_CLOCK and the deadlock deadline fire even when both PMs are idle.
        await this.input.human.waitForReply({ timeoutMs: pollMs });
      } catch (error) {
        process.stderr.write(`diarchy: ${error instanceof Error ? error.message : String(error)}\n`);
        await sleep(pollMs);
      }
    }
  }

  private readState(): GoalState | null {
    try {
      return this.input.human.state();
    } catch {
      return null;
    }
  }

  private observe(): void {
    if (this.stopping) return;
    const state = this.readState();
    if (state === null || state.goal !== this.input.goal.goalId) return;
    const count = state.messages.length;
    if (state.phase !== this.lastPhase || count !== this.lastCount) {
      if (count !== this.lastCount) for (const child of this.children.values()) child.restarts = 0;
      const last = state.messages[state.messages.length - 1];
      const tail = last === undefined ? "" : ` · last ${last.from} ${last.type}${last.decision_id === null ? "" : ` ${last.decision_id}`}`;
      this.log(`${state.phase} · ${count} message${count === 1 ? "" : "s"}${tail}`);
      this.lastPhase = state.phase;
      this.lastCount = count;
    }
    if (state.phase === "DONE") void this.finish(EXIT_OK, "DONE");
    else if (state.phase === "BLOCKED") {
      const messages = this.input.human.listMessages();
      const reason = blockReason(state, messages);
      this.log(`BLOCKED: ${blockSummary(state, messages)}. Run: ${replyHint(state, messages) ?? "diarchy reply"}`);
      void this.finish(EXIT_BLOCKED, reason);
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  private alive(): Child[] {
    return [...this.children.values()].filter((child) => child.proc !== null);
  }

  private async waitForExit(children: Child[], ms: number): Promise<void> {
    if (children.length === 0) return;
    await Promise.race([Promise.all(children.map((child) => child.exited)), sleep(ms)]);
  }

  private signalAll(children: Child[], signal: NodeJS.Signals): void {
    for (const child of children) {
      try {
        child.proc?.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  private async finish(code: number, reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const child of this.children.values()) {
      if (child.timer !== null) clearTimeout(child.timer);
      child.timer = null;
    }
    const { stop_grace_ms, wall_clock_grace_ms } = this.input.launcher.launcher;
    const alive = this.alive();
    if (alive.length > 0) {
      if (reason === "WALL_CLOCK") {
        this.log(`wall clock reached; agents have ${Math.round(wall_clock_grace_ms / 60_000)} min to finish before they are killed`);
        await this.waitForExit(alive, wall_clock_grace_ms);
        const survivors = this.alive();
        if (survivors.length > 0) {
          this.log(`killing ${survivors.map((child) => child.agent).join(", ")}`);
          this.signalAll(survivors, "SIGKILL");
          await this.waitForExit(survivors, 2_000);
        }
      } else {
        // Let the PMs notice the terminal phase and exit on their own first: a
        // child killed while it holds the vault lock leaves a stale .lock behind.
        this.log(`${reason}: stopping ${alive.map((child) => child.agent).join(", ")}`);
        await this.waitForExit(alive, stop_grace_ms);
        const lingering = this.alive();
        if (lingering.length > 0) {
          this.signalAll(lingering, "SIGTERM");
          await this.waitForExit(lingering, stop_grace_ms);
        }
        const survivors = this.alive();
        if (survivors.length > 0) {
          this.signalAll(survivors, "SIGKILL");
          await this.waitForExit(survivors, 2_000);
        }
      }
    } else if (reason !== "DONE") {
      this.log(reason);
    }
    this.resolveRun?.(code);
  }
}
