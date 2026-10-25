/**
 * `diarchy init`: write diarchy.config.json, create the vault, ignore .diarchy/,
 * give Codex its project files, print the install steps.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ID_PATTERN, DEFAULT_LIMITS, MAX_AGENTS } from "../protocol/index.js";
import { CONFIG_FILENAME, defaultVault } from "../vault/index.js";
import { CliError, EXIT_ERROR, EXIT_OK } from "./common.js";
import { CODEX_FULL_ACCESS_ARGS, DEFAULT_LAUNCHER, agentLaunch } from "./launcher-config.js";
import { isGitRepo } from "./worktrees.js";
/** Printed after `diarchy init --codex-full-access` writes the config. */
export const CODEX_FULL_ACCESS_WARNING = [
    "warning: --codex-full-access launches the Codex PM with --dangerously-bypass-approvals-and-sandbox. It then",
    "runs with your full OS permissions and no approval prompts: it can read, change, or delete any file your user",
    "can, anywhere on the machine, and reach the network; its worktree is a convention, not a wall. Use it only on",
    "a machine or container you are willing to let it change. To restore the sandbox, set agents.codex.args in",
    `${CONFIG_FILENAME} back to the default or rerun diarchy init --force without the flag (docs/INSTALL-CODEX.md 5).`,
].join("\n");
const GITIGNORE_LINE = ".diarchy/";
/** The diarchy package root: two levels above src/cli/init.ts and dist/cli/init.js. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * The files Codex reads from the project rather than from a plugin: the five
 * subagents in `.codex/agents/` and `AGENTS.md`. Copies each missing one from
 * the package (`.codex/agents/*.toml`, `templates/AGENTS.md`) and never
 * overwrites an existing file.
 */
function installCodexFiles(projectDir) {
    const agentsDir = join(PACKAGE_ROOT, ".codex", "agents");
    const sources = readdirSync(agentsDir)
        .filter((file) => file.endsWith(".toml"))
        .sort()
        .map((file) => ({ from: join(agentsDir, file), path: join(".codex", "agents", file) }));
    sources.push({ from: join(PACKAGE_ROOT, "templates", "AGENTS.md"), path: "AGENTS.md" });
    return sources.map(({ from, path }) => {
        const target = join(projectDir, path);
        if (existsSync(target))
            return { path, outcome: "kept" };
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(from, target);
        return { path, outcome: "written" };
    });
}
/** Adds `.diarchy/` to .gitignore once; returns whether the file changed. */
function ensureGitignore(projectDir) {
    const path = join(projectDir, ".gitignore");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const present = existing.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE || line.trim() === ".diarchy");
    if (present)
        return false;
    const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
    writeFileSync(path, `${prefix}${existing === "" ? "" : "\n"}# diarchy runtime directory\n${GITIGNORE_LINE}\n`);
    return true;
}
function parseAgents(option) {
    const ids = (option ?? "claude,codex")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "");
    const unique = [...new Set(ids)];
    for (const id of unique) {
        if (!AGENT_ID_PATTERN.test(id))
            throw new CliError(`agent id "${id}" must match ${AGENT_ID_PATTERN.source}`);
    }
    if (unique.length !== MAX_AGENTS) {
        throw new CliError(`--agents needs exactly ${MAX_AGENTS} comma-separated ids: protocol_version 1 runs one lead and one challenger`);
    }
    return unique;
}
export function buildConfig(projectDir, agentIds, vault, options = {}) {
    const agents = {};
    for (const id of agentIds)
        agents[id] = agentLaunch(id, undefined);
    if (options.codexFullAccess === true && agents.codex !== undefined)
        agents.codex.args = [...CODEX_FULL_ACCESS_ARGS];
    return {
        protocol_version: 1,
        vault,
        agents,
        budgets: { ...DEFAULT_LIMITS },
        worktrees: { root: ".diarchy/worktrees", branch_prefix: "diarchy" },
        review: { required: true },
        launcher: { ...DEFAULT_LAUNCHER },
    };
}
function codexLines(codex) {
    if (codex === null) {
        return { summary: [], step: ["  3. Commit what the PMs should see: each works in a git worktree cut from HEAD."] };
    }
    const written = codex.filter((file) => file.outcome === "written").length;
    const agentsMdKept = codex.some((file) => file.path === "AGENTS.md" && file.outcome === "kept");
    return {
        summary: [`  codex    AGENTS.md and .codex/agents/: ${written} written, ${codex.length - written} kept`],
        step: [
            "  3. Commit AGENTS.md and .codex/agents/ (git add AGENTS.md .codex && git commit): each PM works in a",
            "     git worktree cut from HEAD, and Codex reads both only from its own worktree, never from this checkout.",
            ...(agentsMdKept ? [`     AGENTS.md already existed and was kept; append ${join(PACKAGE_ROOT, "templates", "AGENTS.md")} if it lacks the diarchy section.`] : []),
        ],
    };
}
function nextSteps(projectDir, vaultPath, ignored, codex) {
    const ignoreLine = ignored === null ? "not a git repo; add .diarchy/ to your ignore file" : ignored ? ".diarchy/ (added to .gitignore)" : ".diarchy/ (already in .gitignore)";
    const { summary, step } = codexLines(codex);
    return [
        `diarchy initialised in ${projectDir}`,
        `  config   ${CONFIG_FILENAME}`,
        `  vault    ${vaultPath}`,
        `  ignored  ${ignoreLine}`,
        ...summary,
        "",
        "Next steps",
        "  1. Claude Code:  claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy",
        "                   (inside Claude Code: /plugin marketplace add f6h4h9j85c-lgtm/diarchy, then /plugin install diarchy@diarchy)",
        "  2. Codex CLI:    codex plugin marketplace add f6h4h9j85c-lgtm/diarchy",
        "                   then add [mcp_servers.diarchy] to ~/.codex/config.toml, trust the project, and approve the diarchy hooks in /hooks (docs/INSTALL-CODEX.md)",
        ...step,
        "  4. The Claude PM may run git, npm, node, and gh. If your checks use another command, add Bash(<cmd> *) to agents.claude.args in diarchy.config.json.",
        '  5. Run a goal:   diarchy start "<goal>" --ac "<criterion>" [--ac ...]',
        '     No model calls, protocol only:  diarchy start "<goal>" --ac "<criterion>" --driver fake',
        '  6. Follow along: diarchy watch, diarchy status. Answer a BLOCKED run with diarchy reply "<text>".',
    ].join("\n");
}
export function runInit(projectDir, options) {
    const agentIds = parseAgents(options.agents);
    const fullAccess = options.codexFullAccess === true;
    if (fullAccess && !agentIds.includes("codex"))
        throw new CliError("--codex-full-access needs an agent named codex in --agents");
    const configPath = join(projectDir, CONFIG_FILENAME);
    const exists = existsSync(configPath);
    let vault = options.vault ?? defaultVault(projectDir);
    if (exists && options.force !== true) {
        const current = JSON.parse(readFileSync(configPath, "utf8"));
        if (typeof current.vault === "string")
            vault = current.vault;
    }
    const vaultPath = resolve(projectDir, vault);
    mkdirSync(vaultPath, { recursive: true });
    const ignored = isGitRepo(projectDir) ? ensureGitignore(projectDir) : null;
    // Codex loads no subagents from a plugin, so they live in the project.
    const codex = agentIds.includes("codex") ? installCodexFiles(projectDir) : null;
    if (exists && options.force !== true) {
        const skipped = fullAccess ? "; --codex-full-access was not applied" : "";
        console.error(`diarchy: ${CONFIG_FILENAME} already exists in ${projectDir}${skipped}; pass --force to rewrite it (vault, ignore file, and Codex files were checked)`);
        return EXIT_ERROR;
    }
    writeFileSync(configPath, `${JSON.stringify(buildConfig(projectDir, agentIds, vault, { codexFullAccess: fullAccess }), null, 2)}\n`);
    console.log(nextSteps(projectDir, vaultPath, ignored, codex));
    if (fullAccess)
        console.error(CODEX_FULL_ACCESS_WARNING);
    return EXIT_OK;
}
//# sourceMappingURL=init.js.map