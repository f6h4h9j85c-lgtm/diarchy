/**
 * How `diarchy start` spawns one PM per agent.
 *
 * Real driver: `claude -p --permission-mode acceptEdits --permission-prompts none
 * --allowedTools <diarchy MCP tools and git, npm, node, gh> "<prompt>"` and
 * `codex exec --sandbox workspace-write --dangerously-bypass-hook-trust "<prompt>"`
 * (command and base flags from diarchy.config.json `agents.<id>`; the codex
 * flag runs the diarchy hooks, which a headless run cannot trust in /hooks),
 * cwd the agent's worktree, env
 * DIARCHY_AGENT and DIARCHY_PROJECT so the MCP server and hooks find the vault.
 * Under that sandbox the Codex PM cannot commit, push, or open a PR, so
 * `diarchy start` prints `sandboxNotice`; `diarchy init --codex-full-access`
 * swaps the sandbox flags for `--dangerously-bypass-approvals-and-sandbox`.
 *
 * Session resume is best effort and keyed by goal in `.diarchy/sessions/<agent>.json`:
 * - claude: the launcher mints a UUID and passes `--session-id <uuid>` on the
 *   first spawn, so the id is known without parsing output; a restart passes
 *   `--resume <uuid>` instead.
 * - codex: `codex exec` prints no stable id by default, so the launcher scans
 *   stdout and stderr for `"thread_id": "<id>"` / `"session_id": "<id>"`
 *   (the `--json` event stream) or a `session id: <uuid>` banner line, and a
 *   restart runs `codex exec <flags> resume <id> "<prompt>"`.
 * - anything else: no resume.
 * A resumed child that exits non-zero within a few seconds drops its session
 * file so the next spawn starts fresh.
 *
 * `codex exec` refuses to run outside a git repository, so when the agent's cwd
 * is not in one the launcher adds `--skip-git-repo-check`.
 *
 * Fake driver: `node [--import tsx] <fake-script> <mode>` with the same env plus
 * DIARCHY_FAKE_MODE; used by the e2e test to exercise launcher, store, and
 * engine with no model calls.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runsInWorkspaceWrite, type AgentLaunch } from "./launcher-config.js";

export type DriverName = "real" | "fake";

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** True when the plan resumes a previous session. */
  resumed: boolean;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRecord {
  agent: string;
  goal: string;
  session_id: string;
  source: "minted" | "captured";
  updated: string;
}

export function sessionPath(projectDir: string, agent: string): string {
  return join(projectDir, ".diarchy", "sessions", `${agent}.json`);
}

/** The saved session for this agent, only when it belongs to the same goal. */
export function loadSession(projectDir: string, agent: string, goalId: string): SessionRecord | null {
  const path = sessionPath(projectDir, agent);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionRecord>;
    if (typeof record.session_id !== "string" || record.goal !== goalId) return null;
    return {
      agent,
      goal: goalId,
      session_id: record.session_id,
      source: record.source === "minted" ? "minted" : "captured",
      updated: typeof record.updated === "string" ? record.updated : "",
    };
  } catch {
    return null;
  }
}

export function saveSession(projectDir: string, record: SessionRecord): void {
  const path = sessionPath(projectDir, record.agent);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function clearSession(projectDir: string, agent: string): void {
  rmSync(sessionPath(projectDir, agent), { force: true });
}

// ---------------------------------------------------------------------------
// Session id detection (codex, and claude when run with a JSON output format)
// ---------------------------------------------------------------------------

const JSON_ID = /"(?:session_id|sessionId|thread_id|threadId|conversation_id)"\s*:\s*"([A-Za-z0-9_-]{8,})"/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEXT_ID = new RegExp(`\\b(?:session|thread)(?:[ _-]?id)?\\s*[:=]\\s*(${UUID})\\b`, "i");

/** The session or thread id a CLI printed on this line, if any. */
export function detectSessionId(line: string): string | null {
  const json = JSON_ID.exec(line);
  if (json !== null) return json[1];
  const text = TEXT_ID.exec(line);
  return text === null ? null : text[1];
}

// ---------------------------------------------------------------------------
// Prompt and plans
// ---------------------------------------------------------------------------

export function buildPrompt(agent: string, goalId: string): string {
  return (
    `You are the \`${agent}\` PM in a diarchy run for goal \`${goalId}\`. ` +
    "Load the diarchy-pm skill, call the diarchy `read` tool first, then act on your role. " +
    "Do not stop until the goal is DONE or BLOCKED."
  );
}

export type Flavor = "claude" | "codex" | "generic";

export function flavorOf(command: string): Flavor {
  const name = basename(command).toLowerCase();
  if (name.startsWith("claude")) return "claude";
  if (name.startsWith("codex")) return "codex";
  return "generic";
}

/**
 * The line `diarchy start` prints for a Codex PM launched under
 * `--sandbox workspace-write`, else null: that sandbox keeps the worktree's
 * gitdir read-only and the network off, and `codex exec` never escalates.
 */
export function sandboxNotice(agent: string, launch: AgentLaunch): string | null {
  if (flavorOf(launch.command) !== "codex" || !runsInWorkspaceWrite(launch.args)) return null;
  return (
    `note: ${agent} runs in the Codex workspace-write sandbox, so it can edit and test in its worktree but cannot commit, push, or open a PR; ` +
    "the other PM or you must commit its work (full access: diarchy init --codex-full-access, docs/INSTALL-CODEX.md 5)"
  );
}

export interface RealPlanInput {
  projectDir: string;
  agent: string;
  goalId: string;
  launch: AgentLaunch;
  cwd: string;
  worktree: string | null;
  session: SessionRecord | null;
  /** False when `cwd` is not inside a git repository. */
  inGitRepo?: boolean;
}

/** The `codex exec` flag that lets it run in a directory that is not a git repository. */
export const SKIP_GIT_REPO_CHECK = "--skip-git-repo-check";

export interface RealPlan extends SpawnPlan {
  flavor: Flavor;
  /** A session the launcher minted for this spawn (claude) that must be saved. */
  minted: SessionRecord | null;
}

function baseEnv(input: { projectDir: string; agent: string; goalId: string; worktree: string | null }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIARCHY_AGENT: input.agent,
    DIARCHY_PROJECT: input.projectDir,
    DIARCHY_GOAL: input.goalId,
  };
  if (input.worktree !== null) env.DIARCHY_WORKTREE = input.worktree;
  else delete env.DIARCHY_WORKTREE;
  return env;
}

export function realPlan(input: RealPlanInput): RealPlan {
  const flavor = flavorOf(input.launch.command);
  const prompt = buildPrompt(input.agent, input.goalId);
  const args = [...input.launch.args];
  if (flavor === "codex" && input.inGitRepo === false && !args.includes(SKIP_GIT_REPO_CHECK)) args.push(SKIP_GIT_REPO_CHECK);
  let resumed = false;
  let minted: SessionRecord | null = null;
  if (input.session !== null && flavor === "claude") {
    args.push("--resume", input.session.session_id);
    resumed = true;
  } else if (input.session !== null && flavor === "codex") {
    args.push("resume", input.session.session_id);
    resumed = true;
  } else if (flavor === "claude") {
    minted = {
      agent: input.agent,
      goal: input.goalId,
      session_id: randomUUID(),
      source: "minted",
      updated: new Date().toISOString(),
    };
    args.push("--session-id", minted.session_id);
  }
  args.push(prompt);
  return { command: input.launch.command, args, cwd: input.cwd, env: baseEnv(input), resumed, flavor, minted };
}

export interface FakePlanInput {
  projectDir: string;
  agent: string;
  goalId: string;
  cwd: string;
  worktree: string | null;
  script: string;
  mode: string;
}

/** `src/cli/fake-pm.ts` when running from source (needs tsx), `dist/cli/fake-pm.js` from the build. */
export function defaultFakeScript(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith(".ts") ? ".ts" : ".js";
  return join(dirname(here), `fake-pm${ext}`);
}

/** The tsx loader as a file URL: `--import` takes a URL or specifier, and a Windows path is neither. */
function tsxLoader(): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(join(dirname(require.resolve("tsx/package.json")), "dist", "loader.mjs")).href;
}

export function fakePlan(input: FakePlanInput): SpawnPlan {
  const args = input.script.endsWith(".ts") ? ["--import", tsxLoader(), input.script, input.mode] : [input.script, input.mode];
  return {
    command: process.execPath,
    args,
    cwd: input.cwd,
    env: { ...baseEnv(input), DIARCHY_FAKE_MODE: input.mode },
    resumed: false,
  };
}
