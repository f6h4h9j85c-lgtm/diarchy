/**
 * The fake PM under a non-default `worktrees` config: its ASSIGNs must name the
 * worktree and branch the launcher created from `worktrees.root` and
 * `branch_prefix`, not the built-in defaults (audit finding F096).
 *
 * Runs `diarchy start --driver fake` from source against a temp git repo, as
 * test/e2e.test.ts does.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("start --driver fake with a non-default worktrees config", () => {
  let tmp = "";
  let dir = "";
  let run: { code: number; stdout: string; stderr: string };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "diarchy-wt-"));
    dir = join(tmp, "gadget");
    mkdirSync(dir);
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "# gadget\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    const init = await cli(["init", "--project", dir]);
    expect(init.code, init.stderr).toBe(0);
    const configPath = join(dir, "diarchy.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown> & { launcher?: Record<string, number> };
    config.worktrees = WORKTREES;
    config.launcher = { ...config.launcher, poll_ms: 100, restart_backoff_ms: 200, stop_grace_ms: 3000 };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    run = await cli(["start", "Ship the fake gadget", "--ac", "The gadget renders.", "--lead", "claude", "--driver", "fake", "--fake-mode", "good", "--project", dir]);
  }, 45_000);

  afterAll(() => {
    if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  });

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
