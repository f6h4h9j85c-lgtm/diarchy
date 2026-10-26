/**
 * `diarchy doctor` and `diarchy doctor --live` against stub claude and codex
 * executables (test/fixtures/doctor/stub-cli.mjs) on PATH: they answer the
 * offline queries from a fixture and act out a live turn without a model.
 * The MCP probes start the repo's real server (bin/diarchy.js over dist/, and
 * the source CLI through a `diarchy` wrapper on PATH, as a global install).
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DIAG_LOG } from "../src/cli/diag.js";
import {
  CLAUDE_SPEND_CAP_USD,
  PROBE_PROMPT,
  atLeast,
  codexTransport,
  doctorReport,
  formatReport,
  helpFlags,
  liveArgs,
  liveHint,
  parseVersion,
  runDoctor,
  sdkProber,
  spawnRunner,
  type Check,
  type DoctorDeps,
  type DoctorReport,
} from "../src/cli/doctor.js";
import { realPlan } from "../src/cli/drivers.js";
import { runInit } from "../src/cli/init.js";
import { DEFAULT_AGENT_LAUNCH } from "../src/cli/launcher-config.js";
import { VERSION } from "../src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const TSX = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
const STUB = join(ROOT, "test", "fixtures", "doctor", "stub-cli.mjs");
const DOCTOR_TIMEOUT = 180_000;
const PROBE_GOAL = /^\d{8}-doctor-probe$/;
const OFFLINE_IDS = ["E1", "E2", "E3", "E4", "P1", "P2", "P3", "P4", "P5", "P6", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9"];
const GIT = ["-c", "user.name=doctor test", "-c", "user.email=doctor@example.invalid", "-c", "commit.gpgsign=false"];

const CLAUDE_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "  --allowedTools, --allowed-tools <tools...>",
  "  --max-budget-usd <amount>",
  "  --permission-mode <mode>",
  "  --permission-prompts <target>",
  "  -p, --print",
  "  -r, --resume [value]",
  "  --session-id <uuid>",
].join("\n");
const CODEX_EXEC_HELP = [
  "Run Codex non-interactively",
  "  -s, --sandbox <SANDBOX_MODE>",
  "      --dangerously-bypass-approvals-and-sandbox",
  "      --dangerously-bypass-hook-trust",
  "      --skip-git-repo-check",
  "      --json",
].join("\n");

interface Answer {
  stdout?: string;
  stderr?: string;
  code?: number;
}

interface Variant {
  claudePlugin?: Record<string, unknown>;
  codexExecHelp?: string;
  codexTransport?: Record<string, unknown>;
  codexServer?: Record<string, unknown>;
  live?: { claude?: string; codex?: string };
}

let world = "";
let bin = "";
let stubFile = "";
let record = "";
let projectsDirectory = "";
let good = "";
let env: NodeJS.ProcessEnv = {};

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function git(dir: string, ...args: string[]): void {
  const result = spawnRunner("git", [...GIT, ...args], { cwd: dir });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** `diarchy init` in a fresh git repo, with both agents pointed at the stubs by absolute path so no real CLI can run. */
function makeProject(name: string, commit: boolean): string {
  const dir = join(world, name);
  mkdirSync(dir);
  git(dir, "init", "-q");
  runInit(dir, {}, () => undefined);
  const path = join(dir, "diarchy.config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as { agents: Record<string, { command: string; args: string[] }> };
  config.agents.claude.command = join(bin, "claude");
  config.agents.codex.command = join(bin, "codex");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  if (commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

function writeStub(variant: Variant = {}): void {
  const answer = (stdout: string): Answer => ({ stdout });
  const fixture = {
    claude: {
      "--version": answer("2.1.311 (Claude Code)\n"),
      "--help": answer(CLAUDE_HELP),
      "auth status --json": answer(JSON.stringify({ loggedIn: true, authMethod: "oauth_token", projectsDirectory })),
      "plugin list --json": answer(JSON.stringify([{ id: "diarchy@diarchy", version: VERSION, scope: "user", enabled: true, installPath: ROOT, ...variant.claudePlugin }])),
      "mcp list": answer(`Checking MCP server health…\n\nplugin:diarchy:diarchy: node ${ROOT}bin/diarchy.js mcp --agent claude - ✓ Connected\n`),
    },
    codex: {
      "--version": answer("codex-cli 0.170.0\n"),
      "exec --help": answer(variant.codexExecHelp ?? CODEX_EXEC_HELP),
      "exec resume --help": answer("Resume a previous session by id\n"),
      "login status": answer("Logged in using ChatGPT\n"),
      "plugin list --json": answer(JSON.stringify({ installed: [{ pluginId: "diarchy@diarchy", version: VERSION, enabled: true }] })),
      "mcp get diarchy --json": answer(
        JSON.stringify({
          name: "diarchy",
          enabled: true,
          transport: { type: "stdio", command: "diarchy", args: ["mcp", "--agent", "codex"], env: null, env_vars: ["DIARCHY_PROJECT"], cwd: null, ...variant.codexTransport },
          startup_timeout_sec: 60,
          tool_timeout_sec: 1800,
          ...variant.codexServer,
        }),
      ),
    },
    live: { prompt: PROBE_PROMPT, record, projectsDirectory, diarchy: [process.execPath, "--import", TSX, CLI], ...variant.live },
  };
  writeFileSync(stubFile, JSON.stringify(fixture, null, 2));
}

function deps(): DoctorDeps {
  return { run: spawnRunner, probeMcp: sdkProber, env, platform: "linux", nodeVersion: process.versions.node, home: world };
}

const byId = (report: DoctorReport, id: string): Check => {
  const check = report.checks.find((entry) => entry.id === id);
  if (check === undefined) throw new Error(`no check ${id} in ${report.checks.map((entry) => entry.id).join(" ")}`);
  return check;
};

beforeAll(() => {
  world = realpathSync(mkdtempSync(join(tmpdir(), "diarchy-doctor-test-")));
  temps.push(world);
  bin = join(world, "bin");
  record = join(world, "record");
  projectsDirectory = join(world, "claude-projects");
  stubFile = join(world, "stub.json");
  for (const dir of [bin, record, projectsDirectory, join(world, "claude-config")]) mkdirSync(dir, { recursive: true });
  for (const flavor of ["claude", "codex"]) writeFileSync(join(bin, flavor), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${flavor} "$@"\n`, { mode: 0o755 });
  // The global install the Codex plugin copy hands its hooks to, run from source.
  writeFileSync(join(bin, "diarchy"), `#!/bin/sh\nexec "${process.execPath}" --import "${TSX}" "${CLI}" "$@"\n`, { mode: 0o755 });

  // Codex's plugin cache: hooks and bin/diarchy.js only, no dist/ and no node_modules.
  const codexHome = join(world, "codex-home");
  const copy = join(codexHome, "plugins", "cache", "diarchy", "diarchy", VERSION);
  for (const dir of ["hooks", "bin"]) {
    mkdirSync(join(copy, dir), { recursive: true });
    for (const file of readdirSync(join(ROOT, dir))) copyFileSync(join(ROOT, dir, file), join(copy, dir, file));
  }

  good = makeProject("good", true);
  const trusted = ["session_start", "pre_tool_use", "stop"].map((event) => `[hooks.state."diarchy@diarchy:hooks/codex-hooks.json:${event}:0:0"]\ntrusted_hash = "sha256:x"\n`);
  writeFileSync(join(codexHome, "config.toml"), [`[projects."${good}"]\ntrust_level = "trusted"\n`, ...trusted].join("\n"));

  env = {
    ...process.env,
    PATH: [bin, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    DOCTOR_STUB: stubFile,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(world, "claude-config"),
  };
  delete env.DIARCHY_PROJECT;
  delete env.DIARCHY_DIAG;
  writeStub();
});

describe("diarchy doctor (offline)", () => {
  it(
    "all good: exits 0 with every check ok, and both MCP probes read the probe goal",
    async () => {
      writeStub();
      const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", TSX, CLI, "doctor", "--json", "--project", good], { cwd: world, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
      const report = JSON.parse(run.stdout) as DoctorReport;
      const problems = report.checks.filter((check) => check.status !== "ok");
      expect(problems, run.stderr).toEqual([]);
      expect(run.code).toBe(0);
      expect(report).toMatchObject({ version: VERSION, project: good });
      expect(report.checks.map((check) => check.id)).toEqual(OFFLINE_IDS);
      for (const id of ["C6", "X6"]) expect(byId(report, id).summary.split(" ").at(-1)).toMatch(PROBE_GOAL);
      expect(byId(report, "C7").summary).toContain("denies diarchy reply");
      expect(byId(report, "X7").summary).toContain(join("plugins", "cache"));
    },
    DOCTOR_TIMEOUT,
  );

  it(
    "names each broken prerequisite with a fix, exits 1, and skips --live",
    async () => {
      const bare = makeProject("no-commits", false);
      writeStub({
        claudePlugin: { version: "0.1.9", scope: "project" },
        codexExecHelp: CODEX_EXEC_HELP.replace("--dangerously-bypass-hook-trust", "--full-auto"),
        codexTransport: { env_vars: [] },
        codexServer: { tool_timeout_sec: 100 },
      });
      let out = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        out += chunk.toString();
        return true;
      });
      const code = await runDoctor(bare, { json: true, live: true }, deps());
      vi.restoreAllMocks();
      const report = JSON.parse(out) as DoctorReport;
      expect(code).toBe(1);

      expect(byId(report, "P2")).toMatchObject({ status: "fail", summary: "the repository has no commits" });
      expect(byId(report, "P4").status).toBe("skip");
      const plugin = byId(report, "C4");
      expect(plugin.status).toBe("warn");
      expect(plugin.summary).toContain("project scope");
      expect(plugin.summary).toContain("plugin 0.1.9");
      expect(plugin.fix).toContain("claude plugin update diarchy@diarchy");
      expect(byId(report, "X2")).toMatchObject({ status: "fail" });
      expect(byId(report, "X2").summary).toContain("--dangerously-bypass-hook-trust");
      const server = byId(report, "X5");
      expect(server.status).toBe("fail");
      expect(server.summary).toContain("env_vars does not name DIARCHY_PROJECT");
      expect(server.summary).toContain("tool_timeout_sec 100");
      expect(server.fix).toContain('env_vars = ["DIARCHY_PROJECT"]');
      // The probe runs the server with Codex's allowlist only, from outside the project: NO_GOAL.
      const probe = byId(report, "X6");
      expect(probe).toMatchObject({ status: "fail", summary: "read answered NO_GOAL: DIARCHY_PROJECT did not reach the server" });
      expect(probe.fix).toContain("env_vars");
      expect(byId(report, "C6").status).toBe("ok");
      expect(byId(report, "L0")).toMatchObject({ group: "live", status: "skip" });
      expect(readdirSync(record)).toEqual([]);

      const text = formatReport(report);
      expect(text).toMatch(/^ {2}fail {2}X5 {8}env_vars does not name DIARCHY_PROJECT/m);
      expect(text).toMatch(/^ {18}fix: add env_vars = \["DIARCHY_PROJECT"\]/m);
    },
    DOCTOR_TIMEOUT,
  );
});

describe("diarchy doctor --live", () => {
  it(
    "runs one probe turn per CLI with realPlan's command, args, and env, and passes on the goal id, the trail, and a resumable session",
    async () => {
      writeStub();
      vi.stubEnv("DOCTOR_STUB", stubFile);
      vi.stubEnv("PATH", env.PATH ?? "");
      const out = join(world, "out-good");
      const report = await doctorReport(good, { live: true, out }, deps());
      expect(report.checks.filter((check) => check.status !== "ok")).toEqual([]);
      for (const id of ["L-claude", "L-codex"]) {
        expect(byId(report, id).summary).toContain("named the probe goal");
        expect(byId(report, id).summary).toContain("found the project through DIARCHY_PROJECT");
        expect(byId(report, id).summary).toContain("SessionStart hook ran, Stop hook ran");
      }
      expect(byId(report, "L-codex").summary).toContain("session id readable");
      expect(byId(report, "L-claude").summary).toContain("transcript saved");

      // The probe cannot drift from the launcher: realPlan's args, the probe prompt in place of the PM prompt.
      const recorded = (flavor: string): string[] => JSON.parse(readFileSync(join(record, `${flavor}.args.json`), "utf8")) as string[];
      const input = { projectDir: good, goalId: "g", cwd: good, worktree: null, session: null, inGitRepo: true };
      const claudePlan = realPlan({ ...input, agent: "claude", launch: { command: join(bin, "claude"), args: DEFAULT_AGENT_LAUNCH.claude.args } });
      const claudeArgs = recorded("claude");
      const minted = claudeArgs[claudeArgs.indexOf("--session-id") + 1];
      const expected = liveArgs("claude", claudePlan.args, helpFlags(CLAUDE_HELP)).map((arg) => (arg === claudePlan.minted?.session_id ? minted : arg));
      expect(claudeArgs).toEqual(expected);
      expect(claudeArgs).toEqual([...DEFAULT_AGENT_LAUNCH.claude.args, "--session-id", minted, "--max-budget-usd", "0.25", PROBE_PROMPT]);
      const codexPlan = realPlan({ ...input, agent: "codex", launch: { command: join(bin, "codex"), args: DEFAULT_AGENT_LAUNCH.codex.args } });
      expect(recorded("codex")).toEqual(liveArgs("codex", codexPlan.args, null));

      // --out keeps the raw output and the trail; the throwaway project is gone.
      for (const file of ["claude.stdout.txt", "claude.stderr.txt", "codex.stdout.txt", "codex.stderr.txt", "diag.log"]) expect(existsSync(join(out, file)), file).toBe(true);
      const trail = readFileSync(join(out, "diag.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { project: string; event: string });
      expect(trail.map((line) => line.event)).toContain("mcp.start");
      expect(existsSync(trail[0].project)).toBe(false);
      expect(existsSync(join(trail[0].project, DIAG_LOG))).toBe(false);
    },
    DOCTOR_TIMEOUT,
  );

  it(
    "fails a CLI that is not logged in with the login hint, and a Codex that drops DIARCHY_PROJECT with the env_vars hint",
    async () => {
      writeStub({ live: { claude: "not-logged-in", codex: "drop-env" } });
      vi.stubEnv("DOCTOR_STUB", stubFile);
      vi.stubEnv("PATH", env.PATH ?? "");
      const report = await doctorReport(good, { live: true }, deps());
      const claude = byId(report, "L-claude");
      expect(claude.status).toBe("fail");
      expect(claude.summary).toContain("exited 1");
      expect(claude.fix).toBe("claude auth login");
      const codex = byId(report, "L-codex");
      expect(codex.status).toBe("fail");
      expect(codex.summary).toContain("the output does not name the probe goal");
      expect(codex.fix).toBe('add env_vars = ["DIARCHY_PROJECT"] to [mcp_servers.diarchy] in ~/.codex/config.toml');
    },
    DOCTOR_TIMEOUT,
  );

  it(
    "fails a server that found the project some other way than DIARCHY_PROJECT, and a turn whose hooks did not run, even when read named the goal",
    async () => {
      writeStub({ live: { claude: "drop-env", codex: "no-hooks" } });
      vi.stubEnv("DOCTOR_STUB", stubFile);
      vi.stubEnv("PATH", env.PATH ?? "");
      const report = await doctorReport(good, { live: true }, deps());
      const claude = byId(report, "L-claude");
      expect(claude.status).toBe("fail");
      expect(claude.summary).toBe("claude: the MCP server found the project by walk-up, not DIARCHY_PROJECT");
      expect(claude.fix).toContain("DIARCHY_PROJECT");
      const codex = byId(report, "L-codex");
      expect(codex.status).toBe("fail");
      expect(codex.summary).toBe("codex: the SessionStart hook did not run; the Stop hook did not run");
      expect(codex.fix).toContain("--dangerously-bypass-hook-trust");
    },
    DOCTOR_TIMEOUT,
  );
});

describe("doctor helpers", () => {
  it("reads versions, help flags, and codex mcp get output", () => {
    expect(parseVersion("2.1.311 (Claude Code)")).toEqual([2, 1, 311]);
    expect(parseVersion("v20.3")).toEqual([20, 3, 0]);
    expect(atLeast([2, 1, 275], "2.1.275")).toBe(true);
    expect(atLeast([2, 1, 274], "2.1.275")).toBe(false);
    expect(atLeast([20, 10, 0], "20.3.0")).toBe(true);
    expect([...helpFlags(CLAUDE_HELP)]).toContain("--allowed-tools");

    const flat = codexTransport({ command: "diarchy", args: ["mcp"], env_vars: [{ name: "DIARCHY_PROJECT" }], tool_timeout_sec: 1800 });
    expect(flat).toMatchObject({ enabled: true, type: "stdio", envVars: ["DIARCHY_PROJECT"], toolTimeoutSec: 1800, startupTimeoutSec: null, cwd: null });
    expect(codexTransport({ transport: { type: "streamable_http", url: "x" } })).toBeNull();
    expect(codexTransport("not json")).toBeNull();
  });

  it("the setup docs and init's next steps point at diarchy doctor, with the spend cap the code passes", () => {
    const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");
    const section = (doc: string, heading: string): string => {
      const start = doc.indexOf(`\n${heading}\n`);
      expect(start, heading).toBeGreaterThanOrEqual(0);
      const rest = doc.slice(start + heading.length + 2);
      const end = rest.search(/^#{1,2} /m);
      return end < 0 ? rest : rest.slice(0, end);
    };
    const quickstart = section(read("docs", "QUICKSTART.md"), "## 1. Install the plugin in both CLIs");
    const claude = section(read("docs", "INSTALL-CLAUDE.md"), "## Confirm it is connected");
    const codex = section(read("docs", "INSTALL-CODEX.md"), "## 6. Confirm it is connected");
    for (const [name, text] of Object.entries({ quickstart, claude, codex })) {
      expect(text, name).toContain("diarchy doctor");
      expect(text, name).toContain("diarchy doctor --live");
    }
    for (const text of [quickstart, claude]) expect(text.replace(/\s+/g, " ")).toContain(`--max-budget-usd ${CLAUDE_SPEND_CAP_USD}`);
    expect(read("CONTRIBUTING.md")).toContain("`.diarchy/diag`");
    let printed = "";
    const dir = mkdtempSync(join(tmpdir(), "diarchy-doctor-init-"));
    temps.push(dir);
    runInit(dir, {}, (text) => (printed = text));
    expect(printed).toMatch(/^ {2}5\. Check: +diarchy doctor /m);
  });

  it("maps what a failed live turn printed to its fix", () => {
    const result = { code: 1, stdout: "", stderr: "", error: null };
    expect(liveHint("codex", "codex", "Not inside a trusted directory and --skip-git-repo-check was not specified.", result, [])).toContain("git repository");
    expect(liveHint("claude", "claude", "Claude requested permissions to use mcp__plugin_diarchy_diarchy__read", result, [])).toContain("--allowedTools");
    expect(liveHint("codex", "codex", "", result, ["the Stop hook did not run"])).toContain("--dangerously-bypass-hook-trust");
    expect(liveHint("claude", "claude", "", { ...result, code: null, error: "ETIMEDOUT" }, [])).toContain("180 s");
  });
});
