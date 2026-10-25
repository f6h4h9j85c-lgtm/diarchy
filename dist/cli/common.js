/** Helpers shared by the diarchy CLI commands: project resolution, stores, parsing, output. */
import { resolve, sep } from "node:path";
import { AGENT_HUMAN, partialBudgetsSchema } from "../protocol/index.js";
import { VaultStore, loadConfig } from "../vault/index.js";
import { GLYPHS, SEP, hms } from "../vault/render/shared.js";
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
 * `.diarchy/worktrees/<agent>` resolves to the project that owns the worktree,
 * so hooks and the MCP server find the right vault from inside a worktree.
 */
export function resolveProjectDir(option) {
    if (option !== undefined && option !== "")
        return resolve(option);
    const env = process.env.DIARCHY_PROJECT;
    if (env !== undefined && env !== "")
        return resolve(env);
    const cwd = process.cwd();
    const marker = `${sep}.diarchy${sep}worktrees${sep}`;
    const index = cwd.indexOf(marker);
    return index === -1 ? cwd : cwd.slice(0, index);
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