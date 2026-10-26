export interface InitOptions {
    vault?: string;
    agents?: string;
    force?: boolean;
    /** Launch the Codex PM without its sandbox (`CODEX_FULL_ACCESS_ARGS`). */
    codexFullAccess?: boolean;
}
/** Printed after `diarchy init --codex-full-access` writes the config. */
export declare const CODEX_FULL_ACCESS_WARNING: string;
export declare function buildConfig(projectDir: string, agentIds: string[], vault: string, options?: {
    codexFullAccess?: boolean;
}): Record<string, unknown>;
/** `print` takes the summary and next steps (default: stdout); `diarchy doctor` passes a no-op for its probe projects. */
export declare function runInit(projectDir: string, options: InitOptions, print?: (text: string) => void): number;
