/**
 * End-to-end: the `diarchy` CLI driven as a subprocess against temp git
 * repos, with the fake PM standing in for both CLIs (no model calls).
 *
 * The CLI runs from source via `node --import tsx src/cli/index.ts` so the file
 * needs no build step; `npm test -- e2e` selects it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { humanCommand } from "../src/cli/hooks.js";
import { parseGoalState, type GoalState } from "../src/protocol/index.js";
import { GENERATED, VaultStore, loadConfig, type GoalPaths } from "../src/vault/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const RUN_TIMEOUT = 45_000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "diarchy e2e",
  GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "diarchy e2e",
  GIT_COMMITTER_EMAIL: "e2e@example.invalid",
};

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI from source; stdin is always closed so hook commands see end-of-input. */
function cli(args: string[], options: { input?: string } = {}): Promise<Run> {
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
    child.stdin.end(options.input ?? "");
  });
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(name: string, withGit = true): string {
  const root = mkdtempSync(join(tmpdir(), "diarchy-e2e-"));
  temps.push(root);
  const dir = join(root, name);
  mkdirSync(dir);
  if (withGit) {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

interface Config {
  vault: string;
  launcher: Record<string, number>;
  [key: string]: unknown;
}

function readConfig(dir: string): Config {
  return JSON.parse(readFileSync(join(dir, "diarchy.config.json"), "utf8")) as Config;
}

/** `diarchy init`, then make the supervisor poll fast so the test stays short. */
async function initProject(name: string, withGit = true): Promise<string> {
  const dir = makeProject(name, withGit);
  const init = await cli(["init", "--project", dir]);
  expect(init.code, init.stderr).toBe(0);
  const config = readConfig(dir);
  config.launcher = { ...config.launcher, poll_ms: 100, restart_backoff_ms: 200, stop_grace_ms: 3000 };
  writeFileSync(join(dir, "diarchy.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

function human(dir: string): VaultStore {
  return new VaultStore({ projectDir: dir, config: loadConfig(dir), agent: "human", pollIntervalMs: 20 });
}

function goalPaths(dir: string): GoalPaths {
  const goals = human(dir).listGoals();
  const goal = goals[goals.length - 1];
  if (goal === undefined) throw new Error(`no goal in ${dir}`);
  return goal.paths;
}

function goalState(dir: string): GoalState {
  return parseGoalState(JSON.parse(readFileSync(goalPaths(dir).budget, "utf8")));
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe("diarchy init", () => {
  it("creates the config and vault, ignores .diarchy/, prints next steps, and refuses to overwrite without --force", async () => {
    const dir = makeProject("api");
    const first = await cli(["init", "--project", dir]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Next steps");
    expect(first.stdout).toContain("claude plugin install diarchy");
    expect(first.stdout).toContain("codex plugin marketplace add");
    expect(first.stdout).not.toContain(String.fromCharCode(0x2014));
    const configPath = join(dir, "diarchy.config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = readConfig(dir);
    expect(config.protocol_version).toBe(1);
    expect(config.vault).toBe(join("api brain", "diarchy"));
    expect(existsSync(join(dir, "api brain", "diarchy"))).toBe(true);
    expect(config.agents).toMatchObject({
      claude: {
        command: "claude",
        args: ["-p", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", "mcp__plugin_diarchy_diarchy__*,Bash(git *),Bash(npm *),Bash(node *),Bash(gh *)"],
      },
      codex: { command: "codex", args: ["exec", "--sandbox", "workspace-write"] },
    });
    expect(config.budgets).toMatchObject({ plan_messages: 12, messages_total: 80, wall_clock_minutes: 240, spend_usd: null });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".diarchy/\n");
    expect(loadConfig(dir).vault).toBe(config.vault);

    const before = readFileSync(configPath, "utf8");
    const second = await cli(["init", "--project", dir]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("--force");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(readFileSync(join(dir, ".gitignore"), "utf8").match(/\.diarchy\//g)).toHaveLength(1);

    const forced = await cli(["init", "--project", dir, "--force", "--vault", "notes/diarchy"]);
    expect(forced.code).toBe(0);
    expect(readConfig(dir).vault).toBe("notes/diarchy");
    expect(existsSync(join(dir, "notes", "diarchy"))).toBe(true);
  });

  it("rejects fewer than two agents", async () => {
    const dir = makeProject("solo", false);
    const result = await cli(["init", "--project", dir, "--agents", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("at least two");
  });
});

// ---------------------------------------------------------------------------
// start --driver fake, good mode
// ---------------------------------------------------------------------------

describe("start --driver fake (good)", () => {
  let dir = "";
  let run: Run;
  let state: GoalState;
  let paths: GoalPaths;

  beforeAll(async () => {
    dir = await initProject("widget");
    run = await cli([
      "start",
      "Ship the fake widget",
      "--ac",
      "The widget renders.",
      "--ac",
      "The widget has a test.",
      "--lead",
      "claude",
      "--driver",
      "fake",
      "--fake-mode",
      "good",
      "--project",
      dir,
    ]);
    paths = goalPaths(dir);
    state = goalState(dir);
  }, RUN_TIMEOUT);

  it("exits 0 with the goal DONE in at most 20 messages", () => {
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(state.phase).toBe("DONE");
    expect(state.messages.length).toBeLessThanOrEqual(20);
    expect(readdirSync(paths.chatDir).filter((name) => name.endsWith(".md"))).toHaveLength(state.messages.length);
    expect(state.messages.map((message) => message.type)).toContain("DONE");
    expect(Object.values(state.acs).every((ac) => ac.status === "passing")).toBe(true);
    expect(Object.values(state.tasks).filter((task) => task.kind === "implement").every((task) => task.status === "done")).toBe(true);
    expect(run.stdout).toMatch(/\bDONE\b/);
    expect(run.stdout).toContain("kickoff 20");
    expect(run.stderr).not.toContain("rejected");
    expect(existsSync(join(dir, ".diarchy", "start.pid"))).toBe(false);
  });

  it("created one worktree per agent on diarchy/<goal-id>/<agent> with the fake work committed", () => {
    for (const agent of ["claude", "codex"]) {
      const worktree = join(dir, ".diarchy", "worktrees", agent);
      expect(existsSync(worktree)).toBe(true);
      expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`diarchy/${paths.goalId}/${agent}`);
      expect(lines(git(worktree, "log", "--oneline"))).toHaveLength(2);
    }
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).not.toMatch(/^diarchy\//);
  });

  it("rendered chat.md, decisions.md, and goal.md with the right first lines", () => {
    expect(readFileSync(paths.chatMd, "utf8").split("\n").slice(0, 2)).toEqual([GENERATED, `# Chat: ${paths.goalId}`]);
    expect(readFileSync(paths.decisionsMd, "utf8").split("\n").slice(0, 2)).toEqual([GENERATED, `# Decisions: ${paths.goalId}`]);
    expect(readFileSync(paths.goalMd, "utf8").split("\n").slice(0, 2)).toEqual([GENERATED, `# ${paths.goalId}`]);
    expect(readFileSync(paths.goalMd, "utf8")).toContain("| DONE | claude | codex |");
  });

  it("status --json reports DONE and no human action", async () => {
    const result = await cli(["status", "--json", "--project", dir]);
    expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout) as { goal: string; phase: string; human_needed: boolean; reply_command: string | null; message_count: number };
    expect(status).toMatchObject({ goal: paths.goalId, phase: "DONE", human_needed: false, reply_command: null });
    expect(status.message_count).toBe(state.messages.length);
    const text = await cli(["status", "--project", dir]);
    expect(text.stdout).toContain("DONE");
    expect(text.stdout).not.toContain("diarchy reply");
  });

  it("watch (non-follow) prints one header line per message and exits on DONE", async () => {
    const result = await cli(["watch", "--project", dir]);
    expect(result.code).toBe(0);
    const headers = lines(result.stdout).filter((line) => !line.startsWith("#"));
    expect(headers).toHaveLength(state.messages.length);
    state.messages.forEach((message, index) => {
      expect(headers[index]).toContain(` · ${message.type} · `);
      expect(headers[index]).toContain(`${message.from} → `);
    });
    expect(lines(result.stdout)[lines(result.stdout).length - 1]).toBe("# DONE");
  });

  it("start without a goal text fails once no goal is active", async () => {
    const result = await cli(["start", "--driver", "fake", "--project", dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("goal is required");
  });
});

// ---------------------------------------------------------------------------
// start --driver fake, slop mode
// ---------------------------------------------------------------------------

describe("start --driver fake (slop)", () => {
  let dir = "";
  let run: Run;
  let state: GoalState;
  let paths: GoalPaths;

  beforeAll(async () => {
    dir = await initProject("ratelimit");
    run = await cli([
      "start",
      "Add per-API-key rate limiting",
      "--ac",
      "Requests over the limit get 429.",
      "--ac",
      "The limit is configurable.",
      "--lead",
      "claude",
      "--driver",
      "fake",
      "--fake-mode",
      "slop",
      "--no-worktrees",
      "--project",
      dir,
    ]);
    paths = goalPaths(dir);
    state = goalState(dir);
  }, RUN_TIMEOUT);

  it("exits 2 with the goal BLOCKED by deadlock and a system ASK_HUMAN on disk", () => {
    expect(run.code, run.stdout + run.stderr).toBe(2);
    expect(state.phase).toBe("BLOCKED");
    expect(state.blocked_from).toBe("PLAN");
    const files = readdirSync(paths.chatDir);
    expect(files.some((name) => name.endsWith("-system-ASK_HUMAN.md"))).toBe(true);
    expect(run.stdout).toContain("worktrees skipped (--no-worktrees)");
    expect(run.stdout).toContain("BLOCKED");
    expect(existsSync(join(dir, ".diarchy", "worktrees"))).toBe(false);
  });

  it("the fake PMs logged the rejections the protocol produced", () => {
    expect(run.stderr).toContain("rejected NO_ACK");
    expect(run.stderr).toContain("rejected CHALLENGE_NEEDS_TEST");
    // The lead's second PROPOSE on D1 loses to TWO_ROUNDS, or to PHASE_GATE when the
    // challenger's STATUS trips the deadlock first; which one wins is a lock race.
    expect(run.stderr).toMatch(/rejected (TWO_ROUNDS|PHASE_GATE)/);
    expect(run.stderr).not.toContain("expected ");
    const accepted = state.messages.map((message) => `${message.from}:${message.type}`);
    expect(accepted).toEqual([
      "human:KICKOFF",
      "claude:PROPOSE",
      "codex:CHALLENGE",
      "claude:PROPOSE",
      "codex:STATUS",
      "system:ASK_HUMAN",
    ]);
  });

  it("status tells the human to run diarchy reply, and reply moves the phase back to PLAN", async () => {
    const status = await cli(["status", "--project", dir]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("human needed: deadlock on plan");
    // D1 is still open, so a ruling on plan would be rejected by PHASE_GATE; the hint must not suggest --decision plan.
    expect(status.stdout).toContain('diarchy reply "<ruling>"');
    expect(status.stdout).not.toContain("--decision plan");
    const json = JSON.parse((await cli(["status", "--json", "--project", dir])).stdout) as { human_needed: boolean; reply_command: string };
    expect(json.human_needed).toBe(true);
    expect(json.reply_command).toContain("diarchy reply");

    const reply = await cli(["reply", "Use the Redis bucket.", "--project", dir]);
    expect(reply.code, reply.stderr).toBe(0);
    expect(reply.stdout).toMatch(/^posted \S+-human-DECIDE · D\d+ · phase PLAN$/m);
    const after = goalState(dir);
    expect(after.phase).toBe("PLAN");
    expect(after.deadlock_watch).toBeNull();
    const again = await cli(["status", "--json", "--project", dir]);
    expect((JSON.parse(again.stdout) as { phase: string }).phase).toBe("PLAN");
  });

  it("reply rejects an unknown budget key with the schema problem", async () => {
    const result = await cli(["reply", "Carry on.", "--budget", "bogus=3", "--project", dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid --budget");
  });
});

// ---------------------------------------------------------------------------
// Hooks: guard (PreToolUse)
// ---------------------------------------------------------------------------

describe("guard", () => {
  const event = (command: string): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  it("recognises the human's commands however a shell spells them, and nothing else", () => {
    expect(humanCommand('diarchy reply "continue" --budget messages_total=200')).toBe("reply");
    expect(humanCommand("DIARCHY_AGENT=claude node bin/diarchy.js reply continue")).toBe("reply");
    expect(humanCommand("cd /p && npx diarchy stop --reason done")).toBe("stop");
    expect(humanCommand("node --import tsx /abs/bin/diarchy.js --project /p stop")).toBe("stop");
    expect(humanCommand('diarchy --project=/p reply "x"; echo done')).toBe("reply");
    expect(humanCommand("./node_modules/.bin/diarchy reply ok")).toBe("reply");
    expect(humanCommand("diarchy status; diarchy watch --follow")).toBeNull();
    expect(humanCommand('grep -rn "diarchy reply" docs/')).toBeNull();
    expect(humanCommand('echo "run diarchy stop later"')).toBeNull();
    expect(humanCommand("npm test -- vault")).toBeNull();
    expect(humanCommand("git stop")).toBeNull();
    expect(humanCommand("")).toBeNull();
  });

  it("denies a Bash call to diarchy reply with a PreToolUse decision and lets everything else through", async () => {
    const denied = await cli(["guard", "--agent", "claude"], { input: event('diarchy reply "continue" --budget messages_total=200') });
    expect(denied.code).toBe(0);
    expect(denied.stderr).toBe("");
    const decision = JSON.parse(denied.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(decision.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("diarchy reply posts as the human");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("wait_for_reply");
    const stop = await cli(["guard", "--agent", "codex"], { input: event("node bin/diarchy.js stop --reason enough") });
    expect(JSON.parse(stop.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await cli(["guard", "--agent", "codex"], { input: event("npm test") })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await cli(["guard", "--agent", "codex"], { input: "not json {{{" })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await cli(["guard", "--agent", "codex"], { input: "" })).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

// ---------------------------------------------------------------------------
// Hooks: inbox-skim and gate
// ---------------------------------------------------------------------------

describe("inbox-skim and gate", () => {
  let dir = "";
  let claude: VaultStore;
  let codex: VaultStore;
  let proposeId = "";

  beforeAll(async () => {
    dir = await initProject("hooks", false);
    const config = loadConfig(dir);
    const make = (agent: string) => new VaultStore({ projectDir: dir, config, agent, pollIntervalMs: 20 });
    claude = make("claude");
    codex = make("codex");
  });

  it("prints nothing and exits 0 with no goal", async () => {
    const skim = await cli(["inbox-skim", "--agent", "codex", "--project", dir]);
    expect(skim).toEqual({ code: 0, stdout: "", stderr: "" });
    const gate = await cli(["gate", "--agent", "codex", "--project", dir], { input: '{"session_id":"s"}' });
    expect(gate).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("inbox-skim briefs the challenger mid-run without moving its cursor", async () => {
    const kick = await human(dir).kickoff({
      goal: "Rate limit the API.",
      acceptance_criteria: ["Over-limit requests get 429.", "Limit is configurable."],
      lead: "claude",
      slug: "rl",
    });
    expect(kick.ok).toBe(true);
    const propose = await claude.post({
      type: "PROPOSE",
      to: "all",
      re: ["AC1", "AC2"],
      decision_id: "plan",
      claim: "A Redis token bucket satisfies both criteria.",
      body: "Two tasks: middleware and config.",
    });
    if (!propose.ok) throw new Error(propose.message);
    proposeId = propose.id;

    const skim = await cli(["inbox-skim", "--agent", "codex", "--project", dir]);
    expect(skim.code).toBe(0);
    const out = lines(skim.stdout);
    expect(out.length).toBeLessThanOrEqual(15);
    expect(out[0]).toContain("goal 20");
    expect(out[0]).toContain("-rl");
    expect(out[0]).toContain("phase PLAN");
    expect(out[0]).toContain("you are codex (challenger)");
    expect(out[1]).toMatch(/^budget: 1 of 80 messages \(PLAN 1 of 12\)/);
    expect(skim.stdout).toContain("unread: 2 messages");
    expect(skim.stdout).toContain(" · KICKOFF · ");
    expect(skim.stdout).toContain("claude → all · PROPOSE · plan · re AC1, AC2 · ");
    expect(out[out.length - 1]).toMatch(/^next: 2 unread messages: call read/);
    expect(existsSync(goalPaths(dir).inbox("codex"))).toBe(false);

    const read = codex.read();
    expect(read?.messages).toHaveLength(2);
    const cursorFile = goalPaths(dir).inbox("codex");
    const before = readFileSync(cursorFile, "utf8");
    const again = await cli(["inbox-skim", "--agent", "codex", "--project", dir]);
    expect(again.stdout).toContain("unread: 0 messages");
    expect(again.stdout).toContain("next: the plan PROPOSE is open: post one CHALLENGE with a test");
    expect(readFileSync(cursorFile, "utf8")).toBe(before);
  });

  it("gate blocks on unread messages, lets a caught-up challenger go, and survives garbage stdin", async () => {
    const lead = await cli(["gate", "--agent", "claude", "--project", dir], { input: "not json {{{" });
    expect(lead.code).toBe(0);
    const decision = JSON.parse(lead.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("1 unread message");
    expect(decision.reason).toContain("call read");

    const challenger = await cli(["gate", "--agent", "codex", "--project", dir], { input: '{"session_id":"s","stop_hook_active":false}' });
    expect(challenger).toEqual({ code: 0, stdout: "", stderr: "" });

    claude.read();
    const caughtUp = await cli(["gate", "--agent", "claude", "--project", dir], { input: "{}" });
    expect(caughtUp.stdout).toBe("");
  });

  it("gate blocks the lead while a CHALLENGE awaits DECIDE, until the 12-block cap", async () => {
    const challenge = await codex.post({
      type: "CHALLENGE",
      to: "claude",
      re: ["AC1"],
      reply_to: proposeId,
      decision_id: "plan",
      claim: "An in-process bucket suffices while the API runs one replica.",
      evidence: [{ kind: "test", test: "kubectl get deploy api prints replicas 1", result: "pending" }],
    });
    if (!challenge.ok) throw new Error(challenge.message);
    claude.read();

    const blocked = await cli(["gate", "--agent", "claude", "--project", dir], { input: "{}" });
    const decision = JSON.parse(blocked.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("CHALLENGE from codex awaiting your DECIDE");
    expect(decision.reason).toContain("call decide");

    const skim = await cli(["inbox-skim", "--agent", "claude", "--project", dir]);
    expect(skim.stdout).toContain("you are claude (lead)");
    expect(skim.stdout).toContain("next: thread plan has a CHALLENGE");

    const record = join(dir, ".diarchy", "gate-claude.json");
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ blocks: 1, last_message_id: challenge.id });
    writeFileSync(record, JSON.stringify({ blocks: 11, last_message_id: challenge.id, updated: "" }));
    const twelfth = await cli(["gate", "--agent", "claude", "--project", dir], { input: "{}" });
    expect(twelfth.stdout).toContain('"decision":"block"');
    const thirteenth = await cli(["gate", "--agent", "claude", "--project", dir], { input: "{}" });
    expect(thirteenth).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ blocks: 12 });
  });
});
