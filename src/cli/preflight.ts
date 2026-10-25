/**
 * Checks `diarchy start` runs before it kicks off a goal, so a launch that
 * cannot work fails with a message instead of an idle goal.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

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

/** Where `command` resolves the way spawn() resolves it (a path as is, a bare name on PATH), else null. */
export function findExecutable(command: string, cwd: string, pathEnv: string | undefined): string | null {
  if (command.includes("/")) {
    const path = isAbsolute(command) ? command : resolve(cwd, command);
    return isExecutableFile(path) ? path : null;
  }
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, command);
    if (isExecutableFile(path)) return path;
  }
  return null;
}

/** One line per agent whose command cannot be run, naming the config key to fix. */
export function missingCommands(agents: Record<string, AgentLaunch>, cwd: string, pathEnv: string | undefined): string[] {
  return Object.entries(agents)
    .filter(([, launch]) => findExecutable(launch.command, cwd, pathEnv) === null)
    .map(([agent, launch]) => `agents.${agent}.command "${launch.command}" is not an executable file${launch.command.includes("/") ? "" : " on PATH"}`);
}
