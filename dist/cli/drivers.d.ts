import type { AgentLaunch } from "./launcher-config.js";
export type DriverName = "real" | "fake";
export interface SpawnPlan {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** True when the plan resumes a previous session. */
    resumed: boolean;
}
export interface SessionRecord {
    agent: string;
    goal: string;
    session_id: string;
    source: "minted" | "captured";
    updated: string;
}
export declare function sessionPath(projectDir: string, agent: string): string;
/** The saved session for this agent, only when it belongs to the same goal. */
export declare function loadSession(projectDir: string, agent: string, goalId: string): SessionRecord | null;
export declare function saveSession(projectDir: string, record: SessionRecord): void;
export declare function clearSession(projectDir: string, agent: string): void;
/** The session or thread id a CLI printed on this line, if any. */
export declare function detectSessionId(line: string): string | null;
export declare function buildPrompt(agent: string, goalId: string): string;
export type Flavor = "claude" | "codex" | "generic";
export declare function flavorOf(command: string): Flavor;
export interface RealPlanInput {
    projectDir: string;
    agent: string;
    goalId: string;
    launch: AgentLaunch;
    cwd: string;
    worktree: string | null;
    session: SessionRecord | null;
}
export interface RealPlan extends SpawnPlan {
    flavor: Flavor;
    /** A session the launcher minted for this spawn (claude) that must be saved. */
    minted: SessionRecord | null;
}
export declare function realPlan(input: RealPlanInput): RealPlan;
export interface FakePlanInput {
    projectDir: string;
    agent: string;
    goalId: string;
    cwd: string;
    worktree: string | null;
    script: string;
    mode: string;
}
/** `src/cli/fake-pm.ts` when running from source (needs tsx), `dist/cli/fake-pm.js` from the build. */
export declare function defaultFakeScript(): string;
export declare function fakePlan(input: FakePlanInput): SpawnPlan;
