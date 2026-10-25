/** `diarchy init`: write diarchy.config.json, create the vault, ignore .diarchy/, print the install steps. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AGENT_ID_PATTERN, DEFAULT_LIMITS } from "../protocol/index.js";
import { CONFIG_FILENAME, defaultVault } from "../vault/index.js";
import { CliError, EXIT_ERROR, EXIT_OK } from "./common.js";
import { DEFAULT_LAUNCHER, agentLaunch } from "./launcher-config.js";
import { isGitRepo } from "./worktrees.js";

export interface InitOptions {
  vault?: string;
  agents?: string;
  force?: boolean;
}

const GITIGNORE_LINE = ".diarchy/";

/** Adds `.diarchy/` to .gitignore once; returns whether the file changed. */
function ensureGitignore(projectDir: string): boolean {
  const path = join(projectDir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = existing.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE || line.trim() === ".diarchy");
  if (present) return false;
  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  writeFileSync(path, `${prefix}${existing === "" ? "" : "\n"}# diarchy runtime directory\n${GITIGNORE_LINE}\n`);
  return true;
}

function parseAgents(option: string | undefined): string[] {
  const ids = (option ?? "claude,codex")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (!AGENT_ID_PATTERN.test(id)) throw new CliError(`agent id "${id}" must match ${AGENT_ID_PATTERN.source}`);
  }
  if (unique.length < 2) throw new CliError("--agents needs at least two comma-separated ids");
  return unique;
}

export function buildConfig(projectDir: string, agentIds: string[], vault: string): Record<string, unknown> {
  const agents: Record<string, { command: string; args: string[] }> = {};
  for (const id of agentIds) agents[id] = agentLaunch(id, undefined);
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

function nextSteps(projectDir: string, vaultPath: string, ignored: boolean | null): string {
  const ignoreLine = ignored === null ? "not a git repo; add .diarchy/ to your ignore file" : ignored ? ".diarchy/ (added to .gitignore)" : ".diarchy/ (already in .gitignore)";
  return [
    `diarchy initialised in ${projectDir}`,
    `  config   ${CONFIG_FILENAME}`,
    `  vault    ${vaultPath}`,
    `  ignored  ${ignoreLine}`,
    "",
    "Next steps",
    "  1. Claude Code:  claude plugin install diarchy --marketplace f6h4h9j85c-lgtm/diarchy",
    "                   (inside Claude Code: /plugin marketplace add f6h4h9j85c-lgtm/diarchy, then /plugin install diarchy@diarchy)",
    "  2. Codex CLI:    codex plugin marketplace add f6h4h9j85c-lgtm/diarchy",
    "                   then add [mcp_servers.diarchy] to ~/.codex/config.toml and trust the project (docs/INSTALL-CODEX.md)",
    "  3. Copy templates/AGENTS.md to this project root as AGENTS.md so the Codex PM reads it at session start.",
    '  4. Run a goal:   diarchy start "<goal>" --ac "<criterion>" [--ac ...]',
    '     No model calls, protocol only:  diarchy start "<goal>" --ac "<criterion>" --driver fake',
    '  5. Follow along: diarchy watch, diarchy status. Answer a BLOCKED run with diarchy reply "<text>".',
  ].join("\n");
}

export function runInit(projectDir: string, options: InitOptions): number {
  const agentIds = parseAgents(options.agents);
  const configPath = join(projectDir, CONFIG_FILENAME);
  const exists = existsSync(configPath);
  let vault = options.vault ?? defaultVault(projectDir);
  if (exists && options.force !== true) {
    const current = JSON.parse(readFileSync(configPath, "utf8")) as { vault?: string };
    if (typeof current.vault === "string") vault = current.vault;
  }
  const vaultPath = resolve(projectDir, vault);
  mkdirSync(vaultPath, { recursive: true });
  const ignored = isGitRepo(projectDir) ? ensureGitignore(projectDir) : null;
  if (exists && options.force !== true) {
    console.error(`diarchy: ${CONFIG_FILENAME} already exists in ${projectDir}; pass --force to rewrite it (vault and ignore file were checked)`);
    return EXIT_ERROR;
  }
  writeFileSync(configPath, `${JSON.stringify(buildConfig(projectDir, agentIds, vault), null, 2)}\n`);
  console.log(nextSteps(projectDir, vaultPath, ignored));
  return EXIT_OK;
}
