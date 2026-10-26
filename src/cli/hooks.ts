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

export function runInboxSkim(projectDir: string, agent: string): string[] {
  const store = humanStore(projectDir);
  const goal = store.activeGoal();
  if (goal === null) return [];
  const state = store.state();
  if (state === null || state.goal !== goal.goalId) return [];
  const messages = store.listMessages();
  const unread = unreadFor(goal, messages, agent);
  const lines: string[] = [];
  lines.push(`diarchy goal ${goal.goalId} · phase ${state.phase} · you are ${agent} (${roleOf(state, agent)})`);
  lines.push(`budget: ${budgetLine(state)}`);
  const owed = openAssignments(state, agent);
  if (owed.length > 0) {
    const items = owed.map((item) => (item.kind === "review" ? `review of ${oneLine(item.pr ?? "?", FIELD_MAX_CHARS)}` : `${item.task} implement`));
    lines.push(`your open assignments: ${items.join(", ")}`);
  }
  lines.push(`unread: ${unread.length} message${unread.length === 1 ? "" : "s"}`);
  const shown = unread.slice(-SKIM_MAX_HEADERS);
  if (unread.length > shown.length) lines.push(`  (${unread.length - shown.length} older not shown)`);
  for (const message of shown) lines.push(`  ${headerLine(message)}`);
  lines.push(`next: ${nextStep(state, messages, agent, unread).text}`);
  // Cap output lines, not array entries, so no entry can stretch the brief past 15 lines.
  return lines.join("\n").split("\n").slice(0, SKIM_MAX_LINES);
}

interface GateRecord {
  blocks: number;
  last_message_id: string | null;
  updated: string;
}

export function gateRecordPath(projectDir: string, agent: string): string {
  return join(projectDir, ".diarchy", `gate-${agent}.json`);
}

function loadGateRecord(path: string): GateRecord {
  const empty: GateRecord = { blocks: 0, last_message_id: null, updated: "" };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GateRecord>;
    return {
      blocks: typeof raw.blocks === "number" && Number.isFinite(raw.blocks) ? raw.blocks : 0,
      last_message_id: typeof raw.last_message_id === "string" ? raw.last_message_id : null,
      updated: typeof raw.updated === "string" ? raw.updated : "",
    };
  } catch {
    return empty;
  }
}

function saveGateRecord(path: string, record: GateRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export interface GateDecision {
  decision: "block";
  reason: string;
}

/** The block decision, or null to let the turn end. The hook JSON on stdin is drained by the caller and not needed. */
export function runGate(projectDir: string, agent: string): GateDecision | null {
  const store = humanStore(projectDir);
  const goal = store.activeGoal();
  if (goal === null || (goal.phase !== "PLAN" && goal.phase !== "EXECUTE")) return null;
  const state = store.state();
  if (state === null || state.goal !== goal.goalId) return null;
  const messages = store.listMessages();
  const unread = unreadFor(goal, messages, agent);
  const step = nextStep(state, messages, agent, unread);
  const path = gateRecordPath(projectDir, agent);
  const lastId = messages.length === 0 ? null : messages[messages.length - 1].id;
  let record = loadGateRecord(path);
  if (record.last_message_id !== lastId) record = { blocks: 0, last_message_id: lastId, updated: "" };
  if (!step.owes) {
    if (record.blocks !== 0) saveGateRecord(path, { ...record, blocks: 0, updated: new Date().toISOString() });
    return null;
  }
  if (record.blocks >= GATE_CAP) return null;
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
const PRELUDE = new Set(["sudo", "env", "exec", "command", "nohup", "time", "timeout", "nice", "node", "npx", "npm", "pnpm", "yarn", "bun", "tsx"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A count or duration a prelude word takes (`timeout 60`, `nice -n 5`): never the program. */
const PRELUDE_NUMBER = /^[+-]?\d+(?:\.\d+)?[smhd]?$/;
/** `diarchy`, `bin/diarchy.js`, `/abs/path/diarchy.js`, `./node_modules/.bin/diarchy`. */
const PROGRAM = /^(?:[\w.~/-]*\/)?diarchy(?:\.js)?$/;
/** A shell whose `-c` string, or whose script on stdin, is a command line of its own. */
const SHELL = /^(?:[\w.~/-]*\/)?(?:bash|sh|zsh|dash|ksh)$/;
/** Reserved words that may precede the program (`if`, `then`, `{`); `((` after them opens an arithmetic command. */
const RESERVED = new Set(["for", "if", "elif", "while", "until", "then", "do", "else", "!", "{", "time"]);
/** Files that are a command's stdin (`source /dev/stdin <<EOF`, `bash /dev/stdin`). */
const STDIN_FILES = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

interface SimpleCommand {
  /** The words after quote removal, here-strings left out. */
  words: string[];
  /** The text on its stdin as written: heredoc bodies and here-strings. */
  input: string[];
  /** Shared by the commands of one `a | b | c` pipeline: each reads the output of those before it. */
  pipeline: object;
  /** The commands of the `$(...)`, backtick, and `<(...)` substitutions in its words. */
  inner: SimpleCommand[];
}

interface Heredoc {
  delimiter: string;
  /** `<<'EOF'`, `<<"EOF"`, `<<\EOF`: the body is literal text. */
  quoted: boolean;
  /** `<<-EOF`: leading tabs are stripped before matching the delimiter line. */
  stripTabs: boolean;
  /** The command whose stdin the body is. */
  owner: SimpleCommand;
}

/**
 * The simple commands a shell would run from `source`, in the order they end,
 * each with its words after quote removal and the text on its stdin.
 * Single-quoted text, comments, and the bodies of quoted-delimiter heredocs
 * are inert; a `$(...)`, backtick, or `<(...)` substitution, bare, inside
 * double quotes, or inside an unquoted-delimiter heredoc body, adds its own
 * commands. `heredocBody` reads `source` as such a body.
 */
function simpleCommands(source: string, heredocBody = false): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let i = 0;

  /** Commands up to `close` (consumed) or the end. `arith`: inside `$((...))` or `((...))`, where `<<` is a shift. */
  function list(close: ")" | "`" | null, arith = false): void {
    let current: SimpleCommand = { words: [], input: [], pipeline: {}, inner: [] };
    /** Where the commands of `current`'s substitutions start in `commands`. */
    let start = commands.length;
    let word: string | null = null;
    /** The next word is a here-string (`<<< word`), not an argument. */
    let hereString = false;
    const heredocs: Heredoc[] = [];
    let parens = 0;
    const endWord = (): void => {
      if (word === null) return;
      (hereString ? current.input : current.words).push(word);
      word = null;
      hereString = false;
    };
    /** `piped`: the next command reads this one's output (`|`), or shares its pipeline (`(`, `)`). */
    const endCommand = (piped: boolean): void => {
      endWord();
      hereString = false;
      if (current.words.length > 0) {
        current.inner = commands.slice(start);
        commands.push(current);
      }
      current = { words: [], input: [], pipeline: piped ? current.pipeline : {}, inner: [] };
      start = commands.length;
    };
    while (i < source.length) {
      const c = source[i];
      if (c === close && (close === "`" || parens === 0)) {
        i += 1;
        break;
      }
      if (c === "\\") {
        if (source[i + 1] !== "\n") word = (word ?? "") + (source[i + 1] ?? "");
        i += 2;
      } else if (c === "'") {
        const end = source.indexOf("'", i + 1);
        word = (word ?? "") + source.slice(i + 1, end === -1 ? source.length : end);
        i = end === -1 ? source.length : end + 1;
      } else if (source.startsWith("$'", i)) {
        let end = i + 2;
        while (end < source.length && source[end] !== "'") end += source[end] === "\\" ? 2 : 1;
        word = (word ?? "") + source.slice(i + 2, end);
        i = end + 1;
      } else if (c === '"') {
        i += 1;
        word = (word ?? "") + text('"');
      } else if (c === "`" || source.startsWith("$(", i) || source.startsWith("<(", i) || source.startsWith(">(", i)) {
        substitution();
        word = word ?? "";
      } else if (source.startsWith("((", i) && [...current.words, ...(word === null ? [] : [word])].every((lead) => RESERVED.has(lead))) {
        endWord();
        i += 2;
        list(")", true);
        if (source[i] === ")") i += 1;
      } else if (source.startsWith("<<<", i)) {
        endWord();
        i += 3;
        hereString = true;
      } else if (!arith && source.startsWith("<<", i)) {
        endWord();
        i += 2;
        const doc = heredocOperator(current);
        if (doc !== null) heredocs.push(doc);
      } else if (c === "#" && word === null) {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
      } else if (c === " " || c === "\t") {
        endWord();
        i += 1;
      } else if (OPERATORS.includes(c)) {
        const operator = ["||", "&&", "|&"].includes(source.slice(i, i + 2)) ? source.slice(i, i + 2) : c;
        endCommand(operator === "|" || operator === "|&" || c === "(" || c === ")");
        if (c === "(") parens += 1;
        if (c === ")" && parens > 0) parens -= 1;
        i += operator.length;
        if (c === "\n") for (const doc of heredocs.splice(0)) skipHeredoc(doc, close);
      } else {
        word = (word ?? "") + c;
        i += 1;
      }
    }
    endCommand(false);
  }

  /** A `$(...)`, `$((...))`, backtick, `<(...)`, or `>(...)` substitution starting at `i`: its commands are added. */
  function substitution(): void {
    if (source[i] === "`") {
      i += 1;
      list("`");
    } else if (source.startsWith("$((", i)) {
      i += 3;
      list(")", true);
      if (source[i] === ")") i += 1;
    } else {
      i += 2;
      list(")");
    }
  }

  /** Double-quoted text up to `end` (consumed), or a heredoc body to the end: literal except for substitutions. */
  function text(end: '"' | null): string {
    let out = "";
    while (i < source.length) {
      const c = source[i];
      if (c === end) {
        i += 1;
        break;
      }
      if (c === "\\" && i + 1 < source.length && DQ_ESCAPABLE.includes(source[i + 1])) {
        if (source[i + 1] !== "\n") out += source[i + 1];
        i += 2;
      } else if (c === "`" || source.startsWith("$(", i)) {
        substitution();
      } else {
        out += c;
        i += 1;
      }
    }
    return out;
  }

  /** The delimiter word after `<<` (and an optional `-`); any quoting in it makes the body literal. */
  function heredocOperator(owner: SimpleCommand): Heredoc | null {
    const stripTabs = source[i] === "-";
    if (stripTabs) i += 1;
    while (source[i] === " " || source[i] === "\t") i += 1;
    let delimiter = "";
    let quoted = false;
    while (i < source.length && !/[\s;&|()<>]/.test(source[i])) {
      const c = source[i];
      if (c === "'" || c === '"') {
        const end = source.indexOf(c, i + 1);
        delimiter += source.slice(i + 1, end === -1 ? source.length : end);
        i = end === -1 ? source.length : end + 1;
        quoted = true;
      } else if (c === "\\") {
        delimiter += source[i + 1] ?? "";
        i += 2;
        quoted = true;
      } else {
        delimiter += c;
        i += 1;
      }
    }
    return delimiter === "" && !quoted ? null : { delimiter, quoted, stripTabs, owner };
  }

  /**
   * Reads the heredoc body that starts at `i`, through its delimiter line or
   * the end, onto its command's stdin. Inside a substitution, `EOF)` also ends
   * it, as bash allows. An unquoted delimiter's body still runs its
   * substitutions.
   */
  function skipHeredoc(doc: Heredoc, close: ")" | "`" | null): void {
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
    const body = source.slice(start, bodyEnd);
    doc.owner.input.push(body);
    if (!doc.quoted) for (const substituted of simpleCommands(body, true)) commands.push(substituted);
  }

  if (heredocBody) text(null);
  else list(null);
  return commands;
}

/** The command string of `bash -c '...'` (also `-lc`, `-ec`), given the words after the shell, else null. */
function shellCommandString(args: string[]): string | null {
  let dashC = false;
  for (let j = 0; j < args.length; j += 1) {
    const arg = args[j];
    if (/^[-+][oO]$/.test(arg)) j += 1;
    else if (/^-[A-Za-z]+$/.test(arg)) dashC ||= arg.includes("c");
    else if (!arg.startsWith("-") && !arg.startsWith("+")) return dashC ? arg : null;
  }
  return null;
}

/**
 * Whether `program` given `args` runs the script on its stdin: a shell without
 * `-c` that has `-s`, no script file, or /dev/stdin as its script file; or
 * `source /dev/stdin`.
 */
function readsStdin(program: string, args: string[]): boolean {
  if (program === "source" || program === ".") return STDIN_FILES.has(args.at(0) ?? "");
  if (!SHELL.test(program)) return false;
  let dashS = false;
  for (let j = 0; j < args.length; j += 1) {
    const arg = args[j];
    if (arg === "--") return dashS || j + 1 === args.length;
    if (/^[-+][oO]$/.test(arg) || arg === "--rcfile" || arg === "--init-file") j += 1;
    else if (/^-[A-Za-z]+$/.test(arg) && arg.includes("c")) return false;
    else if (/^-[A-Za-z]+$/.test(arg)) dashS ||= arg.includes("s");
    else if (!arg.startsWith("-") && !arg.startsWith("+")) return dashS || STDIN_FILES.has(arg);
  }
  return true;
}

/**
 * The human subcommand a shell command would run (`reply` or `stop`), else
 * null. Each simple command is read as `[VAR=x ...] [sudo|env|timeout 60|npx ...]
 * <program> [--project <dir>] <subcommand>` after quote removal, so the words
 * inside an argument (`grep "diarchy reply" docs/`), single-quoted text, and a
 * quoted-delimiter heredoc body (`<<'EOF'`) do not count, while a `$(...)` or
 * backtick substitution does, even inside double quotes. Three things are read
 * as command lines of their own: the string of `bash|sh|zsh|dash|ksh -c`
 * wherever the shell stands in the command (`timeout 60 bash -c`, `xargs sh
 * -c`); the arguments of `eval`; and a heredoc or here-string that a shell,
 * `eval`, or `source` runs, from its stdin (`bash <<'EOF'`, `sh -s <<EOF`,
 * `cat <<'EOF' | bash`, `source /dev/stdin <<EOF`, `xargs sh -c '{}' <<EOF`)
 * or through a substitution in its arguments (`bash -c "$(cat <<'EOF' ...)"`,
 * `bash <(cat <<'EOF' ...)`). Best effort by design: an alias, a function, a
 * wrapper script, a script in a file or a variable (`bash x.sh`,
 * `while read l; do eval "$l"; done <<EOF`), text a shell gets from a
 * command's arguments (`echo 'diarchy stop' | bash`, `eval "$(echo ...)"`),
 * and a heredoc read by a shell that an unknown wrapper starts without `-c`
 * (`ssh host bash <<'EOF'`) are not unpacked (ANTI-SLOP.md, What this does NOT
 * prevent).
 */
export function humanCommand(command: string): "reply" | "stop" | null {
  const commands = simpleCommands(command);
  for (const [index, { words, pipeline, inner }] of commands.entries()) {
    let i = 0;
    while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || PRELUDE.has(words[i]) || RESERVED.has(words[i]) || PRELUDE_NUMBER.test(words[i]) || words[i].startsWith("-"))) i += 1;
    const program = words.at(i) ?? "";
    const args = words.slice(i + 1);
    if (PROGRAM.test(program)) {
      let k = 0;
      while (k < args.length && args[k].startsWith("-")) k += /^--?project$/.test(args[k]) ? 2 : 1;
      const subcommand = args.at(k);
      if (subcommand === "reply" || subcommand === "stop") return subcommand;
    }
    const scripts: string[] = [];
    let runsStdin = readsStdin(program, args);
    for (let j = i; j < words.length; j += 1) {
      const script = SHELL.test(words[j]) ? shellCommandString(words.slice(j + 1)) : null;
      if (script === null) continue;
      scripts.push(script);
      // Behind a wrapper (`xargs sh -c '{}'`), the shell may be handed the command's stdin.
      if (j > i) runsStdin = true;
    }
    if (program === "eval") scripts.push(args.join(" "));
    if (scripts.length > 0 || SHELL.test(program) || program === "source" || program === ".") {
      // What a substitution in its arguments prints: `bash -c "$(cat <<'EOF' ...)"`, `bash <(cat <<'EOF' ...)`.
      for (const substituted of inner) scripts.push(...substituted.input);
    }
    if (runsStdin) {
      // Its own heredoc or here-string, or one an earlier command of the pipeline passes on.
      for (const earlier of commands.slice(0, index + 1)) if (earlier.pipeline === pipeline) scripts.push(...earlier.input);
    }
    for (const script of scripts) {
      const subcommand = humanCommand(script);
      if (subcommand !== null) return subcommand;
    }
  }
  return null;
}

export interface GuardDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * The PreToolUse deny for a shell call that runs `diarchy reply` or
 * `diarchy stop`, else null. `hookJson` is the hook event on stdin; anything
 * that is not an event with a string `tool_input.command` is let through.
 */
export function runGuard(agent: string, hookJson: string): GuardDecision | null {
  let command: unknown;
  try {
    const event = JSON.parse(hookJson) as { tool_input?: { command?: unknown } } | null;
    command = event?.tool_input?.command;
  } catch {
    return null;
  }
  if (typeof command !== "string") return null;
  const subcommand = humanCommand(command);
  if (subcommand === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `diarchy ${subcommand} posts as the human, and ${agent} is a PM. The human answers from their own terminal; call wait_for_reply instead.`,
    },
  };
}
