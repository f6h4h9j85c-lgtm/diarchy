/**
 * Per-agent git worktrees (PROTOCOL.md 9.1): `<worktrees.root>/<agent>` on
 * `<branch_prefix>/<goal-id>/<agent>`, cut from the project's current HEAD.
 * Never removes a worktree or discards work: an existing worktree is reused,
 * switched to the goal branch when that is clean, or left as is with a note.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
export function git(cwd, args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}
export function isGitRepo(dir) {
    const result = git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return result.ok && result.stdout === "true";
}
export function hasCommits(dir) {
    return git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
}
export function worktreePath(projectDir, config, agent) {
    return resolve(projectDir, config.worktrees.root, agent);
}
export function branchName(config, goalId, agent) {
    return `${config.worktrees.branch_prefix}/${goalId}/${agent}`;
}
function currentBranch(path) {
    const result = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return result.ok ? result.stdout : null;
}
function ensureOne(projectDir, config, goalId, agent) {
    const path = worktreePath(projectDir, config, agent);
    const branch = branchName(config, goalId, agent);
    const base = { agent, path, branch };
    if (existsSync(path)) {
        const current = currentBranch(path);
        if (current === branch)
            return { ...base, outcome: "reused", note: null };
        if (current === null)
            return { ...base, outcome: "kept", note: "path exists but is not a git worktree" };
        const head = git(projectDir, ["rev-parse", "HEAD"]).stdout;
        const branchExists = git(projectDir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;
        const switched = branchExists ? git(path, ["checkout", "-q", branch]) : git(path, ["checkout", "-q", "-b", branch, head]);
        if (switched.ok)
            return { ...base, outcome: "switched", note: `was on ${current}` };
        return { ...base, outcome: "kept", note: `still on ${current}: ${switched.stderr.split("\n")[0]}` };
    }
    const branchExists = git(projectDir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok;
    const added = branchExists
        ? git(projectDir, ["worktree", "add", path, branch])
        : git(projectDir, ["worktree", "add", "-b", branch, path, "HEAD"]);
    if (!added.ok)
        throw new Error(`git worktree add failed for ${agent}: ${added.stderr}`);
    return { ...base, outcome: "created", note: branchExists ? "existing branch" : null };
}
/**
 * Project files Codex reads from its git root, which for a PM in a linked
 * worktree is the worktree itself, never the main checkout.
 */
export const CODEX_PROJECT_FILES = ["AGENTS.md", ".codex/agents"];
/**
 * The Codex project files present in the project but missing from at least
 * one worktree: uncommitted, so a worktree cut from HEAD does not have them.
 */
export function missingFromWorktrees(projectDir, worktrees) {
    return CODEX_PROJECT_FILES.filter((path) => existsSync(join(projectDir, path)) && worktrees.some((worktree) => !existsSync(join(worktree, path))));
}
/** One worktree per agent; prunes stale registrations first. Throws when git itself fails. */
export function ensureWorktrees(projectDir, config, goalId, agents) {
    git(projectDir, ["worktree", "prune"]);
    return agents.map((agent) => ensureOne(projectDir, config, goalId, agent));
}
//# sourceMappingURL=worktrees.js.map