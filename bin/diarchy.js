#!/usr/bin/env node
// The `diarchy` command. dist/ is committed (see CONTRIBUTING.md) because a
// plugin install copies the git tree and runs no build, and the MCP server and
// both hooks start through this file. When dist/ is missing anyway, run a
// `diarchy` installed on PATH (npm install -g) with the same arguments, or say
// what to do; a raw ERR_MODULE_NOT_FOUND stack is not a useful error for either.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/cli/index.js", import.meta.url);

/** The first executable `name` on PATH that is not this file, so a global link back to a dist-less checkout cannot recurse. */
function findOnPath(name, self) {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const candidate of names) {
      const file = join(dir, candidate);
      try {
        const real = realpathSync(file);
        if (real !== self && statSync(real).isFile()) return file;
      } catch {
        // not there, or not resolvable: keep looking
      }
    }
  }
  return null;
}

if (existsSync(entry)) {
  await import(entry.href);
} else {
  const self = realpathSync(fileURLToPath(import.meta.url));
  const fallback = findOnPath("diarchy", self);
  if (fallback === null) {
    const root = fileURLToPath(new URL("..", import.meta.url));
    console.error(
      `diarchy: ${root}dist/ is missing. Run \`npm ci && npm run build\` there (or \`git checkout -- dist\`), or install the CLI with \`npm install -g github:f6h4h9j85c-lgtm/diarchy\`.`,
    );
    process.exit(1);
  }
  console.error(`diarchy: dist/ is missing next to ${self}; running ${fallback} instead`);
  const child = spawn(fallback, process.argv.slice(2), { stdio: "inherit", shell: process.platform === "win32" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`diarchy: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
}
