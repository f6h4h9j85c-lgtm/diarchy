/** Helpers shared by the diarchy CLI commands: project resolution, stores, parsing, output. */
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { AGENT_HUMAN, partialBudgetsSchema, type BudgetLimits, type Message } from "../protocol/index.js";
import { CONFIG_FILENAME, VaultStore, loadConfig, vaultPaths, type GoalRef } from "../vault/index.js";
import { GLYPHS, SEP, hms } from "../vault/render/shared.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_BLOCKED = 2;

/** A user-facing failure: printed as `diarchy: <message>` with the given exit code, no stack. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = EXIT_ERROR) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * The project root: `--project`, else `DIARCHY_PROJECT` (set by the launcher
 * for its children and their hooks), else the cwd. A cwd inside
 * `.diarchy/worktrees/<agent>` resolves to the project that owns the worktree,
 * so hooks and the MCP server find the right vault from inside a worktree.
 * Otherwise the nearest directory at or above the cwd that holds
 * diarchy.config.json wins, so a command run from `<project>/src` reads the
 * project's vault; `walkUp: false` (for `init`) keeps the cwd.
 */
export function resolveProjectDir(option: string | undefined, options: { walkUp?: boolean } = {}): string {
  if (option !== undefined && option !== "") return resolve(option);
  const env = process.env.DIARCHY_PROJECT;
  if (env !== undefined && env !== "") return resolve(env);
  const cwd = process.cwd();
  const marker = `${sep}.diarchy${sep}worktrees${sep}`;
  const index = cwd.indexOf(marker);
  if (index !== -1) return cwd.slice(0, index);
  return options.walkUp === false ? cwd : (findConfigDir(cwd) ?? cwd);
}

/** The nearest directory at or above `start` holding diarchy.config.json. */
export function findConfigDir(start: string): string | null {
  for (let dir = resolve(start); ; ) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * "No goal" for the human, naming the vault that was checked and, when the
 * project has no diarchy.config.json, saying the defaults were used, so a
 * command run from the wrong directory does not look like an empty vault.
 */
export function noGoalText(projectDir: string): string {
  const { vault } = vaultPaths(projectDir, loadConfig(projectDir));
  const config = existsSync(join(projectDir, CONFIG_FILENAME))
    ? ""
    : `; no ${CONFIG_FILENAME} in ${projectDir} or above it, so the default vault was checked (run diarchy init there, or pass --project <dir>)`;
  return `no goal in ${vault}${config}`;
}

/** A store posting as the human; `reply` and `stop` require it, every read works. */
export function humanStore(projectDir: string, pollIntervalMs?: number): VaultStore {
  const config = loadConfig(projectDir);
  return new VaultStore({
    projectDir,
    config,
    agent: AGENT_HUMAN,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });
}

/** The active goal, else the newest one (so status and watch keep working after DONE). */
export function currentGoal(store: VaultStore): GoalRef | null {
  const active = store.activeGoal();
  if (active !== null) return active;
  const goals = store.listGoals();
  return goals[goals.length - 1] ?? null;
}

/** `key=value` pairs into a partial budgets object; `null` is accepted for spend_usd. */
export function parseBudgets(pairs: string[]): Partial<BudgetLimits> {
  const raw: Record<string, number | null> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`--budget expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "null") {
      raw[key] = null;
      continue;
    }
    const number = Number(value);
    if (value === "" || Number.isNaN(number)) throw new CliError(`--budget ${key}: "${value}" is not a number`);
    raw[key] = number;
  }
  const parsed = partialBudgetsSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new CliError(`invalid --budget: ${problems.join("; ")}`);
  }
  return parsed.data;
}

/** The chat.md header segments (RENDERING.md 2.2) as one plain terminal line. */
export function headerLine(message: Message): string {
  const decision = message.decision_id === undefined ? "" : `${SEP}${message.decision_id}`;
  return `${GLYPHS[message.type]} ${message.from} → ${message.to}${SEP}${message.type}${decision}${SEP}re ${message.re.join(", ")}${SEP}${hms(message.ts)}`;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export function nowHms(): string {
  return new Date().toISOString().slice(11, 19);
}
