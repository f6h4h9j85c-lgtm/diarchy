/** Helpers shared by the diarchy CLI commands: project resolution, stores, parsing, output. */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AGENT_HUMAN, partialBudgetsSchema } from "../protocol/index.js";
import { CONFIG_FILENAME, VaultStore, loadConfig, vaultPaths } from "../vault/index.js";
import { GLYPHS, SEP, hms } from "../vault/render/shared.js";
import { git, worktreePath } from "./worktrees.js";
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_BLOCKED = 2;
/** What a closed stdout or stderr does; see onBrokenPipe. */
let brokenPipe = () => process.exit(process.exitCode ?? EXIT_OK);
/**
 * Replace what happens when the reader of stdout or stderr goes away (EPIPE,
 * as in `diarchy status | head -1`). The default ends the command quietly;
 * `diarchy start` swaps in its shutdown so its PMs are stopped, not orphaned.
 */
export function onBrokenPipe(handler) {
    brokenPipe = handler;
}
/** Route EPIPE on stdout and stderr to the onBrokenPipe handler instead of crashing with an unhandled 'error' event. */
export function handleBrokenPipes() {
    for (const stream of [process.stdout, process.stderr]) {
        stream.on("error", (error) => {
            if (error.code !== "EPIPE")
                throw error;
            brokenPipe();
        });
    }
}
/** A user-facing failure: printed as `diarchy: <message>` with the given exit code, no stack. */
export class CliError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_ERROR) {
        super(message);
        this.name = "CliError";
        this.exitCode = exitCode;
    }
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
export function resolveProjectDir(option, options = {}) {
    if (option !== undefined && option !== "")
        return resolve(option);
    const env = process.env.DIARCHY_PROJECT;
    if (env !== undefined && env !== "")
        return resolve(env);
    const cwd = process.cwd();
    const marker = `${sep}.diarchy${sep}worktrees${sep}`;
    const index = cwd.indexOf(marker);
    if (index !== -1)
        return cwd.slice(0, index);
    if (options.walkUp === false)
        return cwd;
    return worktreeOwner(cwd) ?? findConfigDir(cwd) ?? cwd;
}
/** Whether the nearest `.git` at or above `start` is a file, as in a linked worktree (or a submodule). */
function inGitFileCheckout(start) {
    for (let dir = resolve(start);;) {
        const entry = join(dir, ".git");
        if (existsSync(entry))
            return !statSync(entry).isDirectory();
        const parent = dirname(dir);
        if (parent === dir)
            return false;
        dir = parent;
    }
}
function realPath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
/**
 * The project that owns `dir` when `dir` is inside a linked git worktree that
 * the project's config places at `<worktrees.root>/<agent>` (PROTOCOL.md 9.1),
 * else null. The main checkout is the parent of the worktree's common git
 * directory; the project is found by walking up from the same place in it,
 * and its diarchy.config.json wins over a copy committed into the worktree.
 * A worktree the config does not name (one a user made by hand) is not owned.
 */
export function worktreeOwner(dir) {
    const start = realPath(dir);
    if (start === null || !inGitFileCheckout(start))
        return null;
    const result = git(start, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    if (!result.ok)
        return null;
    const [toplevel, gitDir, commonDir] = result.stdout.split("\n").map((line) => resolve(start, line.trim()));
    if (toplevel === undefined || gitDir === undefined || commonDir === undefined)
        return null;
    if (gitDir === commonDir || basename(commonDir) !== ".git")
        return null;
    const owner = findConfigDir(join(dirname(commonDir), relative(toplevel, start)));
    if (owner === null)
        return null;
    try {
        const config = loadConfig(owner);
        return Object.keys(config.agents).some((agent) => realPath(worktreePath(owner, config, agent)) === toplevel) ? owner : null;
    }
    catch {
        return null;
    }
}
/** The nearest directory at or above `start` holding diarchy.config.json. */
export function findConfigDir(start) {
    for (let dir = resolve(start);;) {
        if (existsSync(join(dir, CONFIG_FILENAME)))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * "No goal" for the human, naming the vault that was checked and, when the
 * project has no diarchy.config.json, saying the defaults were used, so a
 * command run from the wrong directory does not look like an empty vault.
 */
export function noGoalText(projectDir) {
    const { vault } = vaultPaths(projectDir, loadConfig(projectDir));
    const config = existsSync(join(projectDir, CONFIG_FILENAME))
        ? ""
        : `; no ${CONFIG_FILENAME} in ${projectDir} or above it, so the default vault was checked (run diarchy init there, or pass --project <dir>)`;
    return `no goal in ${vault}${config}`;
}
/** A store posting as the human; `reply` and `stop` require it, every read works. */
export function humanStore(projectDir, pollIntervalMs) {
    const config = loadConfig(projectDir);
    return new VaultStore({
        projectDir,
        config,
        agent: AGENT_HUMAN,
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    });
}
/** The active goal, else the newest one (so status and watch keep working after DONE). */
export function currentGoal(store) {
    const active = store.activeGoal();
    if (active !== null)
        return active;
    const goals = store.listGoals();
    return goals[goals.length - 1] ?? null;
}
/** `key=value` pairs into a partial budgets object; `null` is accepted for spend_usd. */
export function parseBudgets(pairs) {
    const raw = {};
    for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq <= 0)
            throw new CliError(`--budget expects key=value, got "${pair}"`);
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "null") {
            raw[key] = null;
            continue;
        }
        const number = Number(value);
        if (value === "" || Number.isNaN(number))
            throw new CliError(`--budget ${key}: "${value}" is not a number`);
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
export function headerLine(message) {
    const decision = message.decision_id === undefined ? "" : `${SEP}${message.decision_id}`;
    return `${GLYPHS[message.type]} ${message.from} → ${message.to}${SEP}${message.type}${decision}${SEP}re ${message.re.join(", ")}${SEP}${hms(message.ts)}`;
}
export function printJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
export function sleep(ms) {
    return new Promise((done) => setTimeout(done, ms));
}
export function nowHms() {
    return new Date().toISOString().slice(11, 19);
}
//# sourceMappingURL=common.js.map