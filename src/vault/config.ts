/**
 * diarchy.config.json loading with PROTOCOL.md section 8 defaults, and the
 * vault layout of section 2 resolved to absolute paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import { describeIssue, parseConfig, type AgentId, type DiarchyConfig } from "../protocol/index.js";

export const CONFIG_FILENAME = "diarchy.config.json";

/** `<basename(projectDir)> brain/diarchy`, relative to the project root. */
export function defaultVault(projectDir: string): string {
  return join(`${basename(resolve(projectDir))} brain`, "diarchy");
}

const DEFAULT_AGENTS: DiarchyConfig["agents"] = {
  claude: { command: "claude" },
  codex: { command: "codex" },
};

/**
 * Read `<projectDir>/diarchy.config.json`; a missing file yields the defaults.
 * Keys the file omits fall back to PROTOCOL.md section 8; an unknown shape
 * throws an error naming the file and the first key at fault.
 */
export function loadConfig(projectDir: string): DiarchyConfig {
  const path = join(projectDir, CONFIG_FILENAME);
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const input = { protocol_version: 1, vault: defaultVault(projectDir), agents: DEFAULT_AGENTS, ...raw };
  try {
    return parseConfig(input);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const { field, problem } = describeIssue(error.issues[0], input);
    throw new Error(`${path}: ${field}: ${problem}`, { cause: error });
  }
}

export interface VaultPaths {
  /** Vault root (config key `vault`, resolved against the project root). */
  vault: string;
  goals: string;
}

export interface GoalPaths extends VaultPaths {
  goalId: string;
  goal: string;
  kickoff: string;
  goalMd: string;
  chatDir: string;
  chatMd: string;
  decisionsMd: string;
  budget: string;
  inboxDir: string;
  lock: string;
  inbox(agent: AgentId): string;
  /** `inbox/<agent>.lock/`: held by the one live MCP server acting as `agent` on this goal (PROTOCOL.md 10). */
  lease(agent: AgentId): string;
}

export function vaultPaths(projectDir: string, config: DiarchyConfig): VaultPaths {
  const vault = resolve(projectDir, config.vault);
  return { vault, goals: join(vault, "goals") };
}

/** Every path in the PROTOCOL.md section 2 layout for one goal. */
export function resolveVaultPaths(projectDir: string, config: DiarchyConfig, goalId: string): GoalPaths {
  const base = vaultPaths(projectDir, config);
  const goal = join(base.goals, goalId);
  const inboxDir = join(goal, "inbox");
  return {
    ...base,
    goalId,
    goal,
    kickoff: join(goal, "kickoff.md"),
    goalMd: join(goal, "goal.md"),
    chatDir: join(goal, "chat"),
    chatMd: join(goal, "chat.md"),
    decisionsMd: join(goal, "decisions.md"),
    budget: join(goal, "budget.json"),
    inboxDir,
    lock: join(goal, ".lock"),
    inbox: (agent) => join(inboxDir, `${agent}.json`),
    lease: (agent) => join(inboxDir, `${agent}.lock`),
  };
}
