import { type BudgetLimits, type Message } from "../protocol/index.js";
import { VaultStore, type GoalRef } from "../vault/index.js";
export declare const EXIT_OK = 0;
export declare const EXIT_ERROR = 1;
export declare const EXIT_BLOCKED = 2;
/**
 * Replace what happens when the reader of stdout or stderr goes away (EPIPE,
 * as in `diarchy status | head -1`). The default ends the command quietly;
 * `diarchy start` swaps in its shutdown so its PMs are stopped, not orphaned.
 */
export declare function onBrokenPipe(handler: () => void): void;
/** Route EPIPE on stdout and stderr to the onBrokenPipe handler instead of crashing with an unhandled 'error' event. */
export declare function handleBrokenPipes(): void;
/** A user-facing failure: printed as `diarchy: <message>` with the given exit code, no stack. */
export declare class CliError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode?: number);
}
/**
 * The project root: `--project`, else `DIARCHY_PROJECT` (set by the launcher
 * for its children and their hooks), else the cwd. A cwd inside
 * `.diarchy/worktrees/<agent>`, or inside an agent worktree under any other
 * `worktrees.root` (see worktreeOwner), resolves to the project that owns the
 * worktree, so hooks and the MCP server find the right vault from inside a
 * worktree even when Codex has dropped DIARCHY_PROJECT from the server's env.
 * Otherwise the nearest directory at or above the cwd that holds
 * diarchy.config.json wins, so a command run from `<project>/src` reads the
 * project's vault; `walkUp: false` (for `init`) keeps the cwd.
 */
export declare function resolveProjectDir(option: string | undefined, options?: {
    walkUp?: boolean;
}): string;
/** Which rule of resolveProjectDir found the project. */
export type ProjectSource = "option" | "env" | "worktree-marker" | "worktree-owner" | "walk-up" | "cwd";
export interface ResolvedProject {
    dir: string;
    source: ProjectSource;
}
/** resolveProjectDir, also saying which rule found the project (for the diagnostics trail). */
export declare function resolveProjectDirWithSource(option: string | undefined, options?: {
    walkUp?: boolean;
}): ResolvedProject;
/**
 * The project that owns `dir` when `dir` is inside a linked git worktree that
 * the project's config places at `<worktrees.root>/<agent>` (PROTOCOL.md 9.1),
 * else null. The main checkout is the parent of the worktree's common git
 * directory; the project is found by walking up from the same place in it,
 * and its diarchy.config.json wins over a copy committed into the worktree.
 * A worktree the config does not name (one a user made by hand) is not owned.
 */
export declare function worktreeOwner(dir: string): string | null;
/** The nearest directory at or above `start` holding diarchy.config.json. */
export declare function findConfigDir(start: string): string | null;
/**
 * "No goal" for the human, naming the vault that was checked and, when the
 * project has no diarchy.config.json, saying the defaults were used, so a
 * command run from the wrong directory does not look like an empty vault.
 */
export declare function noGoalText(projectDir: string): string;
/**
 * `start` and `kickoff` write a goal, so they refuse a project with no
 * diarchy.config.json: run from the wrong directory, they would kick off into
 * a default vault there.
 */
export declare function requireConfig(projectDir: string): void;
/** A store posting as the human; `reply` and `stop` require it, every read works. */
export declare function humanStore(projectDir: string, pollIntervalMs?: number): VaultStore;
/** The active goal, else the newest one (so status and watch keep working after DONE). */
export declare function currentGoal(store: VaultStore): GoalRef | null;
/** `key=value` pairs into a partial budgets object; `null` is accepted for spend_usd. */
export declare function parseBudgets(pairs: string[]): Partial<BudgetLimits>;
/** The chat.md header segments (RENDERING.md 2.2) as one plain terminal line. */
export declare function headerLine(message: Message): string;
export declare function printJson(value: unknown): void;
export declare function sleep(ms: number): Promise<void>;
export declare function nowHms(): string;
