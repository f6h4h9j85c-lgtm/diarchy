import type { DiarchyConfig } from "../protocol/index.js";
export interface GitResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}
export declare function git(cwd: string, args: string[]): GitResult;
export declare function isGitRepo(dir: string): boolean;
export declare function hasCommits(dir: string): boolean;
export interface WorktreeResult {
    agent: string;
    path: string;
    branch: string;
    /** created | reused | switched | kept (existing worktree on another branch that could not be switched) */
    outcome: "created" | "reused" | "switched" | "kept";
    note: string | null;
}
export declare function worktreePath(projectDir: string, config: DiarchyConfig, agent: string): string;
export declare function branchName(config: DiarchyConfig, goalId: string, agent: string): string;
/**
 * The existing branch that blocks every `<branch_prefix>/<goal-id>/<agent>`,
 * or null. git stores a branch as a path under refs/heads/, so no branch can
 * be created below a branch named like one of its leading paths.
 */
export declare function branchPrefixClash(projectDir: string, branchPrefix: string): string | null;
/** The paths inside the project's repository that git does not ignore; a path outside it is no concern of the repository. */
export declare function notIgnored(projectDir: string, paths: string[]): string[];
/**
 * Project files Codex reads from its git root, which for a PM in a linked
 * worktree is the worktree itself, never the main checkout.
 */
export declare const CODEX_PROJECT_FILES: string[];
/**
 * The Codex project files present in the project but missing from at least
 * one worktree: uncommitted, so a worktree cut from HEAD does not have them.
 */
export declare function missingFromWorktrees(projectDir: string, worktrees: string[]): string[];
/** One worktree per agent; prunes stale registrations first. Throws when git itself fails. */
export declare function ensureWorktrees(projectDir: string, config: DiarchyConfig, goalId: string, agents: string[]): WorktreeResult[];
