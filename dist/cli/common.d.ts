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
 * `.diarchy/worktrees/<agent>` resolves to the project that owns the worktree,
 * so hooks and the MCP server find the right vault from inside a worktree.
 * Otherwise the nearest directory at or above the cwd that holds
 * diarchy.config.json wins, so a command run from `<project>/src` reads the
 * project's vault; `walkUp: false` (for `init`) keeps the cwd.
 */
export declare function resolveProjectDir(option: string | undefined, options?: {
    walkUp?: boolean;
}): string;
/** The nearest directory at or above `start` holding diarchy.config.json. */
export declare function findConfigDir(start: string): string | null;
/**
 * "No goal" for the human, naming the vault that was checked and, when the
 * project has no diarchy.config.json, saying the defaults were used, so a
 * command run from the wrong directory does not look like an empty vault.
 */
export declare function noGoalText(projectDir: string): string;
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
