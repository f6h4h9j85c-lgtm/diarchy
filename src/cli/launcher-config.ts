/**
 * Launcher-only configuration read from diarchy.config.json: how to spawn each
 * agent (`agents.<id>.command` and `args`) and the supervisor knobs under
 * `launcher`. The store's `loadConfig` owns everything else and strips these
 * keys, so this module reads the raw file and validates its own slice.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { CONFIG_FILENAME } from "../vault/index.js";

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

/** Codex flag that runs enabled hooks without persisted /hooks trust for one invocation. */
export const HOOK_TRUST_BYPASS = "--dangerously-bypass-hook-trust";

export const DEFAULT_AGENT_LAUNCH: Record<string, AgentLaunch> = {
  claude: { command: "claude", args: ["-p", "--permission-mode", "acceptEdits"] },
  // --dangerously-bypass-hook-trust: Codex runs a non-managed hook only once its
  // definition is trusted in /hooks, and `codex exec` never shows that prompt, so
  // without the flag the SessionStart brief and the Stop gate are skipped
  // silently. The flag runs every enabled hook unreviewed for that invocation;
  // the launcher is automation for a project whose hook sources the operator has
  // read. Set agents.codex.args in diarchy.config.json without it to require
  // persisted trust instead.
  //
  // The sandbox stays on: the PM edits and tests in its worktree but cannot
  // commit, push, or open a PR, because workspace-write keeps the gitdir
  // read-only and the network off and `codex exec` never escalates. Full access
  // is an explicit opt-in (`diarchy init --codex-full-access`, docs/INSTALL-CODEX.md 5).
  codex: { command: "codex", args: ["exec", "--sandbox", "workspace-write", HOOK_TRUST_BYPASS] },
};

/** Codex flag that turns off the sandbox and approvals: the PM runs with the user's full OS permissions. */
export const SANDBOX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

/** `agents.codex.args` written by `diarchy init --codex-full-access`. */
export const CODEX_FULL_ACCESS_ARGS: readonly string[] = ["exec", SANDBOX_BYPASS, HOOK_TRUST_BYPASS];

/** True when these launch args keep Codex in the workspace-write sandbox (`--sandbox workspace-write`, `-s`, or `-c sandbox_mode=`). */
export function runsInWorkspaceWrite(args: readonly string[]): boolean {
  return !args.includes(SANDBOX_BYPASS) && args.some((arg) => arg.includes("workspace-write"));
}

export const DEFAULT_LAUNCHER: LauncherKnobs = {
  poll_ms: 1000,
  max_restarts: 3,
  restart_backoff_ms: 5_000,
  stop_grace_ms: 10_000,
  wall_clock_grace_ms: 300_000,
};

const knobsSchema = z.object({
  poll_ms: z.number().int().positive().max(1000).default(DEFAULT_LAUNCHER.poll_ms),
  max_restarts: z.number().int().min(0).default(DEFAULT_LAUNCHER.max_restarts),
  restart_backoff_ms: z.number().int().min(0).default(DEFAULT_LAUNCHER.restart_backoff_ms),
  stop_grace_ms: z.number().int().min(0).default(DEFAULT_LAUNCHER.stop_grace_ms),
  wall_clock_grace_ms: z.number().int().min(0).default(DEFAULT_LAUNCHER.wall_clock_grace_ms),
});

const rawAgentSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).optional() });

const rawSchema = z.object({
  agents: z.record(z.string(), rawAgentSchema).optional(),
  launcher: knobsSchema.optional(),
});

/**
 * The spawn recipe for one agent. `args` present: used verbatim. Absent: a
 * command with spaces (`"claude -p ..."`, PROTOCOL.md 8) is split on
 * whitespace; a bare known executable gets the default flags; anything else
 * runs with no flags.
 */
export function agentLaunch(id: string, raw: { command: string; args?: string[] } | undefined): AgentLaunch {
  const fallback = DEFAULT_AGENT_LAUNCH[id] ?? { command: id, args: [] };
  if (raw === undefined) return { command: fallback.command, args: [...fallback.args] };
  if (raw.args !== undefined) return { command: raw.command, args: [...raw.args] };
  const parts = raw.command.trim().split(/\s+/);
  if (parts.length > 1) return { command: parts[0], args: parts.slice(1) };
  const known = DEFAULT_AGENT_LAUNCH[basename(raw.command)];
  return { command: raw.command, args: known === undefined ? [] : [...known.args] };
}

export function loadLauncherConfig(projectDir: string, agentIds: string[]): LauncherConfig {
  const path = join(projectDir, CONFIG_FILENAME);
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`${path}: ${problems.join("; ")}`);
  }
  const agents: Record<string, AgentLaunch> = {};
  for (const id of agentIds) agents[id] = agentLaunch(id, parsed.data.agents?.[id]);
  return { agents, launcher: parsed.data.launcher ?? { ...DEFAULT_LAUNCHER } };
}
