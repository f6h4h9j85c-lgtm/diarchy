/**
 * The fake PM under a non-default `worktrees` config: its ASSIGNs must name the
 * worktree and branch the launcher created from `worktrees.root` and
 * `branch_prefix`, not the built-in defaults (audit finding F096). A
 * `branch_prefix` git rejects stops `diarchy start` before kickoff (F157).
 *
 * Runs `diarchy start --driver fake` from source against a temp git repo, as
 * test/e2e.test.ts does.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VaultStore, loadConfig } from "../src/vault/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "diarchy e2e",
  GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "diarchy e2e",
  GIT_COMMITTER_EMAIL: "e2e@example.invalid",
};
const WORKTREES = { root: ".diarchy/wt", branch_prefix: "pm" };

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
    delete env.DIARCHY_PROJECT;
    delete env.DIARCHY_FAKE_MODE;
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end("");
  });
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const temps: string[] = [];
afterAll(() => {
  for (const tmp of temps.splice(0)) rmSync(tmp, { recursive: true, force: true });
});

interface Config {
  vault: string;
  worktrees?: Record<string, string>;
  launcher?: Record<string, number>;
}

/** A committed git repo after `diarchy init`, with `worktrees` set and fast supervisor knobs; returns the config written. */
async function initProject(name: string, worktrees: Record<string, string>): Promise<{ dir: string; configPath: string; config: Config }> {
  const tmp = mkdtempSync(join(tmpdir(), "diarchy-wt-"));
  temps.push(tmp);
  const dir = join(tmp, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const init = await cli(["init", "--project", dir]);
  expect(init.code, init.stderr).toBe(0);
  const configPath = join(dir, "diarchy.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  config.worktrees = worktrees;
  config.launcher = { ...config.launcher, poll_ms: 100, restart_backoff_ms: 200, stop_grace_ms: 3000 };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { dir, configPath, config };
}

describe("start --driver fake with a non-default worktrees config", () => {
  let dir = "";
  let run: { code: number; stdout: string; stderr: string };

  beforeAll(async () => {
    ({ dir } = await initProject("gadget", WORKTREES));
    run = await cli(["start", "Ship the fake gadget", "--ac", "The gadget renders.", "--lead", "claude", "--driver", "fake", "--fake-mode", "good", "--project", dir]);
  }, 45_000);

  it("reaches DONE with every implement ASSIGN on the configured worktree and branch", () => {
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const store = new VaultStore({ projectDir: dir, config: loadConfig(dir), agent: "human", pollIntervalMs: 20 });
    const state = store.state();
    expect(state?.phase).toBe("DONE");
    const goal = state?.goal ?? "";
    const assigns = store.listMessages().filter((message) => message.type === "ASSIGN" && message.kind === "implement");
    expect(assigns.length).toBeGreaterThan(0);
    for (const message of assigns) {
      expect(message.worktree).toBe(`${WORKTREES.root}/${message.to}`);
      expect(message.branch).toBe(`${WORKTREES.branch_prefix}/${goal}/${message.to}`);
      expect(git(join(dir, WORKTREES.root, message.to), "rev-parse", "--abbrev-ref", "HEAD")).toBe(message.branch);
    }
  });
});

describe("start with a worktrees.branch_prefix git rejects", () => {
  it("exits 1 naming the file and the key before it kicks off, so no goal, worktree, or branch is made", async () => {
    const { dir, configPath, config } = await initProject("trailing-slash", { root: ".diarchy/wt", branch_prefix: "diarchy/" });
    const run = await cli(["start", "Add a hello file", "--ac", "hello.txt exists", "--driver", "fake", "--project", dir]);
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain(`diarchy: ${configPath}: worktrees.branch_prefix: must be a branch name of letters, digits`);
    expect(run.stdout).not.toContain("kickoff");
    expect(existsSync(resolve(dir, config.vault, "goals"))).toBe(false);
    expect(existsSync(join(dir, ".diarchy", "wt"))).toBe(false);
    expect(git(dir, "branch", "--list", "diarchy*")).toBe("");
  }, 45_000);
});
