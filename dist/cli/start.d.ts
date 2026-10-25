import { type KickoffCliOptions } from "./kickoff.js";
export interface StartOptions extends KickoffCliOptions {
    driver: string;
    fakeScript?: string;
    fakeMode?: string;
    /** commander: `--no-worktrees` sets this to false. */
    worktrees: boolean;
}
export declare function runStart(projectDir: string, goalText: string | undefined, options: StartOptions): Promise<number>;
