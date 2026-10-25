/**
 * Per-agent git worktrees (PROTOCOL.md 9.1): `<worktrees.root>/<agent>` on
 * `<branch_prefix>/<goal-id>/<agent>`, cut from the project's current HEAD.
 * Never removes a worktree or discards work: an existing worktree is reused,
 * switched to the goal branch when that is clean, or left as is with a note.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { DiarchyConfig } from "../protocol/index.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

export function isGitRepo(dir: string): boolean {
  const result = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

export function hasCommits(dir: string): boolean {
  return git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
}

export interface WorktreeResult {
  agent: string;
  path: string;
  branch: string;
  /** created | reused | switched | kept (existing worktree on another branch that could not be switched) */
  outcome: "created" | "reused" | "switched" | "kept";
  note: string | null;
}

export function worktreePath(projectDir: string, config: DiarchyConfig, agent: string): string {
  return resolve(projectDir, config.worktrees.root, agent);
}

export function branchName(config: DiarchyConfig, goalId: string, agent: string): string {
  return `${config.worktrees.branch_prefix}/${goalId}/${agent}`;
}

function currentBranch(path: string): string | null {
  const result = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.ok ? result.stdout : null;
}

function ensureOne(projectDir: string, config: DiarchyConfig, goalId: string, agent: string): WorktreeResult {
  const path = worktreePath(projectDir, config, agent);
  const branch = branchName(config, goalId, agent);
  const base = { agent, path, branch };
  if (existsSync(path)) {
    const current = currentBranch(path);
    if (current === branch) return { ...base, outcome: "reused", note: null };
    if (current === null) return { ...base, outcome: "kept", note: "path exists but is not a git worktree" };
    const head = git(projectDir, ["rev-parse", "HEAD"]).stdout;
    const branchExists = git(projectDir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;
    const switched = branchExists ? git(path, ["checkout", "-q", branch]) : git(path, ["checkout", "-q", "-b", branch, head]);
    if (switched.ok) return { ...base, outcome: "switched", note: `was on ${current}` };
    return { ...base, outcome: "kept", note: `still on ${current}: ${switched.stderr.split("\n")[0]}` };
  }
  const branchExists = git(projectDir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;
  const added = branchExists
    ? git(projectDir, ["worktree", "add", path, branch])
    : git(projectDir, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (!added.ok) throw new Error(`git worktree add failed for ${agent}: ${added.stderr}`);
  return { ...base, outcome: "created", note: branchExists ? "existing branch" : null };
}

/** One worktree per agent; prunes stale registrations first. Throws when git itself fails. */
export function ensureWorktrees(projectDir: string, config: DiarchyConfig, goalId: string, agents: string[]): WorktreeResult[] {
  git(projectDir, ["worktree", "prune"]);
  return agents.map((agent) => ensureOne(projectDir, config, goalId, agent));
}
