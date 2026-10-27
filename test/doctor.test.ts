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

import { DIAG_LOG, DIAG_MARKER } from "../src/cli/diag.js";
import {
  CLAUDE_SPEND_CAP_USD,
  PROBE_PROMPT,
  allowsTools,
  atLeast,
  codexTransport,
  doctorReport,
  formatReport,
  helpFlags,
  liveArgs,
  liveEnv,
  liveHint,
  parseVersion,
  runDoctor,
  sdkProber,
  spawnRunner,
  type Check,
  type DoctorDeps,
  type DoctorReport,
  type McpProber,
  type RunResult,
  type Runner,
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
  /** A file the stub creates before answering, and a pause before it answers. */
  touch?: string;
  sleepMs?: number;
}

interface Variant {
  /** Answers that replace the default ones, by the args joined with a space. */
  claude?: Record<string, Answer>;
  codex?: Record<string, Answer>;
  claudePlugin?: Record<string, unknown>;
  codexExecHelp?: string;
  codexTransport?: Record<string, unknown>;
  codexServer?: Record<string, unknown>;
  live?: { claude?: string; codex?: string; slowMs?: number };
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
      ...variant.claude,
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
      ...variant.codex,
    },
    live: { prompt: PROBE_PROMPT, record, projectsDirectory, diarchy: [process.execPath, "--import", TSX, CLI], ...variant.live },
  };
  writeFileSync(stubFile, JSON.stringify(fixture, null, 2));
}

function deps(): DoctorDeps {
  return { run: spawnRunner, probeMcp: sdkProber, env, platform: "linux", nodeVersion: process.versions.node, home: world };
}

/** For checks that do not need the MCP probes: answers at once, without starting a server. */
const noProbe: McpProber = () => Promise.resolve({ connected: false, version: null, tools: [], goal: null, rule: null, error: "not probed in this test" });

interface Call {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
}

/** spawnRunner, recording each call in `calls`; `answer` may stand in for a call by returning a result. */
function recording(calls: Call[], answer: (command: string, args: readonly string[]) => RunResult | null = () => null): Runner {
  return (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd, env: options?.env });
    return answer(command, args) ?? spawnRunner(command, args, options);
  };
}

/** Replace the `--allowedTools` value of a project's Claude launch. */
function setAllowedTools(dir: string, rule: string): void {
  const path = join(dir, "diarchy.config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as { agents: Record<string, { args: string[] }> };
  const args = DEFAULT_AGENT_LAUNCH.claude.args;
  const at = args.indexOf("--allowedTools") + 1;
  config.agents.claude.args = args.map((arg, i) => (i === at ? rule : arg));
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
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
    "all good: exits 0 with every check ok, both MCP probes read the probe goal, and the project's diagnostics trail gets no line",
    async () => {
      writeStub();
      // The trail is on in the project: every probe, the guard hooks included, must run in the probe project instead.
      mkdirSync(join(good, ".diarchy"), { recursive: true });
      writeFileSync(join(good, DIAG_MARKER), "");
      const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", TSX, CLI, "doctor", "--json", "--project", good], { cwd: world, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
      const trailed = existsSync(join(good, DIAG_LOG));
      for (const file of [DIAG_MARKER, DIAG_LOG]) rmSync(join(good, file), { force: true });
      const report = JSON.parse(run.stdout) as DoctorReport;
      const problems = report.checks.filter((check) => check.status !== "ok");
      expect(problems, run.stderr).toEqual([]);
      expect(run.code).toBe(0);
      expect(report).toMatchObject({ version: VERSION, project: good });
      expect(report.checks.map((check) => check.id)).toEqual(OFFLINE_IDS);
      for (const id of ["C6", "X6"]) expect(byId(report, id).summary.split(" ").at(-1)).toMatch(PROBE_GOAL);
      expect(byId(report, "C7").summary).toContain("denies diarchy reply");
      expect(byId(report, "X7").summary).toContain(join("plugins", "cache"));
      expect(trailed).toBe(false);
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

  it(
    "C5 fails a connected plugin server whose tools the launch flags do not allow, and keeps claude mcp list out of the project's trail",
    async () => {
      writeStub();
      const dir = makeProject("allowed-tools", true);
      const calls: Call[] = [];
      const c5 = async (): Promise<Check> => byId(await doctorReport(dir, {}, { ...deps(), run: recording(calls), probeMcp: noProbe }), "C5");
      const fix = "add mcp__plugin_diarchy_diarchy__* to --allowedTools in agents.claude.args";
      setAllowedTools(dir, "Bash(git *),Bash(make *)");
      expect(await c5()).toMatchObject({ status: "fail", fix });
      // The rule INSTALL-CLAUDE.md gives for a server added with claude mcp add does not cover the plugin's.
      setAllowedTools(dir, "mcp__diarchy__*,Bash(git *)");
      expect(await c5()).toMatchObject({ status: "fail", fix });
      // Two servers: following the fix must not leave a list without the plugin's rule.
      writeStub({ claude: { "mcp list": { stdout: `plugin:diarchy:diarchy: node ${ROOT}bin/diarchy.js mcp --agent claude - ✓ Connected\ndiarchy: diarchy mcp --agent claude - ✓ Connected\n` } } });
      expect(await c5()).toMatchObject({ status: "warn", fix: `claude mcp remove diarchy (keep the plugin's), then ${fix}` });
      // The health check starts the server in the project, so the doctor turns the trail off for it.
      const listed = calls.filter((call) => call.args.join(" ") === "mcp list");
      expect(listed.map((call) => call.env?.DIARCHY_DIAG)).toEqual(["0", "0", "0"]);
    },
    DOCTOR_TIMEOUT,
  );

  it(
    "fails a --project that does not exist and runs no git for it in this process's cwd",
    async () => {
      writeStub();
      const missing = join(world, "no-such-project");
      const calls: Call[] = [];
      const report = await doctorReport(missing, {}, { ...deps(), run: recording(calls), probeMcp: noProbe });
      expect(byId(report, "P0")).toMatchObject({ group: "project", status: "fail", summary: `${missing} does not exist`, fix: "pass --project <existing dir>" });
      for (const id of ["P2", "P4", "P5"]) expect(byId(report, id).status, id).toBe("skip");
      expect(calls.filter((call) => call.command === "git" && call.args[0] !== "--version")).toEqual([]);
    },
    DOCTOR_TIMEOUT,
  );

  it(
    "puts a fix line under every warn and fail, for unreadable CLI output and a temp directory it cannot use too",
    async () => {
      writeStub({
        claude: {
          "--version": { stdout: "Claude Code\n" },
          "--help": { code: 2, stderr: "no help here" },
          "auth status --json": { stdout: "not json" },
          "plugin list --json": { stdout: "not json" },
          "mcp list": { code: 3 },
        },
        codex: {
          "exec --help": { code: 2, stderr: "no help here" },
          "plugin list --json": { stdout: "not json" },
          "mcp get diarchy --json": { stdout: JSON.stringify({ transport: { type: "streamable_http", url: "http://localhost:1" } }) },
        },
      });
      const lsTreeFails = recording([], (command, args) => (command === "git" && args.includes("ls-tree") ? { code: 128, stdout: "", stderr: "fatal: stub", error: null } : null));
      const unreadable = await doctorReport(good, {}, { ...deps(), run: lsTreeFails, probeMcp: noProbe });
      writeStub();
      vi.stubEnv("TMPDIR", join(world, "no-such-tmp"));
      const noTemp = await doctorReport(good, {}, { ...deps(), probeMcp: noProbe });
      vi.unstubAllEnvs();

      const warned = (report: DoctorReport): string[] => report.checks.filter((check) => check.status === "warn").map((check) => check.id);
      expect(warned(unreadable)).toEqual(expect.arrayContaining(["P4", "C1", "C2", "C3", "C4", "C5", "X2", "X4", "X5"]));
      expect(warned(noTemp)).toEqual(expect.arrayContaining(["C6", "C7", "X6", "X7"]));
      const unfixed = [...unreadable.checks, ...noTemp.checks].filter((check) => (check.status === "warn" || check.status === "fail") && (check.fix ?? "").trim() === "");
      expect(unfixed).toEqual([]);
      expect(byId(unreadable, "C5").fix).toBe(`run ${join(bin, "claude")} mcp list by hand and read its output; claude update if its format changed`);
      expect(byId(noTemp, "X7").fix).toContain("temp directory");
      expect(formatReport(unreadable)).toMatch(/^ {2}warn {2}C3 .*\n {18}fix: run .* auth status --json by hand/m);
    },
    DOCTOR_TIMEOUT,
  );

  it(
    "deletes its probe project when a signal stops it mid-run",
    async () => {
      const tmp = join(world, "tmp-signal");
      mkdirSync(tmp);
      const sleeping = join(world, "codex-version-sleeping");
      // codex --version runs after the claude probes made the probe project; it pauses there.
      writeStub({ codex: { "--version": { stdout: "codex-cli 0.170.0\n", touch: sleeping, sleepMs: 3_000 } } });
      const probes = (): string[] => readdirSync(tmp).filter((name) => name.startsWith("diarchy-doctor-"));
      const child = spawn(process.execPath, ["--import", TSX, CLI, "doctor", "--json", "--project", good], { cwd: world, env: { ...env, TMPDIR: tmp }, stdio: "ignore" });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
      try {
        await vi.waitFor(
          () => {
            if (!existsSync(sleeping)) throw new Error("the doctor has not reached codex --version yet");
          },
          { timeout: DOCTOR_TIMEOUT - 30_000, interval: 100 },
        );
        expect(probes()).toHaveLength(1);
        child.kill("SIGTERM");
        expect(await closed).toEqual({ code: 143, signal: null });
        expect(probes()).toEqual([]);
      } finally {
        child.kill("SIGKILL");
      }
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

  it(
    "runs the turns with the trail on whatever DIARCHY_* the caller exported, DIARCHY_DIAG=0 included",
    async () => {
      writeStub();
      vi.stubEnv("DOCTOR_STUB", stubFile);
      vi.stubEnv("PATH", env.PATH ?? "");
      vi.stubEnv("DIARCHY_DIAG", "0");
      vi.stubEnv("DIARCHY_FAKE_MODE", "slop");
      const calls: Call[] = [];
      const report = await doctorReport(good, { live: true }, { ...deps(), run: recording(calls) });
      for (const id of ["L-claude", "L-codex"]) expect(byId(report, id), id).toMatchObject({ status: "ok" });
      const turns = calls.filter((call) => call.args.at(-1) === PROBE_PROMPT);
      expect(turns).toHaveLength(2);
      for (const turn of turns) {
        const diarchy = Object.keys(turn.env ?? {}).filter((key) => key.startsWith("DIARCHY_")).sort();
        expect(diarchy).toEqual(["DIARCHY_AGENT", "DIARCHY_GOAL", "DIARCHY_PROJECT"]);
      }
      expect(liveEnv({ PATH: "/bin", DIARCHY_DIAG: "0", DIARCHY_PROJECT: "/p", DIARCHY_WORKTREE: "/w" })).toEqual({ PATH: "/bin", DIARCHY_PROJECT: "/p", DIARCHY_WORKTREE: "/w" });
    },
    DOCTOR_TIMEOUT,
  );

  it.each([
    // kill <pid>: the doctor waits for the turn in progress to end, then stops.
    { signal: "SIGTERM" as const, group: false, code: 143 },
    // Ctrl-C in a terminal: the whole process group, the CLI too.
    { signal: "SIGINT" as const, group: true, code: 130 },
  ])(
    "stops at a $signal during the claude turn (process group: $group): exit $code, no codex turn, no probe project left",
    async ({ signal, group, code }) => {
      const tmp = join(world, `tmp-live-${signal}`);
      mkdirSync(tmp);
      writeStub({ live: { claude: "slow", slowMs: group ? 120_000 : 3_000 } });
      for (const flavor of ["claude", "codex"]) rmSync(join(record, `${flavor}.args.json`), { force: true });
      const probes = (): string[] => readdirSync(tmp).filter((name) => name.startsWith("diarchy-doctor-"));
      const child = spawn(process.execPath, ["--import", TSX, CLI, "doctor", "--json", "--live", "--project", good], {
        cwd: world,
        env: { ...env, TMPDIR: tmp },
        stdio: "ignore",
        detached: group,
      });
      const pid = child.pid ?? 0;
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exit, killed) => resolve({ code: exit, signal: killed }));
      });
      try {
        await vi.waitFor(
          () => {
            if (!existsSync(join(record, "claude.args.json"))) throw new Error("the doctor has not started the claude turn yet");
          },
          { timeout: DOCTOR_TIMEOUT - 30_000, interval: 100 },
        );
        expect(probes()).toHaveLength(2);
        process.kill(group ? -pid : pid, signal);
        expect(await closed).toEqual({ code, signal: null });
        expect(existsSync(join(record, "codex.args.json"))).toBe(false);
        expect(probes()).toEqual([]);
      } finally {
        try {
          process.kill(group ? -pid : pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
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

  it("allowsTools: an --allowedTools rule for the server or its tools, or permissions bypassed", () => {
    const plugin = "mcp__plugin_diarchy_diarchy";
    // What diarchy init writes passes.
    expect(allowsTools(DEFAULT_AGENT_LAUNCH.claude.args, plugin)).toBe(true);
    expect(allowsTools(DEFAULT_AGENT_LAUNCH.claude.args, "mcp__diarchy")).toBe(false);
    expect(allowsTools(["--allowedTools", "Bash(git *),mcp__plugin_diarchy_diarchy"], plugin)).toBe(true);
    expect(allowsTools(["--allowedTools", "mcp__plugin_diarchy_diarchy__read"], plugin)).toBe(true);
    expect(allowsTools(["--allowedTools", "mcp__diarchy__*,Bash(git *)"], plugin)).toBe(false);
    expect(allowsTools(["--allowedTools", "mcp__diarchy__*,Bash(git *)"], "mcp__diarchy")).toBe(true);
    expect(allowsTools(["--allowedTools", "mcp__plugin_diarchy_diarchy_extra"], plugin)).toBe(false);
    expect(allowsTools(["-p", "--dangerously-skip-permissions"], plugin)).toBe(true);
    expect(allowsTools(["--permission-mode", "bypassPermissions"], plugin)).toBe(true);
    expect(allowsTools(["--permission-mode=bypassPermissions"], plugin)).toBe(true);
    expect(allowsTools(["--permission-mode", "acceptEdits", "--allowedTools", "Bash(git *)"], plugin)).toBe(false);
    // A rule that --disallowedTools names allows nothing; its values run to the next flag.
    expect(allowsTools(["--allowedTools", "Bash(git *)", "--disallowedTools", "mcp__plugin_diarchy_diarchy__*"], plugin)).toBe(false);
    expect(allowsTools(["--disallowed-tools", "Bash(rm *)", "mcp__plugin_diarchy_diarchy"], plugin)).toBe(false);
    expect(allowsTools(["--disallowedTools=mcp__plugin_diarchy_diarchy__*", "-p"], plugin)).toBe(false);
    expect(allowsTools(["--disallowedTools", "Bash(rm *)", "--allowedTools", "mcp__plugin_diarchy_diarchy__*"], plugin)).toBe(true);
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
