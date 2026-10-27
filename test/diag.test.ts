/**
 * The opt-in diagnostics trail (src/cli/diag.ts): `.diarchy/diag` or
 * DIARCHY_DIAG=1 turns it on, DIARCHY_DIAG=0 keeps it off despite the marker,
 * each hook run, MCP server start, and tool result appends one JSON line to
 * `.diarchy/diag.log`, and nothing is written without the switch. The CLI runs from source, as in e2e.test.ts.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { DIAG_LOG, DIAG_MARKER, DIAG_MAX_LINE, diag } from "../src/cli/diag.js";
import { runInit } from "../src/cli/init.js";
import { VERSION } from "../src/index.js";
import { VaultStore, loadConfig } from "../src/vault/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const RUN_TIMEOUT = 60_000;
/** What Codex gives an MCP server besides env_vars (codex-rs/rmcp-client). */
const CODEX_ALLOWLIST = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];
/** A value that must never reach the trail. */
const CANARY = "canary-value-7f3a";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

interface Line {
  event: string;
  agent: string | null;
  project: string;
  project_source: string | null;
  [key: string]: unknown;
}

/** An initialised project with a PLAN goal led by claude, so codex owes a reply; `marker` adds `.diarchy/diag`. */
async function project(marker: boolean): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "diarchy-diag-")));
  temps.push(dir);
  runInit(dir, {}, () => undefined);
  const human = new VaultStore({ projectDir: dir, config: loadConfig(dir), agent: "human" });
  const kicked = await human.kickoff({ goal: "Ship the traced widget.", acceptance_criteria: ["The widget renders."], lead: "claude", slug: "traced" });
  if (!kicked.ok) throw new Error(`${kicked.rule}: ${kicked.message}`);
  if (marker) {
    mkdirSync(join(dir, ".diarchy"), { recursive: true });
    writeFileSync(join(dir, DIAG_MARKER), "");
  }
  return dir;
}

function trail(dir: string): Line[] {
  const path = join(dir, DIAG_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

function cli(args: string[], input: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DIARCHY_TRACE_CANARY: CANARY, ...env };
    delete childEnv.DIARCHY_PROJECT;
    delete childEnv.DIARCHY_DIAG;
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], { cwd: ROOT, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(input);
  });
}

function codexEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CODEX_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, DIARCHY_TRACE_CANARY: CANARY, ...extra };
}

/** Start `diarchy mcp --agent codex` from source the way Codex does (only `env`, from `cwd`), call read, then post `post` and close. */
async function serve(cwd: string, env: Record<string, string>, post?: Record<string, unknown>): Promise<{ goal: unknown; rule: unknown }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", TSX, CLI, "mcp", "--agent", "codex"], cwd, env, stderr: "ignore" });
  const client = new Client({ name: "diag-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const read = await client.callTool({ name: "read", arguments: {} });
    if (post !== undefined) await client.callTool({ name: "post", arguments: post });
    const content = (read.structuredContent ?? {}) as { goal?: unknown; rule?: unknown };
    return { goal: content.goal, rule: content.rule };
  } finally {
    await client.close();
  }
}

describe("diag(): the switch, the size cap, never throwing", () => {
  it("writes nothing without the marker or DIARCHY_DIAG=1, and one line with either", async () => {
    vi.stubEnv("DIARCHY_DIAG", "");
    const dir = await project(false);
    diag({ dir, source: "option" }, "codex", "hook.stop", { decision: "allow" });
    expect(existsSync(join(dir, DIAG_LOG))).toBe(false);

    vi.stubEnv("DIARCHY_DIAG", "1");
    diag({ dir, source: "option" }, "codex", "hook.stop", { decision: "allow" });
    const [line] = trail(dir);
    expect(line).toMatchObject({ event: "hook.stop", agent: "codex", project: dir, project_source: "option", version: VERSION, decision: "allow", pid: process.pid });
    expect(typeof line.node).toBe("string");
  });

  it("DIARCHY_DIAG=0 keeps the trail off even with the marker", async () => {
    vi.stubEnv("DIARCHY_DIAG", "0");
    const dir = await project(true);
    diag({ dir, source: "cwd" }, "claude", "mcp.start");
    expect(existsSync(join(dir, DIAG_LOG))).toBe(false);
    vi.stubEnv("DIARCHY_DIAG", "");
    diag({ dir, source: "cwd" }, "claude", "mcp.start");
    expect(trail(dir)).toHaveLength(1);
  });

  it("cuts a line over 2 KB down to who and what, and never throws on an unwritable project", async () => {
    vi.stubEnv("DIARCHY_DIAG", "1");
    const dir = await project(false);
    diag({ dir }, "claude", "mcp.tool", { tool: "x".repeat(DIAG_MAX_LINE) });
    const [line] = trail(dir);
    expect(line).toMatchObject({ event: "mcp.tool", agent: "claude", truncated: true });
    expect(readFileSync(join(dir, DIAG_LOG), "utf8").length).toBeLessThan(DIAG_MAX_LINE);

    const file = join(dir, "not-a-directory");
    writeFileSync(file, "");
    expect(() => diag({ dir: file }, "claude", "mcp.start")).not.toThrow();
  });
});

describe("the CLI writes the trail", () => {
  it(
    "gate: one hook.stop line with the block and its count when .diarchy/diag exists, no file without it",
    async () => {
      const traced = await project(true);
      const blocked = await cli(["gate", "--agent", "codex", "--project", traced], JSON.stringify({ session_id: "s1" }));
      expect(blocked.stdout).toContain('"decision":"block"');
      const lines = trail(traced);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "hook.stop", agent: "codex", project: traced, project_source: "option", decision: "block", blocks: 1, diarchy_project_set: false });

      const quiet = await project(false);
      const again = await cli(["gate", "--agent", "codex", "--project", quiet], JSON.stringify({ session_id: "s1" }));
      expect(again.stdout).toContain('"decision":"block"');
      expect(existsSync(join(quiet, DIAG_LOG))).toBe(false);
    },
    RUN_TIMEOUT,
  );

  it(
    "inbox-skim and guard: the brief's line count, and only the human command's name, never the command text or an env value",
    async () => {
      const dir = await project(true);
      const skim = await cli(["inbox-skim", "--agent", "codex", "--project", dir], "");
      expect(skim.stdout).toContain("diarchy goal");
      const deny = await cli(["guard", "--agent", "claude", "--project", dir], JSON.stringify({ tool_input: { command: "diarchy reply 'ship the secret-plan-9 now'" } }));
      expect(deny.stdout).toContain('"permissionDecision":"deny"');
      const allow = await cli(["guard", "--agent", "claude", "--project", dir], JSON.stringify({ tool_input: { command: "ls secret-plan-9" } }));
      expect(allow.stdout).toBe("");

      const lines = trail(dir);
      expect(lines.map((line) => line.event)).toEqual(["hook.session_start", "hook.pre_tool_use", "hook.pre_tool_use"]);
      expect(lines[0]).toMatchObject({ agent: "codex", lines: skim.stdout.trim().split("\n").length });
      expect(lines[1]).toMatchObject({ agent: "claude", decision: "deny", command: "reply" });
      expect(lines[2]).toMatchObject({ agent: "claude", decision: "allow" });
      const text = readFileSync(join(dir, DIAG_LOG), "utf8");
      expect(text).not.toContain("secret-plan-9");
      expect(text).not.toContain(CANARY);
    },
    RUN_TIMEOUT,
  );

  it(
    "mcp under Codex's environment allowlist: found through the worktree marker, through DIARCHY_PROJECT when set, and a WORD_CAP rejection logged with its rule",
    async () => {
      const dir = await project(true);
      const worktree = join(dir, ".diarchy", "worktrees", "codex");
      mkdirSync(worktree, { recursive: true });
      const fromWorktree = await serve(worktree, codexEnv());
      expect(fromWorktree.goal).toMatch(/-traced$/);

      const body = Array.from({ length: 121 }, (_, i) => `word${i}`).join(" ");
      const fromEnv = await serve(tmpdir(), codexEnv({ DIARCHY_PROJECT: dir }), {
        type: "PROPOSE",
        re: ["AC1"],
        claim: "A plain renderer satisfies AC1.",
        body,
      });
      expect(fromEnv.goal).toBe(fromWorktree.goal);

      const lines = trail(dir);
      const starts = lines.filter((line) => line.event === "mcp.start");
      expect(starts).toHaveLength(2);
      expect(starts[0]).toMatchObject({ agent: "codex", project: dir, project_source: "worktree-marker", diarchy_project_set: false, cwd: worktree });
      expect(starts[1]).toMatchObject({ agent: "codex", project: dir, project_source: "env", diarchy_project_set: true });
      const tools = lines.filter((line) => line.event === "mcp.tool");
      expect(tools).toContainEqual(expect.objectContaining({ tool: "read", ok: true }));
      expect(tools).toContainEqual(expect.objectContaining({ tool: "post", ok: false, rule: "WORD_CAP" }));
      const text = readFileSync(join(dir, DIAG_LOG), "utf8");
      expect(text).not.toContain("word120");
      expect(text).not.toContain(CANARY);
    },
    RUN_TIMEOUT,
  );
});
