/**
 * The three hook-facing commands. None throws, all exit 0, and the two that
 * read the vault leave the agent's inbox cursor where it is.
 *
 * `inbox-skim --agent <id>` (SessionStart): a brief of at most 15 lines, or
 * nothing when no goal is active.
 *
 * `gate --agent <id>` (Stop): `{"decision":"block","reason":"..."}` while the
 * agent owes the goal something in PLAN/EXECUTE, else nothing. After
 * GATE_CAP consecutive blocks with no new message (counted per session, in
 * `.diarchy/gate-<agent>/<session_id>.json`, or `.diarchy/gate-<agent>.json`
 * when the Stop event names no session) it stops blocking so a stuck agent can
 * end its turn. It does not block a session while another session's MCP
 * server holds the agent's lease, since every diarchy tool would answer it
 * AGENT_BUSY; when it cannot tell whose server holds the lease, it blocks.
 *
 * Both read a chat file that will not parse as left out and name it, on
 * stderr and in their output. In PLAN/EXECUTE the agent then owes the BLOCKED
 * with kind external that brings the human (PROTOCOL.md section 10), so the
 * gate keeps its turn open, up to GATE_CAP, until one is posted. A
 * budget.json that will not parse leaves nothing to post: inbox-skim says to
 * stop and tell the human, and the gate lets the turn end.
 *
 * `guard --agent <id>` (PreToolUse): a deny decision when the shell command
 * on stdin runs `diarchy reply` or `diarchy stop`, the human's commands.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIELD_MAX_CHARS, oneLine, roleOf } from "../protocol/index.js";
import { CorruptVaultFileError, LOCK_HOST, leaseHolder } from "../vault/index.js";
import { budgetLine } from "../vault/render/shared.js";
import { nextStep, openAssignments, unreadFor } from "./brief.js";
import { headerLine, humanStore } from "./common.js";
export const GATE_CAP = 12;
const SKIM_MAX_LINES = 15;
const SKIM_MAX_HEADERS = 8;
/** A stored vault file that will not parse, as one line: the file, and its problem cut to FIELD_MAX_CHARS. */
function corruptText(error) {
    return `Vault file ${oneLine(error.file, Number.MAX_SAFE_INTEGER)} is corrupt: ${oneLine(error.problem, FIELD_MAX_CHARS)}.`;
}
/** The active goal's messages, leaving out each chat file that will not parse: that file is named on stderr for the human, and returned. */
function readChat(store) {
    const corrupt = [];
    const messages = store.listMessages((error) => {
        corrupt.push(error);
        console.error(`diarchy: ${corruptText(error)} It is left out here; repair that file, or stop the run with diarchy stop.`);
    });
    return { messages, corrupt };
}
/** What a PM owes in PLAN/EXECUTE while a chat file will not parse: the BLOCKED that brings the human (PROTOCOL.md section 10). */
function corruptStep(error) {
    return { text: `${corruptText(error)} Post BLOCKED with kind external naming that file (call post), so the human can repair it or run diarchy stop`, owes: true };
}
/**
 * The step the Stop gate acts on for `agent`, with the messages it read: in
 * PLAN/EXECUTE a chat file that will not parse makes it the BLOCKED that
 * brings the human, else it is `nextStep`. The supervisor parks a PM by it.
 */
export function gateStep(store, goal, state, agent) {
    const { messages, corrupt } = readChat(store);
    if (corrupt.length > 0 && (state.phase === "PLAN" || state.phase === "EXECUTE"))
        return { step: corruptStep(corrupt[0]), messages };
    return { step: nextStep(state, messages, agent, unreadFor(goal, messages, agent)), messages };
}
export function runInboxSkim(projectDir, agent) {
    const store = humanStore(projectDir);
    let goal;
    try {
        goal = store.activeGoal();
    }
    catch (error) {
        // budget.json will not parse (the store names it on stderr), so no tool can reach the goal.
        if (!(error instanceof CorruptVaultFileError))
            throw error;
        return [`diarchy: ${corruptText(error)} Nothing can be posted to this goal: stop and tell the human, naming the file.`];
    }
    if (goal === null)
        return [];
    const state = store.state();
    if (state === null || state.goal !== goal.goalId)
        return [];
    const { messages, corrupt } = readChat(store);
    const unread = unreadFor(goal, messages, agent);
    const owesBlocked = corrupt.length > 0 && (state.phase === "PLAN" || state.phase === "EXECUTE");
    const lines = [];
    lines.push(`diarchy goal ${goal.goalId} · phase ${state.phase} · you are ${agent} (${roleOf(state, agent)})`);
    if (corrupt.length > 0) {
        lines.push(`vault: ${oneLine(corrupt[0].file, Number.MAX_SAFE_INTEGER)} is corrupt and left out here${owesBlocked ? "; post BLOCKED kind external naming it" : ""}`);
    }
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
    lines.push(`next: ${(owesBlocked ? corruptStep(corrupt[0]) : nextStep(state, messages, agent, unread)).text}`);
    // Cap output lines, not array entries, so no entry can stretch the brief past 15 lines.
    return lines.join("\n").split("\n").slice(0, SKIM_MAX_LINES);
}
/** The Stop event's `session_id`, made safe for a file name; null when the event names none. */
function gateSessionKey(hookJson) {
    let id;
    try {
        id = JSON.parse(hookJson)?.session_id;
    }
    catch {
        return null;
    }
    if (typeof id !== "string" || id === "")
        return null;
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);
}
/** One record per session, so blocks of one session never use up another's GATE_CAP. */
export function gateRecordPath(projectDir, agent, session = null) {
    const dir = join(projectDir, ".diarchy");
    return session === null ? join(dir, `gate-${agent}.json`) : join(dir, `gate-${agent}`, `${session}.json`);
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
/** The parent of `pid`: /proc on Linux, `ps` elsewhere; null when it cannot be read. */
function parentPid(pid) {
    if (pid === process.pid)
        return process.ppid;
    if (existsSync("/proc/self/stat")) {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            // Fields after "(comm)": state, then ppid.
            const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            return Number.isInteger(ppid) ? ppid : null;
        }
        catch {
            return null;
        }
    }
    if (process.platform === "win32")
        return null;
    const ps = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const ppid = ps.status === 0 ? Number((ps.stdout ?? "").trim()) : Number.NaN;
    return Number.isInteger(ppid) ? ppid : null;
}
/** The arguments `pid` runs with: /proc on Linux, `ps` elsewhere (split on spaces); null when they cannot be read. */
function argvOf(pid) {
    if (existsSync("/proc/self/cmdline")) {
        try {
            return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((word) => word !== "");
        }
        catch {
            return null;
        }
    }
    if (process.platform === "win32")
        return null;
    const ps = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    return ps.status === 0 ? (ps.stdout ?? "").trim().split(/\s+/) : null;
}
/** Programs that only start another one: shells, env, and the package runners. */
const LAUNCHERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "env", "npx", "npm", "pnpm", "yarn", "bunx"]);
/**
 * Whether `argv` is a launch wrapper a CLI may start its MCP server through:
 * a shell, env, npx or `npm exec` (whose process title reads `npm exec`),
 * pnpm, yarn, bunx, or bin/diarchy.js handing `mcp` on to the diarchy on PATH.
 */
export function isLaunchWrapper(argv) {
    const name = (word) => (word ?? "").split("/").pop() ?? "";
    if (argv.length === 0)
        return false;
    if (argv[0].startsWith("npm exec"))
        return true;
    // A runner started as `node /usr/bin/npx ...` before it sets its title.
    const program = name(argv[0]) === "node" ? name(argv[1]).replace(/(?:-cli)?\.[cm]?js$/, "") : name(argv[0]);
    if (LAUNCHERS.has(program))
        return true;
    const script = argv.findIndex((word) => /(?:^|\/)diarchy(?:\.js)?$/.test(word));
    return script !== -1 && argv[script + 1] === "mcp";
}
const THIS_PROCESS = {
    host: LOCK_HOST,
    pid: process.pid,
    parentOf: parentPid,
    isWrapper: (pid) => {
        const argv = argvOf(pid);
        return argv !== null && isLaunchWrapper(argv);
    },
};
/** Launch wrappers stepped over between the lease holder and its CLI; behind more, the gate cannot tell. */
const MAX_WRAPPERS = 4;
/** The machine part of a lock host: LOCK_HOST adds the pid namespace on Linux. */
function machineOf(host) {
    return host.replace(/ pid:\[\d+\]$/, "");
}
/**
 * Whether `pid` is this process or one of its ancestors: null when a parent
 * on the way up cannot be read, so the chain is not known to its root.
 */
function isOwnAncestor(pid, probe) {
    let current = probe.pid;
    for (let depth = 0; depth < 64; depth += 1) {
        if (current === pid)
            return true;
        if (current <= 1)
            return false;
        const parent = probe.parentOf(current);
        if (parent === null)
            return null;
        current = parent;
    }
    return null;
}
/**
 * True only when the lease `holder` is surely another session's MCP server,
 * so this session's tools only get AGENT_BUSY. The hook and the session's own
 * server are both children of the same CLI process, so a holder whose parent
 * is one of this hook's ancestors is this session's server, and one whose
 * parent is not on the hook's chain, read up to pid 1, is another session's.
 * A CLI may start its server through launch wrappers (`sh -c`, npx, or
 * bin/diarchy.js handing on to the diarchy on PATH, `isLaunchWrapper`): up to
 * MAX_WRAPPERS of them are stepped over, so the parent compared is the CLI.
 * When it cannot tell, it answers false and the gate blocks as it would with
 * no lease: the owner file is not readable or not written yet; the holder's
 * parent is pid 1 (a CLI that is itself pid 1 in a container, or an orphaned
 * server); a parent cannot be read (Windows); more than MAX_WRAPPERS wrappers
 * stand in a row; or the holder is on this machine but in another pid
 * namespace, where its pids mean nothing here. A holder on another machine is
 * another session.
 */
export function heldByAnotherSession(holder, probe = THIS_PROCESS) {
    if (holder === null || holder.pid <= 0)
        return false;
    if (holder.host !== probe.host)
        return machineOf(holder.host) !== machineOf(probe.host);
    let parent = probe.parentOf(holder.pid);
    for (let hops = 0; parent !== null && parent > 1 && probe.isWrapper?.(parent) === true; hops += 1) {
        if (hops === MAX_WRAPPERS)
            return false;
        parent = probe.parentOf(parent);
    }
    if (parent === null || parent <= 1)
        return false;
    return isOwnAncestor(parent, probe) === false;
}
/** How many times in a row the gate has blocked the session this Stop event names (0 once nothing is owed). */
export function gateBlockCount(projectDir, agent, hookJson = "") {
    return loadGateRecord(gateRecordPath(projectDir, agent, gateSessionKey(hookJson))).blocks;
}
/**
 * The block decision, or null to let the turn end. `hookJson` is the Stop
 * event on stdin; its `session_id` keys the GATE_CAP record.
 */
export function runGate(projectDir, agent, hookJson = "") {
    const store = humanStore(projectDir);
    const goal = store.activeGoal();
    if (goal === null || (goal.phase !== "PLAN" && goal.phase !== "EXECUTE"))
        return null;
    if (heldByAnotherSession(leaseHolder(goal.paths, agent)))
        return null;
    const state = store.state();
    if (state === null || state.goal !== goal.goalId)
        return null;
    const { step, messages } = gateStep(store, goal, state, agent);
    const path = gateRecordPath(projectDir, agent, gateSessionKey(hookJson));
    const lastId = messages.length === 0 ? null : messages[messages.length - 1].id;
    let record = loadGateRecord(path);
    if (record.last_message_id !== lastId)
        record = { blocks: 0, last_message_id: lastId, updated: "" };
    if (!step.owes) {
        // Nothing owed: the count starts over, and a finished session leaves no record behind.
        rmSync(path, { force: true });
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
const COMMAND_SEPARATORS = /\|\||&&|\$\(|[;|&\n()`]/g;
/** Words that may precede the program without being it: wrappers, and the reserved words that open a command (`then diarchy stop`). */
const PRELUDE = new Set(["sudo", "env", "exec", "command", "nohup", "time", "timeout", "nice", "node", "npx", "npm", "pnpm", "yarn", "bun", "tsx", "if", "elif", "while", "until", "then", "do", "else", "!", "{"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A count or duration a prelude word takes (`timeout 60`, `nice -n 5`): never the program. */
const PRELUDE_NUMBER = /^[+-]?\d+(?:\.\d+)?[smhd]?$/;
/** `diarchy`, `bin/diarchy.js`, `/abs/path/diarchy.js`, `./node_modules/.bin/diarchy`. */
const PROGRAM = /^(?:[\w.~/-]*\/)?diarchy(?:\.js)?$/;
const SHELL = /^(?:[\w.~/-]*\/)?(?:bash|sh|zsh|dash|ksh)$/;
/** A word that runs text as code: a line that has one gets no exemption (`cat > x.sh <<'EOF' ... bash x.sh`). */
const RUNS_CODE = /^(?:(?:[\w.~/-]*\/)?(?:bash|sh|zsh|dash|ksh)|eval|source)$/;
/** Words that open a compound command or a group; the reader does not follow them. */
const COMPOUND = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "for", "case", "esac", "select", "function", "time", "coproc", "{", "}", "!", "[[", "]]"]);
/** Characters a backslash escapes inside double quotes. */
const DQ_ESCAPABLE = '$`"\\\n';
const GIT_DATA = new Set(["commit", "tag", "notes"]);
const GH_DATA = new Set(["pr", "issue", "release", "api"]);
/** The index of the program in `[VAR=x ...] [prelude ...] <program> ...`. */
function programAt(words) {
    let i = 0;
    while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || PRELUDE.has(words[i]) || PRELUDE_NUMBER.test(words[i]) || words[i].startsWith("-")))
        i += 1;
    return i;
}
/** In `[VAR=x ...] [prelude ...] <program> [--project <dir>] <subcommand>`, the indexes of the program and the human subcommand, else null. */
function humanWords(words) {
    const i = programAt(words);
    if (!PROGRAM.test(words.at(i) ?? ""))
        return null;
    let k = i + 1;
    while (k < words.length && words[k].startsWith("-"))
        k += /^--?project$/.test(words[k]) ? 2 : 1;
    return words.at(k) === "reply" || words.at(k) === "stop" ? [i, k] : null;
}
/** What the original guard denies, and a few wrappers it missed (`timeout 60`, `then`, `{`): each piece between operators, quoting ignored, read by `humanWords`. */
function splitHits(command) {
    const hits = [];
    const separators = new RegExp(COMMAND_SEPARATORS);
    let from = 0;
    for (;;) {
        const separator = separators.exec(command);
        const to = separator === null ? command.length : separator.index;
        const words = [...command.slice(from, to).matchAll(/\S+/g)];
        const found = humanWords(words.map((word) => word[0]));
        if (found !== null) {
            const [program, subcommand] = [words[found[0]], words[found[1]]];
            hits.push({ subcommand: subcommand[0], start: from + program.index, end: from + subcommand.index + subcommand[0].length });
        }
        if (separator === null)
            return hits;
        from = separators.lastIndex;
    }
}
class Unsure extends Error {
}
/**
 * The simple commands and inert text of `source`, read the way bash does, or
 * null for anything this reader does not follow: subshells, groups, compound
 * commands, arithmetic, `${...}`, process substitution, a backslash inside
 * backticks, a substitution in an unquoted heredoc body, an unterminated
 * quote, substitution, or heredoc.
 */
function readShell(source) {
    const commands = [];
    const inert = [];
    let runsCode = false;
    let backticks = 0;
    let i = 0;
    const unsure = () => {
        throw new Unsure();
    };
    /** Commands up to `close` (consumed), inside the substitution held by `parent`. */
    function list(close, parent) {
        const begin = (pipeline) => {
            const started = { words: [], hereStrings: [], redirections: 0, pipeline, parent };
            pipeline.push(started);
            return started;
        };
        let command = begin([]);
        let word = null;
        let role = "arg";
        const heredocs = [];
        const current = () => (word ??= { text: "", role, owner: command, quoted: false });
        const endWord = () => {
            if (word === null)
                return;
            if (word.role === "here")
                command.hereStrings.push(word.text);
            if (word.role === "arg") {
                if (command.words.length === 0 && !word.quoted && COMPOUND.has(word.text))
                    unsure();
                if (RUNS_CODE.test(word.text) || (command.words.length === 0 && word.text === "."))
                    runsCode = true;
                command.words.push(word);
            }
            word = null;
            role = "arg";
        };
        /** An empty command stays open, so `a |` or `a &&` may go on after a newline. */
        const endCommand = (piped) => {
            endWord();
            if (role !== "arg")
                unsure();
            if (command.words.length === 0 && command.hereStrings.length === 0 && command.redirections === 0) {
                if (piped)
                    unsure();
                return;
            }
            commands.push(command);
            command = begin(piped ? command.pipeline : []);
        };
        const substitution = (closer) => {
            const holder = current();
            holder.quoted = true;
            i += closer === "`" ? 1 : 2;
            if (closer === "`")
                backticks += 1;
            list(closer, holder);
            if (closer === "`")
                backticks -= 1;
        };
        const doubleQuoted = () => {
            const holder = current();
            holder.quoted = true;
            const start = i + 1;
            let substituted = false;
            i += 1;
            while (source[i] !== '"') {
                const c = source[i];
                const next = source[i + 1];
                if (c === undefined || (c === "\\" && backticks > 0) || source.startsWith("$((", i) || source.startsWith("${", i) || source.startsWith("$[", i))
                    unsure();
                if (c === "\\" && next !== undefined && DQ_ESCAPABLE.includes(next)) {
                    if (next !== "\n")
                        holder.text += next;
                    i += 2;
                }
                else if (c === "`" || source.startsWith("$(", i)) {
                    substituted = true;
                    substitution(c === "`" ? "`" : ")");
                }
                else {
                    holder.text += c;
                    i += 1;
                }
            }
            if (!substituted)
                inert.push({ start, end: i, owner: command, word: holder });
            i += 1;
        };
        const heredocOperator = (stripTabs) => {
            while (source[i] === " " || source[i] === "\t")
                i += 1;
            let delimiter = "";
            let quoted = false;
            while (i < source.length && !/[\s;&|()<>]/.test(source[i])) {
                const c = source[i];
                if (c === "'" || c === '"') {
                    const end = source.indexOf(c, i + 1);
                    if (end === -1)
                        unsure();
                    delimiter += source.slice(i + 1, end);
                    i = end + 1;
                    quoted = true;
                }
                else if (c === "\\" && i + 1 < source.length) {
                    delimiter += source[i + 1];
                    i += 2;
                    quoted = true;
                }
                else if (c === "$" || c === "`" || c === "\\") {
                    unsure();
                }
                else {
                    delimiter += c;
                    i += 1;
                }
            }
            if (delimiter === "")
                unsure();
            command.redirections += 1;
            return { delimiter, quoted, stripTabs, owner: command };
        };
        /** The body starting at `i`, through its delimiter line. */
        const heredocBody = (doc) => {
            const start = i;
            for (;;) {
                if (i >= source.length)
                    unsure();
                const newline = source.indexOf("\n", i);
                const lineEnd = newline === -1 ? source.length : newline;
                const line = source.slice(i, lineEnd);
                if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter)
                    break;
                i = lineEnd + 1;
            }
            if (doc.quoted)
                inert.push({ start, end: i, owner: doc.owner, word: null });
            // The commands of a substitution in an unquoted body are not read, so do not guess.
            else if (/\$\(|`/.test(source.slice(start, i)))
                unsure();
            const newline = source.indexOf("\n", i);
            i = newline === -1 ? source.length : newline + 1;
        };
        const redirection = () => {
            if (source[i + 1] === "(")
                unsure();
            // An unquoted number right before the operator is its fd (`2>&1`), not an argument.
            if (word !== null && word.role === "arg" && !word.quoted && /^\d+$/.test(word.text))
                word = null;
            else
                endWord();
            const operator = /^(?:<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/.exec(source.slice(i, i + 3))?.[0] ?? unsure();
            i += operator.length;
            if (operator === "<<" || operator === "<<-") {
                heredocs.push(heredocOperator(operator === "<<-"));
            }
            else {
                role = operator === "<<<" ? "here" : "target";
                command.redirections += 1;
            }
        };
        while (i < source.length) {
            const c = source[i];
            const next = source[i + 1];
            if (c === close) {
                i += 1;
                endCommand(false);
                if (heredocs.length > 0)
                    unsure();
                return;
            }
            if (c === "\\") {
                if (next === undefined || backticks > 0)
                    unsure();
                if (next !== "\n") {
                    current().text += next;
                    current().quoted = true;
                }
                i += 2;
            }
            else if (c === "'") {
                const end = source.indexOf("'", i + 1);
                if (end === -1)
                    unsure();
                const holder = current();
                holder.quoted = true;
                holder.text += source.slice(i + 1, end);
                inert.push({ start: i + 1, end, owner: command, word: holder });
                i = end + 1;
            }
            else if (c === "$" && next === "'") {
                let end = i + 2;
                while (end < source.length && source[end] !== "'")
                    end += source[end] === "\\" ? 2 : 1;
                if (end >= source.length)
                    unsure();
                const holder = current();
                holder.quoted = true;
                holder.text += source.slice(i + 2, end);
                i = end + 1;
            }
            else if (c === '"') {
                doubleQuoted();
            }
            else if (c === "`" || (c === "$" && next === "(")) {
                if (source.startsWith("$((", i))
                    unsure();
                substitution(c === "`" ? "`" : ")");
            }
            else if (c === "$" && (next === "{" || next === "[")) {
                unsure();
            }
            else if (c === "#" && word === null) {
                const newline = source.indexOf("\n", i);
                i = newline === -1 ? source.length : newline;
            }
            else if (c === " " || c === "\t") {
                endWord();
                i += 1;
            }
            else if (c === "\n") {
                endCommand(false);
                i += 1;
                for (const doc of heredocs.splice(0))
                    heredocBody(doc);
            }
            else if (c === ";") {
                if (next === ";")
                    unsure();
                endCommand(false);
                i += 1;
            }
            else if (c === "|") {
                endCommand(next !== "|");
                i += next === "|" || next === "&" ? 2 : 1;
            }
            else if (c === "&" && next === ">") {
                endWord();
                role = "target";
                command.redirections += 1;
                i += source[i + 2] === ">" ? 3 : 2;
            }
            else if (c === "&") {
                endCommand(false);
                i += next === "&" ? 2 : 1;
            }
            else if (c === "<" || c === ">") {
                redirection();
            }
            else if (c === "(" || c === ")") {
                unsure();
            }
            else {
                current().text += c;
                i += 1;
            }
        }
        endCommand(false);
        if (close !== null || heredocs.length > 0)
            unsure();
    }
    try {
        list(null, null);
    }
    catch (error) {
        // Too deep a nesting of substitutions overflows the stack: read as unsure too.
        if (error instanceof Unsure || error instanceof RangeError)
            return null;
        throw error;
    }
    return { commands, inert: inert.sort((a, b) => a.start - b.start), runsCode };
}
/** Whether `command` is a program that only passes text along: echo, cat, tee, printf without -v, git commit|tag|notes, gh pr|issue|release|api. */
function dataProgram(command) {
    const [program, ...args] = command.words.map((word) => word.text);
    switch (program) {
        case "echo":
        case "cat":
        case "tee":
            return true;
        case "printf":
            return !args.some((arg) => arg.startsWith("-v"));
        case "git": {
            let k = 0;
            while (args[k] === "-C" || args[k] === "--no-pager")
                k += args[k] === "-C" ? 2 : 1;
            return GIT_DATA.has(args.at(k) ?? "");
        }
        case "gh":
            return GH_DATA.has(args.at(0) ?? "");
        default:
            return false;
    }
}
/** Whether what `command` reads ends up only as data: every stage of its pipeline is a data program, and a substitution holding it is an argument of one. Memoized per command and per pipeline. */
function dataOnly(command, memo) {
    let pipeline = memo.get(command.pipeline);
    if (pipeline === undefined) {
        pipeline = command.pipeline.every(dataProgram);
        memo.set(command.pipeline, pipeline);
    }
    let known = memo.get(command);
    if (known === undefined) {
        const parent = command.parent;
        known = pipeline && (parent === null || (parent.role !== "target" && parent.owner.words[0] !== parent && dataOnly(parent.owner, memo)));
        memo.set(command, known);
    }
    return known;
}
/** Whether `hit` lies wholly inside inert text that an argument or the stdin of a data-only command holds. */
function inertData(hit, reading, memo) {
    const { inert } = reading;
    let low = 0;
    let high = inert.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (inert[middle].start <= hit.start)
            low = middle + 1;
        else
            high = middle;
    }
    const text = inert.at(low - 1);
    if (text === undefined || hit.end > text.end)
        return false;
    if (text.word !== null && (text.word.role === "target" || text.owner.words[0] === text.word))
        return false;
    return dataOnly(text.owner, memo);
}
/** The script of a shell given the words after it: the first operand once an option cluster has `c` (`-c`, `-lc`), else null. */
function shellScript(args) {
    let dashC = false;
    for (let j = 0; j < args.length; j += 1) {
        if (/^[-+][oO]$/.test(args[j]))
            j += 1;
        else if (/^-[A-Za-z]+$/.test(args[j]))
            dashC ||= args[j].includes("c");
        else if (!args[j].startsWith("-") && !args[j].startsWith("+"))
            return dashC ? args[j] : null;
    }
    return null;
}
/** What quote removal shows: `"diarchy" reply`, a shell's `-c` string or here-string (`env sh -o pipefail -c "..."`, `bash <<< "..."`), and `eval`'s arguments. */
function readHuman(reading, depth) {
    for (const command of reading.commands) {
        const words = command.words.map((word) => word.text);
        const found = humanWords(words);
        if (found !== null)
            return words[found[1]];
        const scripts = [];
        const shell = words.findIndex((word) => SHELL.test(word));
        if (shell !== -1) {
            const script = shellScript(words.slice(shell + 1));
            scripts.push(...(script === null ? command.hereStrings : [script]));
        }
        const program = programAt(words);
        if (words.at(program) === "eval")
            scripts.push(words.slice(program + 1).join(" "));
        for (const script of scripts) {
            const subcommand = verdict(script, depth + 1);
            if (subcommand !== null)
                return subcommand;
        }
    }
    return null;
}
/**
 * The human subcommand a shell command would run (`reply` or `stop`), else
 * null. It denies what the original guard denied and lets through only text
 * that never runs:
 *
 * 1. The command is split on shell operators (`;`, `|`, `&`, `(`, `)`,
 *    backtick, newline, `$(`) with quoting ignored, and each piece is read as
 *    `[VAR=x ...] [sudo|env|timeout 60|npx|then|{ ...] <program> [--project <dir>]
 *    <subcommand>`, so `grep "diarchy reply" docs/` does not count while
 *    `bash -c 'x; diarchy stop now'`, a `bash <<'EOF'` script, and `eval` do.
 * 2. A hit from 1 is let through only when it lies wholly inside inert text
 *    (single quotes, double quotes without `$(` or backtick, or a `<<'EOF'`,
 *    `<<"EOF"`, or `<<\EOF` body) that is an argument or the stdin of a data
 *    program (echo, cat, tee, printf without -v, git commit|tag|notes, gh
 *    pr|issue|release|api) whose pipeline is all data programs and whose
 *    `$(...)`, if any, is an argument of one too: the commit and PR body
 *    heredocs, `cat >> notes.md <<'EOF'`, `echo "x; diarchy stop now"`.
 *    Nothing is let through when the line names a shell, eval, or source, or
 *    uses syntax the reader does not follow (`readShell`).
 * 3. Quote removal can add a deny: `"diarchy" reply`, a shell's `-c` string
 *    or here-string wherever the shell stands (`env sh -o pipefail -c "..."`),
 *    and `eval`'s arguments are read too.
 *
 * Best effort by design: an alias, a function, a wrapper script, and a script
 * written to a file and run by a later Bash call are not unpacked (ANTI-SLOP.md,
 * What this does NOT prevent).
 */
export function humanCommand(command) {
    return verdict(command, 0);
}
/** Scripts inside scripts (`eval eval ...`) are read this deep, no deeper. */
const MAX_DEPTH = 4;
function verdict(command, depth) {
    const hits = splitHits(command);
    const reading = readShell(command);
    if (reading === null)
        return hits.at(0)?.subcommand ?? null;
    const memo = new Map();
    for (const hit of hits)
        if (reading.runsCode || !inertData(hit, reading, memo))
            return hit.subcommand;
    return depth < MAX_DEPTH ? readHuman(reading, depth) : null;
}
/**
 * The PreToolUse deny for a shell call that runs `diarchy reply` or
 * `diarchy stop`, else null. `hookJson` is the hook event on stdin; anything
 * that is not an event with a string `tool_input.command` is let through.
 */
export function runGuard(agent, hookJson) {
    const subcommand = guardedCommand(hookJson);
    return subcommand === null ? null : guardDecision(agent, subcommand);
}
/** The human subcommand the hook event's `tool_input.command` runs, else null (also for anything that is not such an event). */
export function guardedCommand(hookJson) {
    let command;
    try {
        const event = JSON.parse(hookJson);
        command = event?.tool_input?.command;
    }
    catch {
        return null;
    }
    return typeof command === "string" ? humanCommand(command) : null;
}
export function guardDecision(agent, subcommand) {
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `diarchy ${subcommand} posts as the human, and ${agent} is a PM. The human answers from their own terminal; call wait_for_reply instead.`,
        },
    };
}
//# sourceMappingURL=hooks.js.map