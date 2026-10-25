/**
 * The `diarchy` command line: launcher, human controls, hook helpers, and the
 * MCP server entry. Every command reads diarchy.config.json from --project
 * (default: DIARCHY_PROJECT, else the nearest directory at or above the cwd
 * that holds one, else the cwd; `init` uses the cwd).
 */
import { Command, Option } from "commander";
import { VERSION } from "../index.js";
import { CliError, EXIT_ERROR, EXIT_OK, resolveProjectDir } from "./common.js";
import { runGate, runGuard, runInboxSkim } from "./hooks.js";
import { runReply, runStop } from "./human.js";
import { runInit } from "./init.js";
import { runKickoff } from "./kickoff.js";
import { startMcpServer } from "./mcp-entry.js";
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
function collect(value, previous) {
    return [...previous, value];
}
function projectDir(options = {}) {
    return resolveProjectDir(program.opts().project, options);
}
/** Run a command, map its exit code, and print CliErrors without a stack. */
async function exitWith(run) {
    let code = EXIT_ERROR;
    try {
        code = await run();
    }
    catch (error) {
        if (error instanceof CliError) {
            console.error(`diarchy: ${error.message}`);
            code = error.exitCode;
        }
        else {
            console.error(`diarchy: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    process.exitCode = code;
    // Exit even if a stray handle (child pipe, stdin) stays open.
    setTimeout(() => process.exit(code), 2_000).unref();
}
/** The hook JSON on stdin; returns whatever arrived within the timeout. Never throws. */
function readStdin(timeoutMs) {
    return new Promise((resolve) => {
        let text = "";
        let settled = false;
        const done = () => {
            if (settled)
                return;
            settled = true;
            resolve(text);
        };
        if (process.stdin.isTTY === true) {
            done();
            return;
        }
        const timer = setTimeout(done, timeoutMs);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
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
    .description("Write diarchy.config.json, create the vault, ignore .diarchy/, and print the install steps")
    .option("--vault <path>", "vault directory, relative to the project (default: <project> brain/diarchy)")
    .option("--agents <ids>", "comma-separated agent ids", "claude,codex")
    .option("--force", "overwrite an existing diarchy.config.json")
    .action((options) => exitWith(() => runInit(projectDir({ walkUp: false }), options)));
const kickoffOptions = (command) => command
    .option("--ac <criterion>", "acceptance criterion (repeatable)", collect, [])
    .option("--lead <agent>", "lead agent (default: alternates from the previous goal)")
    .option("--budget <key=value>", "budget override, e.g. plan_messages=6 (repeatable)", collect, [])
    .option("--slug <slug>", "goal id slug instead of one derived from the goal text");
kickoffOptions(program.command("kickoff").argument("<goal>", "goal text, 120 words max"))
    .description("Start a goal as the human and print its id and goal.md path")
    .option("--json", "machine-readable output")
    .action((goal, options) => exitWith(() => runKickoff(projectDir(), goal, options)));
kickoffOptions(program.command("start").argument("[goal]", "goal text; omit to attach to the active goal"))
    .description("Kick off (or attach), create worktrees, spawn both PMs, and supervise until DONE (exit 0) or BLOCKED (exit 2)")
    .addOption(new Option("--driver <driver>", "real spawns the CLIs; fake runs the scripted PM").choices(["real", "fake"]).default("real"))
    .option("--fake-script <path>", "script for --driver fake (default: the bundled fake-pm)")
    .option("--fake-mode <mode>", "good or slop for --driver fake (default: good)")
    .option("--no-worktrees", "run the agents in the project directory instead of per-agent worktrees")
    .action((goal, options) => exitWith(() => runStart(projectDir(), goal, options)));
program
    .command("watch")
    .description("Print each message header as it lands; exits on DONE or BLOCKED unless --follow")
    .option("--follow", "keep watching across DONE, BLOCKED, and the next goal")
    .action((options) => exitWith(() => runWatch(projectDir(), options)));
program
    .command("status")
    .description("Phase, roles, budgets, open assignments, last message, and the diarchy reply command if the human is needed")
    .option("--json", "machine-readable output")
    .action((options) => exitWith(() => runStatus(projectDir(), options)));
// ---------------------------------------------------------------------------
// Human controls
// ---------------------------------------------------------------------------
program
    .command("reply")
    .argument("<text>", "your ruling, one sentence")
    .description("Answer a BLOCKED run with a DECIDE (basis human) and resume")
    .option("--decision <id>", "thread to close: plan or D<n> (default: a new D<n>)")
    .option("--budget <key=value>", "raise a limit for the rest of the goal (repeatable)", collect, [])
    .option("--body <text>", "free text under the ruling")
    .option("--json", "machine-readable output")
    .action((text, options) => exitWith(() => runReply(projectDir(), text, options)));
program
    .command("stop")
    .description("Leave the goal BLOCKED with a human BLOCKED message and stop a running diarchy start")
    .option("--reason <text>", "why (default: stopped by the human)")
    .option("--json", "machine-readable output")
    .action((options) => exitWith(() => runStop(projectDir(), options)));
// ---------------------------------------------------------------------------
// Hooks and the MCP server
// ---------------------------------------------------------------------------
program
    .command("inbox-skim")
    .description("SessionStart hook: a 15-line brief of the active goal for one agent; prints nothing without a goal")
    .requiredOption("--agent <id>", "agent id (claude | codex)")
    .action((options) => {
    try {
        const lines = runInboxSkim(projectDir(), options.agent);
        if (lines.length > 0)
            process.stdout.write(`${lines.join("\n")}\n`);
    }
    catch {
        // the hook must never break a session
    }
    process.exit(EXIT_OK);
});
program
    .command("gate")
    .description('Stop hook: print {"decision":"block",...} while this agent owes the goal something; never throws')
    .requiredOption("--agent <id>", "agent id (claude | codex)")
    .action(async (options) => {
    try {
        await readStdin(1_500);
        const decision = runGate(projectDir(), options.agent);
        if (decision !== null)
            process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
    catch {
        // the hook must never break a session
    }
    process.exit(EXIT_OK);
});
program
    .command("guard")
    .description("PreToolUse hook: print a deny decision when the shell command on stdin runs diarchy reply or diarchy stop; never throws")
    .requiredOption("--agent <id>", "agent id (claude | codex)")
    .action(async (options) => {
    try {
        const decision = runGuard(options.agent, await readStdin(1_500));
        if (decision !== null)
            process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
    catch {
        // the hook must never break a session
    }
    process.exit(EXIT_OK);
});
program
    .command("mcp")
    .description("Run the diarchy MCP server on stdio for one agent (used by the Claude Code and Codex plugins)")
    .requiredOption("--agent <id>", "agent id this server posts as")
    .action((options) => exitWith(async () => {
    await startMcpServer({ projectDir: projectDir(), agent: options.agent });
    return EXIT_OK;
}));
program.parseAsync(process.argv).catch((error) => {
    console.error(`diarchy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_ERROR);
});
//# sourceMappingURL=index.js.map