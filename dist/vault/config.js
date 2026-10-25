/**
 * diarchy.config.json loading with PROTOCOL.md section 8 defaults, and the
 * vault layout of section 2 resolved to absolute paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseConfig } from "../protocol/index.js";
export const CONFIG_FILENAME = "diarchy.config.json";
/** `<basename(projectDir)> brain/diarchy`, relative to the project root. */
export function defaultVault(projectDir) {
    return join(`${basename(resolve(projectDir))} brain`, "diarchy");
}
const DEFAULT_AGENTS = {
    claude: { command: "claude" },
    codex: { command: "codex" },
};
/**
 * Read `<projectDir>/diarchy.config.json`; a missing file yields the defaults.
 * Keys the file omits fall back to PROTOCOL.md section 8; unknown shapes throw.
 */
export function loadConfig(projectDir) {
    const path = join(projectDir, CONFIG_FILENAME);
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${path}: expected a JSON object`);
    }
    return parseConfig({ protocol_version: 1, vault: defaultVault(projectDir), agents: DEFAULT_AGENTS, ...raw });
}
export function vaultPaths(projectDir, config) {
    const vault = resolve(projectDir, config.vault);
    return { vault, goals: join(vault, "goals") };
}
/** Every path in the PROTOCOL.md section 2 layout for one goal. */
export function resolveVaultPaths(projectDir, config, goalId) {
    const base = vaultPaths(projectDir, config);
    const goal = join(base.goals, goalId);
    const inboxDir = join(goal, "inbox");
    return {
        ...base,
        goalId,
        goal,
        kickoff: join(goal, "kickoff.md"),
        goalMd: join(goal, "goal.md"),
        chatDir: join(goal, "chat"),
        chatMd: join(goal, "chat.md"),
        decisionsMd: join(goal, "decisions.md"),
        budget: join(goal, "budget.json"),
        inboxDir,
        lock: join(goal, ".lock"),
        inbox: (agent) => join(inboxDir, `${agent}.json`),
    };
}
//# sourceMappingURL=config.js.map