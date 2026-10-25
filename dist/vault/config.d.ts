import { type AgentId, type DiarchyConfig } from "../protocol/index.js";
export declare const CONFIG_FILENAME = "diarchy.config.json";
/** `<basename(projectDir)> brain/diarchy`, relative to the project root. */
export declare function defaultVault(projectDir: string): string;
/**
 * Read `<projectDir>/diarchy.config.json`; a missing file yields the defaults.
 * Keys the file omits fall back to PROTOCOL.md section 8; unknown shapes throw.
 */
export declare function loadConfig(projectDir: string): DiarchyConfig;
export interface VaultPaths {
    /** Vault root (config key `vault`, resolved against the project root). */
    vault: string;
    goals: string;
}
export interface GoalPaths extends VaultPaths {
    goalId: string;
    goal: string;
    kickoff: string;
    goalMd: string;
    chatDir: string;
    chatMd: string;
    decisionsMd: string;
    budget: string;
    inboxDir: string;
    lock: string;
    inbox(agent: AgentId): string;
    /** `inbox/<agent>.lock/`: held by the one live MCP server acting as `agent` on this goal (PROTOCOL.md 10). */
    lease(agent: AgentId): string;
}
export declare function vaultPaths(projectDir: string, config: DiarchyConfig): VaultPaths;
/** Every path in the PROTOCOL.md section 2 layout for one goal. */
export declare function resolveVaultPaths(projectDir: string, config: DiarchyConfig, goalId: string): GoalPaths;
