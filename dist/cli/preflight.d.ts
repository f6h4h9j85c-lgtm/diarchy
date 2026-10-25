import type { DriverName } from "./drivers.js";
import type { AgentLaunch } from "./launcher-config.js";
/**
 * The launcher is POSIX-only: it stops its PMs with signals and spawns `claude`
 * and `codex` by bare name, neither of which works on native Windows.
 */
export declare function platformProblem(platform: NodeJS.Platform, driver: DriverName): string | null;
/**
 * The file spawn() would run for `command` in a child whose working directory
 * is `cwd`, else null. As in execvp, which runs after the child's chdir, a
 * command with a "/" and every relative or empty PATH entry resolve against
 * `cwd`, not against this process's working directory.
 */
export declare function findExecutable(command: string, cwd: string, pathEnv: string | undefined): string | null;
/** One line per agent whose command cannot be run from `cwdOf(agent)`, naming the config key to fix. */
export declare function missingCommands(agents: Record<string, AgentLaunch>, cwdOf: (agent: string) => string, pathEnv: string | undefined): string[];
