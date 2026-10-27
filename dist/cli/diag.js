/**
 * The opt-in diagnostics trail: one JSON line per MCP server start, hook run,
 * and MCP tool result, appended to `<project>/.diarchy/diag.log`.
 *
 * Off unless `<project>/.diarchy/diag` exists or `DIARCHY_DIAG=1`. The file
 * marker is the switch that always works: every process resolves the project
 * anyway, and Codex starts an MCP server without the caller's environment
 * (only a fixed allowlist plus `env_vars`), so a variable would never reach it.
 * `DIARCHY_DIAG=0` keeps it off despite the marker: doctor sets it for
 * `claude mcp list`, whose health check starts the server in the project.
 *
 * A line names the process (pid, parent, the bin it ran, Node), the agent, the
 * project and how it was found, and whether DIARCHY_PROJECT and DIARCHY_AGENT
 * were set. It never holds an environment value or the text of a command.
 * Writing it never throws: a hook must never break a session.
 */
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../index.js";
/** Relative to the project: the marker that turns the trail on, and the trail itself. */
export const DIAG_MARKER = join(".diarchy", "diag");
export const DIAG_LOG = join(".diarchy", "diag.log");
/** Longest line written, in bytes; a longer one keeps only who and what. */
export const DIAG_MAX_LINE = 2048;
export function diagEnabled(projectDir) {
    try {
        const flag = process.env.DIARCHY_DIAG;
        return flag !== "0" && (flag === "1" || existsSync(join(projectDir, DIAG_MARKER)));
    }
    catch {
        return false;
    }
}
function binPath() {
    const entry = process.argv[1];
    if (entry === undefined)
        return null;
    try {
        return realpathSync(entry);
    }
    catch {
        return entry;
    }
}
const isSet = (name) => (process.env[name] ?? "") !== "";
/** Append one event to the trail when it is on. Never throws. */
export function diag(where, agent, event, fields = {}) {
    try {
        if (!diagEnabled(where.dir))
            return;
        const head = { ts: new Date().toISOString(), pid: process.pid, ppid: process.ppid, event, agent };
        let line = JSON.stringify({
            ...head,
            version: VERSION,
            bin: binPath(),
            node: process.version,
            cwd: process.cwd(),
            project: where.dir,
            project_source: where.source ?? null,
            diarchy_project_set: isSet("DIARCHY_PROJECT"),
            diarchy_agent_set: isSet("DIARCHY_AGENT"),
            ...fields,
        });
        if (Buffer.byteLength(line) > DIAG_MAX_LINE)
            line = JSON.stringify({ ...head, truncated: true });
        mkdirSync(join(where.dir, ".diarchy"), { recursive: true });
        appendFileSync(join(where.dir, DIAG_LOG), `${line}\n`);
    }
    catch {
        // diagnostics must never break what they observe
    }
}
/** The class of an error, for a line that must not carry its message. */
export function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
//# sourceMappingURL=diag.js.map