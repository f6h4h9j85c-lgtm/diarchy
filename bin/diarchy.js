#!/usr/bin/env node
// The `diarchy` command. dist/ is committed (see CONTRIBUTING.md) because a
// plugin install copies the git tree and runs no build, and the MCP server and
// the three hooks start through this file. Codex also installs no
// dependencies: its plugin cache has dist/ but no node_modules, so importing
// dist/ fails before any of it runs. In both cases (no dist/, or no
// dependencies) run a `diarchy` installed on PATH (npm install -g) with the
// same arguments, or say what to do; a raw ERR_MODULE_NOT_FOUND stack is not a
// useful error for either.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/cli/index.js", import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const self = realpathSync(fileURLToPath(import.meta.url));
const INSTALL = "npm install -g github:f6h4h9j85c-lgtm/diarchy";
/** Realpaths of the bin files that already handed this run on, so two broken copies on PATH cannot spawn each other forever. */
const HANDED_ON = "DIARCHY_FALLBACK_FROM";

/** The first executable `name` on PATH whose realpath is not in `skip`, so a global link back to this copy cannot recurse. */
function findOnPath(name, skip) {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const candidate of names) {
      const file = join(dir, candidate);
      try {
        const real = realpathSync(file);
        if (!skip.includes(real) && statSync(real).isFile()) return file;
      } catch {
        // not there, or not resolvable: keep looking
      }
    }
  }
  return null;
}

/**
 * Run the `diarchy` on PATH with this process's arguments and exit with its
 * code. With none, print `problem` as one line on stderr and exit 1. `notice`,
 * when given, is printed before handing over.
 */
function runFromPath(problem, notice) {
  const before = (process.env[HANDED_ON] ?? "").split(delimiter).filter((path) => path !== "");
  const fallback = findOnPath("diarchy", [self, ...before]);
  if (fallback === null) {
    console.error(`diarchy: ${problem}`);
    process.exit(1);
  }
  if (notice !== undefined) console.error(`diarchy: ${notice}; running ${fallback} instead`);
  const env = { ...process.env, [HANDED_ON]: [...before, self].join(delimiter) };
  const child = spawn(fallback, process.argv.slice(2), { stdio: "inherit", env, shell: process.platform === "win32" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`diarchy: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
}

if (!existsSync(entry)) {
  runFromPath(
    `${root}dist/ is missing. Run \`npm ci && npm run build\` there (or \`git checkout -- dist\`), or install the CLI with \`${INSTALL}\`.`,
    `dist/ is missing next to ${self}`,
  );
} else {
  try {
    await import(entry.href);
  } catch (error) {
    // Resolution fails while linking, before any CLI code runs, so handing the
    // same arguments to another diarchy cannot repeat a side effect.
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const message = String(error.message).split("\n")[0];
    const pkg = /Cannot find package '([^']+)'/.exec(message)?.[1];
    runFromPath(
      pkg !== undefined
        ? `${root} is missing its dependencies (package '${pkg}' not found; a Codex plugin install copies no node_modules). Install the CLI with \`${INSTALL}\` so a \`diarchy\` is on PATH, or run \`npm ci\` in ${root}.`
        : `${root}dist/ is incomplete (${message}). Run \`npm ci && npm run build\` there (or \`git checkout -- dist\`), or install the CLI with \`${INSTALL}\`.`,
    );
  }
}
