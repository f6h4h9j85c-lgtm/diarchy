/**
 * Install surface: what a plugin installer or `git clone` receives must run as
 * is. Claude Code copies the git tree into its plugin cache and installs
 * dependencies with --ignore-scripts, so nothing builds dist/ after checkout.
 * dist/ is therefore committed (CONTRIBUTING.md, "Built output"); this suite
 * fails on a commit that ships without it, and checks the fallback
 * bin/diarchy.js takes when dist/ is missing anyway.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "diarchy-install-"));
  temps.push(dir);
  return dir;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `node <file> ...args` with stdin closed and the given PATH. */
function run(file: string, args: string[], path: string): Run {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: path },
    input: "",
    timeout: 15_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("install: the committed tree", () => {
  it("git archive HEAD, then node bin/diarchy.js --version exits 0: dist/ is committed", () => {
    const dir = temp();
    const tar = join(dir, "head.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], { cwd: ROOT });
    const tree = join(dir, "tree");
    mkdirSync(tree);
    execFileSync("tar", ["-xf", tar, "-C", tree]);
    // The plugin cache has node_modules (the installer runs npm install --ignore-scripts); the archive does not.
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");

    const result = run(join(tree, "bin", "diarchy.js"), ["--version"], process.env.PATH ?? "");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});

describe("install: bin/diarchy.js without dist/", () => {
  /** A copy of bin/diarchy.js in a root that has no dist/. */
  function binWithoutDist(): string {
    const root = temp();
    mkdirSync(join(root, "bin"));
    cpSync(join(ROOT, "bin", "diarchy.js"), join(root, "bin", "diarchy.js"));
    return join(root, "bin", "diarchy.js");
  }

  it("runs the diarchy on PATH with the same arguments, stdout, and exit code", () => {
    const fakeBin = temp();
    writeFileSync(join(fakeBin, "diarchy"), `#!/bin/sh\nprintf '%s\\n' "fake-diarchy $*"\nexit 3\n`);
    chmodSync(join(fakeBin, "diarchy"), 0o755);

    const result = run(binWithoutDist(), ["gate", "--agent", "claude"], `${fakeBin}${delimiter}${process.env.PATH ?? ""}`);
    expect(result.stdout).toBe("fake-diarchy gate --agent claude\n");
    expect(result.stderr).toMatch(/dist\/ is missing .* running .*\/diarchy instead/);
    expect(result.code).toBe(3);
  });

  it("says what to do, instead of an ERR_MODULE_NOT_FOUND stack, when no diarchy is on PATH", () => {
    const result = run(binWithoutDist(), ["--version"], temp());
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^diarchy: .*dist\/ is missing\. Run `npm ci && npm run build`/);
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("does not recurse when the diarchy on PATH links back to itself", () => {
    const bin = binWithoutDist();
    const fakeBin = temp();
    symlinkSync(bin, join(fakeBin, "diarchy"));

    const result = run(bin, ["--version"], fakeBin);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/dist\/ is missing\. Run/);
    expect(result.stderr).not.toContain("instead");
  });
});
