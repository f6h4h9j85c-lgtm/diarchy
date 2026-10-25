/**
 * How `diarchy start` spawns one PM per agent.
 *
 * Real driver: `claude -p --permission-mode acceptEdits --permission-prompts none
 * --allowedTools <diarchy MCP tools and git, npm, node, gh> "<prompt>"` and
 * `codex exec --sandbox workspace-write "<prompt>"` (command and base flags
 * from diarchy.config.json `agents.<id>`), cwd the agent's worktree, env
 * DIARCHY_AGENT and DIARCHY_PROJECT so the MCP server and hooks find the vault.
 *
 * Session resume is best effort and keyed by goal in `.diarchy/sessions/<agent>.json`:
 * - claude: the launcher mints a UUID and passes `--session-id <uuid>` on the
 *   first spawn, so the id is known without parsing output; a restart passes
 *   `--resume <uuid>` instead.
 * - codex: `codex exec` prints no stable id by default, so the launcher scans
 *   stdout and stderr for `"thread_id": "<id>"` / `"session_id": "<id>"`
 *   (the `--json` event stream) or a `session id: <uuid>` banner line, and a
 *   restart runs `codex exec <flags> resume <id> "<prompt>"`.
 * - anything else: no resume.
 * A resumed child that exits non-zero within a few seconds drops its session
 * file so the next spawn starts fresh.
 *
 * Fake driver: `node [--import tsx] <fake-script> <mode>` with the same env plus
 * DIARCHY_FAKE_MODE; used by the e2e test to exercise launcher, store, and
 * engine with no model calls.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export function sessionPath(projectDir, agent) {
    return join(projectDir, ".diarchy", "sessions", `${agent}.json`);
}
/** The saved session for this agent, only when it belongs to the same goal. */
export function loadSession(projectDir, agent, goalId) {
    const path = sessionPath(projectDir, agent);
    if (!existsSync(path))
        return null;
    try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (typeof record.session_id !== "string" || record.goal !== goalId)
            return null;
        return {
            agent,
            goal: goalId,
            session_id: record.session_id,
            source: record.source === "minted" ? "minted" : "captured",
            updated: typeof record.updated === "string" ? record.updated : "",
        };
    }
    catch {
        return null;
    }
}
export function saveSession(projectDir, record) {
    const path = sessionPath(projectDir, record.agent);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}
export function clearSession(projectDir, agent) {
    rmSync(sessionPath(projectDir, agent), { force: true });
}
// ---------------------------------------------------------------------------
// Session id detection (codex, and claude when run with a JSON output format)
// ---------------------------------------------------------------------------
const JSON_ID = /"(?:session_id|sessionId|thread_id|threadId|conversation_id)"\s*:\s*"([A-Za-z0-9_-]{8,})"/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEXT_ID = new RegExp(`\\b(?:session|thread)(?:[ _-]?id)?\\s*[:=]\\s*(${UUID})\\b`, "i");
/** The session or thread id a CLI printed on this line, if any. */
export function detectSessionId(line) {
    const json = JSON_ID.exec(line);
    if (json !== null)
        return json[1];
    const text = TEXT_ID.exec(line);
    return text === null ? null : text[1];
}
// ---------------------------------------------------------------------------
// Prompt and plans
// ---------------------------------------------------------------------------
export function buildPrompt(agent, goalId) {
    return (`You are the \`${agent}\` PM in a diarchy run for goal \`${goalId}\`. ` +
        "Load the diarchy-pm skill, call the diarchy `read` tool first, then act on your role. " +
        "Do not stop until the goal is DONE or BLOCKED.");
}
export function flavorOf(command) {
    const name = basename(command).toLowerCase();
    if (name.startsWith("claude"))
        return "claude";
    if (name.startsWith("codex"))
        return "codex";
    return "generic";
}
function baseEnv(input) {
    const env = {
        ...process.env,
        DIARCHY_AGENT: input.agent,
        DIARCHY_PROJECT: input.projectDir,
        DIARCHY_GOAL: input.goalId,
    };
    if (input.worktree !== null)
        env.DIARCHY_WORKTREE = input.worktree;
    else
        delete env.DIARCHY_WORKTREE;
    return env;
}
export function realPlan(input) {
    const flavor = flavorOf(input.launch.command);
    const prompt = buildPrompt(input.agent, input.goalId);
    const args = [...input.launch.args];
    let resumed = false;
    let minted = null;
    if (input.session !== null && flavor === "claude") {
        args.push("--resume", input.session.session_id);
        resumed = true;
    }
    else if (input.session !== null && flavor === "codex") {
        args.push("resume", input.session.session_id);
        resumed = true;
    }
    else if (flavor === "claude") {
        minted = {
            agent: input.agent,
            goal: input.goalId,
            session_id: randomUUID(),
            source: "minted",
            updated: new Date().toISOString(),
        };
        args.push("--session-id", minted.session_id);
    }
    args.push(prompt);
    return { command: input.launch.command, args, cwd: input.cwd, env: baseEnv(input), resumed, flavor, minted };
}
/** `src/cli/fake-pm.ts` when running from source (needs tsx), `dist/cli/fake-pm.js` from the build. */
export function defaultFakeScript() {
    const here = fileURLToPath(import.meta.url);
    const ext = here.endsWith(".ts") ? ".ts" : ".js";
    return join(dirname(here), `fake-pm${ext}`);
}
function tsxLoader() {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve("tsx/package.json")), "dist", "loader.mjs");
}
export function fakePlan(input) {
    const args = input.script.endsWith(".ts") ? ["--import", tsxLoader(), input.script, input.mode] : [input.script, input.mode];
    return {
        command: process.execPath,
        args,
        cwd: input.cwd,
        env: { ...baseEnv(input), DIARCHY_FAKE_MODE: input.mode },
        resumed: false,
    };
}
//# sourceMappingURL=drivers.js.map