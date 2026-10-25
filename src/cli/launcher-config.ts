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

/**
 * Permission rules the Claude PM runs under. Headless `claude -p` has no one to
 * answer a permission prompt, so every tool outside this list is denied:
 * `acceptEdits` covers file edits and read-only shell commands, the MCP rule
 * covers the diarchy tools under the plugin-scoped server name (a server
 * registered with `claude mcp add diarchy` is `mcp__diarchy__*` instead), and
 * the Bash rules cover the commands a PM and its subagents issue. A project
 * whose checks run through another command adds it to `agents.claude.args` in
 * diarchy.config.json, for example `Bash(make *)`.
 */
export const CLAUDE_ALLOWED_TOOLS = ["mcp__plugin_diarchy_diarchy__*", "Bash(git *)", "Bash(npm *)", "Bash(node *)", "Bash(gh *)"];

export const DEFAULT_AGENT_LAUNCH: Record<string, AgentLaunch> = {
  // One comma-joined argument: `--allowedTools` is variadic, so separate entries
  // could absorb whatever the launcher appends after the base flags.
  claude: {
    command: "claude",
    args: ["-p", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", CLAUDE_ALLOWED_TOOLS.join(",")],
  },
  codex: { command: "codex", args: ["exec", "--sandbox", "workspace-write"] },
};

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
