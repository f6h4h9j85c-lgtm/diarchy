import type { DriverName } from "./drivers.js";
import type { AgentLaunch } from "./launcher-config.js";
/**
 * The launcher is POSIX-only: it stops its PMs with signals and spawns `claude`
 * and `codex` by bare name, neither of which works on native Windows.
 */
export declare function platformProblem(platform: NodeJS.Platform, driver: DriverName): string | null;
/** Where `command` resolves the way spawn() resolves it (a path as is, a bare name on PATH), else null. */
export declare function findExecutable(command: string, cwd: string, pathEnv: string | undefined): string | null;
/** One line per agent whose command cannot be run, naming the config key to fix. */
export declare function missingCommands(agents: Record<string, AgentLaunch>, cwd: string, pathEnv: string | undefined): string[];
