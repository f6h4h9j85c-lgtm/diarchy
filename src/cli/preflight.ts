/**
 * Checks `diarchy start` runs before it kicks off a goal, so a launch that
 * cannot work fails with a message instead of an idle goal.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

import type { DriverName } from "./drivers.js";
import type { AgentLaunch } from "./launcher-config.js";

/**
 * The launcher is POSIX-only: it stops its PMs with signals and spawns `claude`
 * and `codex` by bare name, neither of which works on native Windows.
 */
export function platformProblem(platform: NodeJS.Platform, driver: DriverName): string | null {
  if (platform !== "win32" || driver !== "real") return null;
  return "diarchy start --driver real runs on Linux and macOS only; native Windows is untested and unsupported, so run it under WSL";
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The file spawn() would run for `command` in a child whose working directory
 * is `cwd`, else null. As in execvp, which runs after the child's chdir, a
 * command with a "/" and every relative or empty PATH entry resolve against
 * `cwd`, not against this process's working directory.
 */
export function findExecutable(command: string, cwd: string, pathEnv: string | undefined): string | null {
  if (command.includes("/")) {
    const path = resolve(cwd, command);
    return isExecutableFile(path) ? path : null;
  }
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    // resolve() skips an empty entry, so it names `cwd` as execvp does.
    const path = resolve(cwd, dir, command);
    if (isExecutableFile(path)) return path;
  }
  return null;
}

/** One line per agent whose command cannot be run from `cwdOf(agent)`, naming the config key to fix. */
export function missingCommands(agents: Record<string, AgentLaunch>, cwdOf: (agent: string) => string, pathEnv: string | undefined): string[] {
  return Object.entries(agents)
    .filter(([agent, launch]) => findExecutable(launch.command, cwdOf(agent), pathEnv) === null)
    .map(([agent, launch]) => {
      const { command } = launch;
      const where = !command.includes("/") ? " on PATH" : isAbsolute(command) ? "" : ` in ${cwdOf(agent)}`;
      return `agents.${agent}.command "${command}" is not an executable file${where}`;
    });
}
