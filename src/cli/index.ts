/**
 * The `diarchy` command line: launcher, human controls, hook helpers, and the
 * MCP server entry. Every command reads diarchy.config.json from --project
 * (default: DIARCHY_PROJECT, else the nearest directory at or above the cwd
 * that holds one, else the cwd; `init` uses the cwd).
 */
import { Command, Option } from "commander";

import { VERSION } from "../index.js";
import { CliError, EXIT_ERROR, EXIT_OK, handleBrokenPipes, resolveProjectDirWithSource, type ResolvedProject } from "./common.js";
import { diag, errorName } from "./diag.js";
import { runDoctor } from "./doctor.js";
import { gateBlockCount, guardDecision, guardedCommand, runGate, runInboxSkim } from "./hooks.js";
import { runReply, runStop } from "./human.js";
import { runInit } from "./init.js";
import { runKickoff } from "./kickoff.js";
import { startMcpServer } from "./mcp-entry.js";
import { runSmoke, type SmokeOptions } from "./smoke.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";
import { runWatch } from "./watch.js";

const program = new Command();

program
  .name("diarchy")
  .description("Two AI coding agents, each running as a product manager, coordinating through an Obsidian vault.")
  .version(VERSION)
  .option("--project <dir>", "project directory holding diarchy.config.json (default: DIARCHY_PROJECT, else the nearest directory at or above the cwd that holds one, else the cwd)")
  .showHelpAfterError();

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** The project and the rule that found it (common.ts resolveProjectDir). */
function project(options: { walkUp?: boolean } = {}): ResolvedProject {
  return resolveProjectDirWithSource(program.opts<{ project?: string }>().project, options);
}

function projectDir(options: { walkUp?: boolean } = {}): string {
  return project(options).dir;
}

/** Run a command, map its exit code, and print CliErrors without a stack. */
async function exitWith(run: () => Promise<number> | number): Promise<void> {
  let code = EXIT_ERROR;
  try {
    code = await run();
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`diarchy: ${error.message}`);
      code = error.exitCode;
    } else {
      console.error(`diarchy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = code;
  // Exit even if a stray handle (child pipe, stdin) stays open.
  setTimeout(() => process.exit(code), 2_000).unref();
}

/** The hook JSON on stdin; returns whatever arrived within the timeout. Never throws. */
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    if (process.stdin.isTTY === true) {
      done();
      return;
    }
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

// ---------------------------------------------------------------------------
// Setup and goals
// ---------------------------------------------------------------------------

program
  .command("init")
  .description("Write diarchy.config.json, create the vault, ignore .diarchy/, copy the Codex subagents and AGENTS.md, and print the install steps")
  .option("--vault <path>", "vault directory, relative to the project (default: <project> brain/diarchy)")
  .option("--agents <ids>", "comma-separated agent ids", "claude,codex")
  .option("--force", "overwrite an existing diarchy.config.json")
  .option("--codex-full-access", "launch the Codex PM without its sandbox, with your full OS permissions (default: sandboxed, cannot commit)")
  .action((options: { vault?: string; agents?: string; force?: boolean; codexFullAccess?: boolean }) =>
    exitWith(() => runInit(projectDir({ walkUp: false }), options)),
  );

const kickoffOptions = (command: Command): Command =>
  command
    .option("--ac <criterion>", "acceptance criterion (repeatable)", collect, [])
    .option("--lead <agent>", "lead agent (default: alternates from the previous goal)")
    .option("--budget <key=value>", "budget override, e.g. plan_messages=6 (repeatable)", collect, [])
    .option("--slug <slug>", "goal id slug instead of one derived from the goal text");

kickoffOptions(program.command("kickoff").argument("<goal>", "goal text, 120 words max"))
  .description("Start a goal as the human and print its id and goal.md path")
  .option("--json", "machine-readable output")
  .action((goal: string, options: { ac: string[]; lead?: string; budget: string[]; slug?: string; json?: boolean }) =>
    exitWith(() => runKickoff(projectDir(), goal, options)),
  );

kickoffOptions(program.command("start").argument("[goal]", "goal text; omit to attach to the active goal"))
  .description("Kick off (or attach), create worktrees, spawn both PMs, and supervise until DONE (exit 0) or BLOCKED (exit 2)")
  .addOption(new Option("--driver <driver>", "real spawns the CLIs; fake runs the scripted PM").choices(["real", "fake"]).default("real"))
  .option("--fake-script <path>", "script for --driver fake (default: the bundled fake-pm)")
  .addOption(new Option("--fake-mode <mode>", "scripted behaviour for --driver fake (default: DIARCHY_FAKE_MODE, else good)").choices(["good", "slop", "silent"]))
  .option("--no-worktrees", "run the agents in the project directory instead of per-agent worktrees")
  .action(
    (
      goal: string | undefined,
      options: {
        ac: string[];
        lead?: string;
        budget: string[];
        slug?: string;
        driver: string;
        fakeScript?: string;
        fakeMode?: string;
        worktrees: boolean;
      },
    ) => exitWith(() => runStart(projectDir(), goal, options)),
  );

program
  .command("watch")
  .description("Print each message header as it lands; exits on DONE or BLOCKED unless --follow")
  .option("--follow", "keep watching across DONE, BLOCKED, and the next goal")
  .action((options: { follow?: boolean }) => exitWith(() => runWatch(projectDir(), options)));

program
  .command("doctor")
  .description("Check Node, git, the project, and both CLIs' plugin, MCP server, and hook wiring without a model call; exits 1 on any failure")
  .option("--json", "machine-readable output")
  .option("--live", "then run one short real turn per CLI against a throwaway project (spends a little quota)")
  .option("--out <dir>", "with --live, save each CLI's raw output and the diagnostics trail here")
  .action((options: { json?: boolean; live?: boolean; out?: string }) => exitWith(() => runDoctor(projectDir(), options)));

program
  .command("smoke")
  .description(
    "Run both PMs on a two-criterion goal in a throwaway git repository and write a diagnostics bundle (.tar.gz) to send back; exits 0 on DONE, 2 on BLOCKED once both PMs posted, 1 otherwise",
  )
  .option("--out <dir>", "where the bundle goes (default: the current directory)")
  .option("--minutes <n>", "wall clock budget of the goal; a watchdog stops the run 3 min after it", "20")
  .option("--max-usd <usd>", "--max-budget-usd for each Claude process, when claude lists that flag", "3")
  .option("--github <owner/repo>", "a new, empty repository you created: push main to it so the PMs open and cross-review real PRs (needs gh logged in)")
  .option("--no-transcripts", "leave both CLIs' transcripts out of the bundle")
  .option("--no-ping", "skip the doctor --live turn before the run")
  .option("--clean", "delete the throwaway project after writing the bundle (default: keep it)")
  .addOption(new Option("--driver <driver>", "real spawns the CLIs; fake runs the scripted PM with no model calls").choices(["real", "fake"]).default("real"))
  .action((options: SmokeOptions) => exitWith(() => runSmoke(options)));

program
  .command("status")
  .description("Phase, roles, budgets, open assignments, last message, and the diarchy reply command if the human is needed")
  .option("--json", "machine-readable output")
  .action((options: { json?: boolean }) => exitWith(() => runStatus(projectDir(), options)));

// ---------------------------------------------------------------------------
// Human controls
// ---------------------------------------------------------------------------

program
  .command("reply")
  .argument("<text>", "your ruling, one sentence")
  .description("Answer a BLOCKED run with a DECIDE (basis human) and resume")
  .option("--decision <id>", "thread to close: plan or D<n> (default: a new D<n>)")
  .option("--task <text>", "with --decision plan on an open plan: a task EXECUTE begins with, as todo for the lead to assign (repeatable)", collect, [])
  .option("--budget <key=value>", "raise a limit for the rest of the goal (repeatable)", collect, [])
  .option("--body <text>", "free text under the ruling")
  .option("--json", "machine-readable output")
  .action((text: string, options: { decision?: string; task: string[]; budget: string[]; body?: string; json?: boolean }) =>
    exitWith(() => runReply(projectDir(), text, options)),
  );

program
  .command("stop")
  .description("Leave the goal BLOCKED with a human BLOCKED message and stop a running diarchy start")
  .option("--reason <text>", "why (default: stopped by the human)")
  .option("--json", "machine-readable output")
  .action((options: { reason?: string; json?: boolean }) => exitWith(() => runStop(projectDir(), options)));

// ---------------------------------------------------------------------------
// Hooks and the MCP server
// ---------------------------------------------------------------------------

program
  .command("inbox-skim")
  .description("SessionStart hook: a 15-line brief of the active goal for one agent; prints nothing without a goal")
  .requiredOption("--agent <id>", "agent id (claude | codex)")
  .action((options: { agent: string }) => {
    let where: ResolvedProject | null = null;
    try {
      where = project();
      const lines = runInboxSkim(where.dir, options.agent);
      if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
      diag(where, options.agent, "hook.session_start", { lines: lines.length });
    } catch (error) {
      // the hook must never break a session
      if (where !== null) diag(where, options.agent, "hook.session_start", { error: errorName(error) });
    }
    process.exit(EXIT_OK);
  });

program
  .command("gate")
  .description('Stop hook: print {"decision":"block",...} while this agent owes the goal something; never throws')
  .requiredOption("--agent <id>", "agent id (claude | codex)")
  .action(async (options: { agent: string }) => {
    let where: ResolvedProject | null = null;
    try {
      where = project();
      const event = await readStdin(1_500);
      const decision = runGate(where.dir, options.agent, event);
      if (decision !== null) process.stdout.write(`${JSON.stringify(decision)}\n`);
      diag(where, options.agent, "hook.stop", { decision: decision === null ? "allow" : "block", blocks: gateBlockCount(where.dir, options.agent, event) });
    } catch (error) {
      // the hook must never break a session
      if (where !== null) diag(where, options.agent, "hook.stop", { error: errorName(error) });
    }
    process.exit(EXIT_OK);
  });

program
  .command("guard")
  .description("PreToolUse hook: print a deny decision when the shell command on stdin runs diarchy reply or diarchy stop; never throws")
  .requiredOption("--agent <id>", "agent id (claude | codex)")
  .action(async (options: { agent: string }) => {
    try {
      const subcommand = guardedCommand(await readStdin(1_500));
      if (subcommand !== null) process.stdout.write(`${JSON.stringify(guardDecision(options.agent, subcommand))}\n`);
      // Only the human command's name: the shell command itself is never logged.
      diag(project(), options.agent, "hook.pre_tool_use", subcommand === null ? { decision: "allow" } : { decision: "deny", command: subcommand });
    } catch {
      // the hook must never break a session
    }
    process.exit(EXIT_OK);
  });

program
  .command("mcp")
  .description("Run the diarchy MCP server on stdio for one agent (used by the Claude Code and Codex plugins)")
  .requiredOption("--agent <id>", "agent id this server posts as")
  .action((options: { agent: string }) =>
    exitWith(async () => {
      const where = project();
      diag(where, options.agent, "mcp.start");
      const onResult = (result: { tool: string; ok: boolean; rule?: string }): void =>
        diag(where, options.agent, "mcp.tool", { tool: result.tool, ok: result.ok, ...(result.rule === undefined ? {} : { rule: result.rule }) });
      await startMcpServer({ projectDir: where.dir, agent: options.agent, onResult });
      return EXIT_OK;
    }),
  );

handleBrokenPipes();
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`diarchy: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_ERROR);
});
