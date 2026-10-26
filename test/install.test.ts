/**
 * Install surface: what a plugin installer or `git clone` receives must run as
 * is. Claude Code copies the git tree into its plugin cache and installs
 * dependencies with --ignore-scripts, so nothing builds dist/ after checkout.
 * dist/ is therefore committed (CONTRIBUTING.md, "Built output"); this suite
 * fails on a commit that ships without it, and checks the fallback
 * bin/diarchy.js takes when dist/ is missing anyway. Codex copies the git tree
 * and installs no dependencies at all, so its plugin copy has dist/ but no
 * node_modules; the same fallback must carry the bin and the three hooks there.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

/** This process's environment with the given PATH and none of the variables that redirect bin/diarchy.js or the hooks. */
function envWith(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  delete env.DIARCHY_BIN;
  delete env.DIARCHY_FALLBACK_FROM;
  return env;
}

/** Run `node <file> ...args` with stdin closed and the given PATH. */
function run(file: string, args: string[], path: string): Run {
  const result = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: envWith(path), input: "", timeout: 15_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** An executable `diarchy` stand-in in a fresh directory: prints `prefix` and its arguments, then exits with `code`. */
function stubDiarchy(prefix: string, code = 0): string {
  const dir = temp();
  writeFileSync(join(dir, "diarchy"), `#!/bin/sh\nprintf '%s%s\\n' '${prefix}' "$*"\nexit ${code}\n`);
  chmodSync(join(dir, "diarchy"), 0o755);
  return dir;
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

describe("install: a Codex plugin copy, which has dist/ but no node_modules", () => {
  /**
   * The tracked tree as this checkout has it, which is what Codex copies into
   * its plugin cache: it git-clones the marketplace and installs nothing.
   */
  function trackedTreeWithoutNodeModules(): string {
    const tree = temp();
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((file) => file !== "");
    for (const file of files) {
      if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(tree, file), { recursive: true });
    }
    expect(existsSync(join(tree, "dist", "cli", "index.js"))).toBe(true);
    expect(existsSync(join(tree, "node_modules"))).toBe(false);
    return tree;
  }

  /** A PATH directory holding only what the hook scripts call (node, cat, dirname): no diarchy. */
  function toolsOnly(): string {
    const dir = temp();
    symlinkSync(process.execPath, join(dir, "node"));
    for (const tool of ["cat", "dirname"]) {
      symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(dir, tool));
    }
    return dir;
  }

  const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const event = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "diarchy reply go" } });
  const hooks = ["session-start.sh", "pre-tool-guard.sh", "stop-gate.sh"];

  /** `bash <tree>/hooks/<script> codex`, as hooks/codex-hooks.json runs it, from a directory outside the tree. */
  function runHook(tree: string, script: string, path: string): Run {
    const result = spawnSync(bash, [join(tree, "hooks", script), "codex"], { cwd: temp(), encoding: "utf8", env: envWith(path), input: event, timeout: 15_000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  let tree = "";
  let tools = "";
  beforeAll(() => {
    tree = trackedTreeWithoutNodeModules();
    tools = toolsOnly();
  });

  const MISSING = /^diarchy: .* is missing its dependencies \(package 'commander' not found; a Codex plugin install copies no node_modules\)\. Install the CLI with `npm install -g github:f6h4h9j85c-lgtm\/diarchy`/;

  it("bin/diarchy.js runs the diarchy on PATH with the same arguments, stdout, and exit code, and says nothing", () => {
    const result = run(join(tree, "bin", "diarchy.js"), ["gate", "--agent", "codex"], `${stubDiarchy("fake-diarchy ", 3)}${delimiter}${tools}`);
    expect(result.stdout).toBe("fake-diarchy gate --agent codex\n");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(3);
  });

  it("each hook script runs its diarchy command as codex through the diarchy on PATH", () => {
    // The `{` prefix: stop-gate.sh and pre-tool-guard.sh forward only what looks like a JSON object.
    const path = `${stubDiarchy("{ ")}${delimiter}${tools}`;
    for (const script of hooks) {
      const result = runHook(tree, script, path);
      expect(result.stderr, script).toBe("");
      expect(result.code, script).toBe(0);
      expect(result.stdout, script).toMatch(/^\{ (inbox-skim|guard|gate) --agent codex\n$/);
    }
  });

  it("bin/diarchy.js with no diarchy on PATH says to npm install -g on one stderr line and exits 1", () => {
    const result = run(join(tree, "bin", "diarchy.js"), ["--version"], tools);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(MISSING);
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("each hook script with no diarchy on PATH fails visibly: the error on stderr, exit 1 (never the deny code 2), nothing on stdout", () => {
    for (const script of hooks) {
      const result = runHook(tree, script, tools);
      expect(result.stdout, script).toBe("");
      expect(result.code, script).toBe(1);
      expect(result.stderr, script).toMatch(MISSING);
    }
  });

  it("two copies without dependencies on PATH do not hand the run back and forth", () => {
    // B: a second broken copy whose dist/ imports a package that is not installed.
    const other = temp();
    mkdirSync(join(other, "bin"));
    mkdirSync(join(other, "dist", "cli"), { recursive: true });
    cpSync(join(ROOT, "bin", "diarchy.js"), join(other, "bin", "diarchy.js"));
    chmodSync(join(other, "bin", "diarchy.js"), 0o755);
    writeFileSync(join(other, "dist", "cli", "index.js"), 'import "diarchy-not-installed";\n');
    chmodSync(join(tree, "bin", "diarchy.js"), 0o755);
    const [first, second] = [temp(), temp()];
    symlinkSync(join(tree, "bin", "diarchy.js"), join(first, "diarchy"));
    symlinkSync(join(other, "bin", "diarchy.js"), join(second, "diarchy"));

    const result = run(join(tree, "bin", "diarchy.js"), ["--version"], [first, second, tools].join(delimiter));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^diarchy: .* is missing its dependencies \(package 'diarchy-not-installed' not found/);
  });
});
