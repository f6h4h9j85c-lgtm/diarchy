/**
 * The three hook-facing commands. None throws, all exit 0, and the two that
 * read the vault leave the agent's inbox cursor where it is.
 *
 * `inbox-skim --agent <id>` (SessionStart): a brief of at most 15 lines, or
 * nothing when no goal is active.
 *
 * `gate --agent <id>` (Stop): `{"decision":"block","reason":"..."}` while the
 * agent owes the goal something in PLAN/EXECUTE, else nothing. After
 * GATE_CAP consecutive blocks with no new message (tracked in
 * `.diarchy/gate-<agent>.json`) it stops blocking so a stuck agent can end its turn.
 *
 * `guard --agent <id>` (PreToolUse): a deny decision when the shell command
 * on stdin runs `diarchy reply` or `diarchy stop`, the human's commands.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIELD_MAX_CHARS, oneLine, roleOf } from "../protocol/index.js";
import { budgetLine } from "../vault/render/shared.js";
import { nextStep, openAssignments, unreadFor } from "./brief.js";
import { headerLine, humanStore } from "./common.js";
export const GATE_CAP = 12;
const SKIM_MAX_LINES = 15;
const SKIM_MAX_HEADERS = 8;
export function runInboxSkim(projectDir, agent) {
    const store = humanStore(projectDir);
    const goal = store.activeGoal();
    if (goal === null)
        return [];
    const state = store.state();
    if (state === null || state.goal !== goal.goalId)
        return [];
    const messages = store.listMessages();
    const unread = unreadFor(goal, messages, agent);
    const lines = [];
    lines.push(`diarchy goal ${goal.goalId} · phase ${state.phase} · you are ${agent} (${roleOf(state, agent)})`);
    lines.push(`budget: ${budgetLine(state)}`);
    const owed = openAssignments(state, agent);
    if (owed.length > 0) {
        const items = owed.map((item) => (item.kind === "review" ? `review of ${oneLine(item.pr ?? "?", FIELD_MAX_CHARS)}` : `${item.task} implement`));
        lines.push(`your open assignments: ${items.join(", ")}`);
    }
    lines.push(`unread: ${unread.length} message${unread.length === 1 ? "" : "s"}`);
    const shown = unread.slice(-SKIM_MAX_HEADERS);
    if (unread.length > shown.length)
        lines.push(`  (${unread.length - shown.length} older not shown)`);
    for (const message of shown)
        lines.push(`  ${headerLine(message)}`);
    lines.push(`next: ${nextStep(state, messages, agent, unread).text}`);
    // Cap output lines, not array entries, so no entry can stretch the brief past 15 lines.
    return lines.join("\n").split("\n").slice(0, SKIM_MAX_LINES);
}
export function gateRecordPath(projectDir, agent) {
    return join(projectDir, ".diarchy", `gate-${agent}.json`);
}
function loadGateRecord(path) {
    const empty = { blocks: 0, last_message_id: null, updated: "" };
    if (!existsSync(path))
        return empty;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        return {
            blocks: typeof raw.blocks === "number" && Number.isFinite(raw.blocks) ? raw.blocks : 0,
            last_message_id: typeof raw.last_message_id === "string" ? raw.last_message_id : null,
            updated: typeof raw.updated === "string" ? raw.updated : "",
        };
    }
    catch {
        return empty;
    }
}
function saveGateRecord(path, record) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}
/** The block decision, or null to let the turn end. The hook JSON on stdin is drained by the caller and not needed. */
export function runGate(projectDir, agent) {
    const store = humanStore(projectDir);
    const goal = store.activeGoal();
    if (goal === null || (goal.phase !== "PLAN" && goal.phase !== "EXECUTE"))
        return null;
    const state = store.state();
    if (state === null || state.goal !== goal.goalId)
        return null;
    const messages = store.listMessages();
    const unread = unreadFor(goal, messages, agent);
    const step = nextStep(state, messages, agent, unread);
    const path = gateRecordPath(projectDir, agent);
    const lastId = messages.length === 0 ? null : messages[messages.length - 1].id;
    let record = loadGateRecord(path);
    if (record.last_message_id !== lastId)
        record = { blocks: 0, last_message_id: lastId, updated: "" };
    if (!step.owes) {
        if (record.blocks !== 0)
            saveGateRecord(path, { ...record, blocks: 0, updated: new Date().toISOString() });
        return null;
    }
    if (record.blocks >= GATE_CAP)
        return null;
    saveGateRecord(path, { blocks: record.blocks + 1, last_message_id: lastId, updated: new Date().toISOString() });
    return { decision: "block", reason: `diarchy goal ${goal.goalId} (${state.phase}): ${step.text}.` };
}
// ---------------------------------------------------------------------------
// guard (PreToolUse): the human's commands are not for a PM
// ---------------------------------------------------------------------------
/** Shell operators that start a new simple command. */
const COMMAND_SEPARATORS = /\|\||&&|\$\(|[;|&\n()`]/;
/** Words that may precede the program without being it. */
const PRELUDE = new Set(["sudo", "env", "exec", "command", "nohup", "time", "node", "npx", "npm", "pnpm", "yarn", "bun", "tsx"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `diarchy`, `bin/diarchy.js`, `/abs/path/diarchy.js`, `./node_modules/.bin/diarchy`. */
const PROGRAM = /^(?:[\w.~/-]*\/)?diarchy(?:\.js)?$/;
/**
 * The human subcommand a shell command would run (`reply` or `stop`), else
 * null. Each simple command is read as `[VAR=x ...] [sudo|env|node|npx ...]
 * <program> [--project <dir>] <subcommand>`, so the words inside an argument
 * (`grep "diarchy reply" docs/`) do not count. Best effort by design: a
 * `bash -c '...'` string, an alias, or a wrapper script is not unpacked
 * (ANTI-SLOP.md, What this does NOT prevent).
 */
export function humanCommand(command) {
    for (const segment of command.split(COMMAND_SEPARATORS)) {
        const words = segment.trim().split(/\s+/).filter((word) => word !== "");
        let i = 0;
        while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || PRELUDE.has(words[i]) || words[i].startsWith("-")))
            i += 1;
        if (i >= words.length || !PROGRAM.test(words[i]))
            continue;
        i += 1;
        while (i < words.length && words[i].startsWith("-"))
            i += /^--?project$/.test(words[i]) ? 2 : 1;
        const subcommand = words[i];
        if (subcommand === "reply" || subcommand === "stop")
            return subcommand;
    }
    return null;
}
/**
 * The PreToolUse deny for a shell call that runs `diarchy reply` or
 * `diarchy stop`, else null. `hookJson` is the hook event on stdin; anything
 * that is not an event with a string `tool_input.command` is let through.
 */
export function runGuard(agent, hookJson) {
    let command;
    try {
        const event = JSON.parse(hookJson);
        command = event?.tool_input?.command;
    }
    catch {
        return null;
    }
    if (typeof command !== "string")
        return null;
    const subcommand = humanCommand(command);
    if (subcommand === null)
        return null;
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `diarchy ${subcommand} posts as the human, and ${agent} is a PM. The human answers from their own terminal; call wait_for_reply instead.`,
        },
    };
}
//# sourceMappingURL=hooks.js.map