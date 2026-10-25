import { type KickoffCliOptions } from "./kickoff.js";
export interface StartOptions extends KickoffCliOptions {
    driver: string;
    fakeScript?: string;
    fakeMode?: string;
    /** commander: `--no-worktrees` sets this to false. */
    worktrees: boolean;
}
export declare function pidPath(projectDir: string): string;
/** The pid in `.diarchy/start.pid` when that process is still alive. */
export declare function runningSupervisor(projectDir: string): number | null;
export declare function runStart(projectDir: string, goalText: string | undefined, options: StartOptions): Promise<number>;
