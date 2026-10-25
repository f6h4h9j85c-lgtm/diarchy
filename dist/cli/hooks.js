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
/** Characters that end a simple command outside quotes. */
const OPERATORS = ";&|()\n";
/** Characters a backslash escapes inside double quotes. */
const DQ_ESCAPABLE = '$`"\\\n';
/** Words that may precede the program without being it. */
const PRELUDE = new Set(["sudo", "env", "exec", "command", "nohup", "time", "node", "npx", "npm", "pnpm", "yarn", "bun", "tsx"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `diarchy`, `bin/diarchy.js`, `/abs/path/diarchy.js`, `./node_modules/.bin/diarchy`. */
const PROGRAM = /^(?:[\w.~/-]*\/)?diarchy(?:\.js)?$/;
/** A shell whose `-c` string is a command line of its own. */
const SHELL = /^(?:[\w.~/-]*\/)?(?:bash|sh|zsh|dash|ksh)$/;
/**
 * The simple commands a shell would run from `source`, each as its words after
 * quote removal. Single-quoted text, comments, and the bodies of
 * quoted-delimiter heredocs are inert; a `$(...)` or backtick substitution,
 * bare, inside double quotes, or inside an unquoted-delimiter heredoc body,
 * adds its own commands. `heredocBody` reads `source` as such a body.
 */
function simpleCommands(source, heredocBody = false) {
    const commands = [];
    let i = 0;
    /** Commands up to `close` (consumed) or the end. `arith`: inside `$((...))`, where `<<` is a shift. */
    function list(close, arith = false) {
        let words = [];
        let word = null;
        const heredocs = [];
        let parens = 0;
        const endWord = () => {
            if (word !== null)
                words.push(word);
            word = null;
        };
        const endCommand = () => {
            endWord();
            if (words.length > 0)
                commands.push(words);
            words = [];
        };
        while (i < source.length) {
            const c = source[i];
            if (c === close && (close === "`" || parens === 0)) {
                i += 1;
                break;
            }
            if (c === "\\") {
                if (source[i + 1] !== "\n")
                    word = (word ?? "") + (source[i + 1] ?? "");
                i += 2;
            }
            else if (c === "'") {
                const end = source.indexOf("'", i + 1);
                word = (word ?? "") + source.slice(i + 1, end === -1 ? source.length : end);
                i = end === -1 ? source.length : end + 1;
            }
            else if (source.startsWith("$'", i)) {
                let end = i + 2;
                while (end < source.length && source[end] !== "'")
                    end += source[end] === "\\" ? 2 : 1;
                word = (word ?? "") + source.slice(i + 2, end);
                i = end + 1;
            }
            else if (c === '"') {
                i += 1;
                word = (word ?? "") + text('"');
            }
            else if (c === "`" || source.startsWith("$(", i)) {
                substitution();
                word = word ?? "";
            }
            else if (source.startsWith("<<<", i)) {
                word = `${word ?? ""}<<<`;
                i += 3;
            }
            else if (!arith && source.startsWith("<<", i)) {
                endWord();
                i += 2;
                const doc = heredocOperator();
                if (doc !== null)
                    heredocs.push(doc);
            }
            else if (c === "#" && word === null) {
                const end = source.indexOf("\n", i);
                i = end === -1 ? source.length : end;
            }
            else if (c === " " || c === "\t") {
                endWord();
                i += 1;
            }
            else if (OPERATORS.includes(c)) {
                endCommand();
                if (c === "(")
                    parens += 1;
                if (c === ")" && parens > 0)
                    parens -= 1;
                i += 1;
                if (c === "\n")
                    for (const doc of heredocs.splice(0))
                        skipHeredoc(doc, close);
            }
            else {
                word = (word ?? "") + c;
                i += 1;
            }
        }
        endCommand();
    }
    /** A `$(...)`, `$((...))`, or backtick substitution starting at `i`: its commands are added. */
    function substitution() {
        if (source[i] === "`") {
            i += 1;
            list("`");
        }
        else if (source.startsWith("$((", i)) {
            i += 3;
            list(")", true);
            if (source[i] === ")")
                i += 1;
        }
        else {
            i += 2;
            list(")");
        }
    }
    /** Double-quoted text up to `end` (consumed), or a heredoc body to the end: literal except for substitutions. */
    function text(end) {
        let out = "";
        while (i < source.length) {
            const c = source[i];
            if (c === end) {
                i += 1;
                break;
            }
            if (c === "\\" && i + 1 < source.length && DQ_ESCAPABLE.includes(source[i + 1])) {
                if (source[i + 1] !== "\n")
                    out += source[i + 1];
                i += 2;
            }
            else if (c === "`" || source.startsWith("$(", i)) {
                substitution();
            }
            else {
                out += c;
                i += 1;
            }
        }
        return out;
    }
    /** The delimiter word after `<<` (and an optional `-`); any quoting in it makes the body literal. */
    function heredocOperator() {
        const stripTabs = source[i] === "-";
        if (stripTabs)
            i += 1;
        while (source[i] === " " || source[i] === "\t")
            i += 1;
        let delimiter = "";
        let quoted = false;
        while (i < source.length && !/[\s;&|()<>]/.test(source[i])) {
            const c = source[i];
            if (c === "'" || c === '"') {
                const end = source.indexOf(c, i + 1);
                delimiter += source.slice(i + 1, end === -1 ? source.length : end);
                i = end === -1 ? source.length : end + 1;
                quoted = true;
            }
            else if (c === "\\") {
                delimiter += source[i + 1] ?? "";
                i += 2;
                quoted = true;
            }
            else {
                delimiter += c;
                i += 1;
            }
        }
        return delimiter === "" && !quoted ? null : { delimiter, quoted, stripTabs };
    }
    /**
     * Skips the heredoc body that starts at `i`, through its delimiter line or
     * the end. Inside a substitution, `EOF)` also ends it, as bash allows. An
     * unquoted delimiter's body still runs its substitutions.
     */
    function skipHeredoc(doc, close) {
        const start = i;
        let bodyEnd = source.length;
        while (i < source.length) {
            const newline = source.indexOf("\n", i);
            const lineEnd = newline === -1 ? source.length : newline;
            const line = source.slice(i, lineEnd);
            const bare = doc.stripTabs ? line.replace(/^\t+/, "") : line;
            if (bare === doc.delimiter) {
                bodyEnd = i;
                i = Math.min(lineEnd + 1, source.length);
                break;
            }
            if (close !== null && bare.startsWith(doc.delimiter + close)) {
                bodyEnd = i;
                i += line.length - bare.length + doc.delimiter.length;
                break;
            }
            i = lineEnd + 1;
        }
        i = Math.min(i, source.length);
        if (!doc.quoted)
            commands.push(...simpleCommands(source.slice(start, bodyEnd), true));
    }
    if (heredocBody)
        text(null);
    else
        list(null);
    return commands;
}
/** The command string of `bash -c '...'` (also `-lc`, `-ec`), given the words after the shell, else null. */
function shellCommandString(args) {
    let dashC = false;
    for (let j = 0; j < args.length; j += 1) {
        const arg = args[j];
        if (/^[-+][oO]$/.test(arg))
            j += 1;
        else if (/^-[A-Za-z]+$/.test(arg))
            dashC ||= arg.includes("c");
        else if (!arg.startsWith("-") && !arg.startsWith("+"))
            return dashC ? arg : null;
    }
    return null;
}
/**
 * The human subcommand a shell command would run (`reply` or `stop`), else
 * null. Each simple command is read as `[VAR=x ...] [sudo|env|node|npx ...]
 * <program> [--project <dir>] <subcommand>` after quote removal, so the words
 * inside an argument (`grep "diarchy reply" docs/`), single-quoted text, and a
 * quoted-delimiter heredoc body (`<<'EOF'`) do not count, while a `$(...)` or
 * backtick substitution does, even inside double quotes. The string of
 * `bash|sh|zsh -c` is read as a command line of its own. Best effort by
 * design: an alias, a function, `eval`, or a wrapper script is not unpacked
 * (ANTI-SLOP.md, What this does NOT prevent).
 */
export function humanCommand(command) {
    for (const words of simpleCommands(command)) {
        let i = 0;
        while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || PRELUDE.has(words[i]) || words[i].startsWith("-")))
            i += 1;
        if (i >= words.length)
            continue;
        if (SHELL.test(words[i])) {
            const nested = shellCommandString(words.slice(i + 1));
            const subcommand = nested === null ? null : humanCommand(nested);
            if (subcommand !== null)
                return subcommand;
            continue;
        }
        if (!PROGRAM.test(words[i]))
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