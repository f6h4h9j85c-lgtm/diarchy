/** `diarchy kickoff`: the human starts a goal through the store. `start` reuses the option parsing. */
import type { KickoffInput } from "../vault/index.js";
export interface KickoffCliOptions {
    ac: string[];
    lead?: string;
    budget: string[];
    slug?: string;
    json?: boolean;
}
/** Validate the positional goal plus flags into the store's KickoffInput. */
export declare function kickoffInput(goal: string | undefined, options: KickoffCliOptions): KickoffInput;
export declare function runKickoff(projectDir: string, goal: string | undefined, options: KickoffCliOptions): Promise<number>;
