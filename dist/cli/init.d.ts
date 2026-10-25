export interface InitOptions {
    vault?: string;
    agents?: string;
    force?: boolean;
}
export declare function buildConfig(projectDir: string, agentIds: string[], vault: string): Record<string, unknown>;
export declare function runInit(projectDir: string, options: InitOptions): number;
