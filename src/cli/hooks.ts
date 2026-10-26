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
function programAt(words: string[]): number {
  let i = 0;
  while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || PRELUDE.has(words[i]) || PRELUDE_NUMBER.test(words[i]) || words[i].startsWith("-"))) i += 1;
  return i;
}

/** In `[VAR=x ...] [prelude ...] <program> [--project <dir>] <subcommand>`, the indexes of the program and the human subcommand, else null. */
function humanWords(words: string[]): [number, number] | null {
  const i = programAt(words);
  if (!PROGRAM.test(words.at(i) ?? "")) return null;
  let k = i + 1;
  while (k < words.length && words[k].startsWith("-")) k += /^--?project$/.test(words[k]) ? 2 : 1;
  return words.at(k) === "reply" || words.at(k) === "stop" ? [i, k] : null;
}

interface Hit {
  subcommand: "reply" | "stop";
  /** From the program word's first character to the subcommand's last, in the command. */
  start: number;
  end: number;
}

/** What the original guard denies, and a few wrappers it missed (`timeout 60`, `then`, `{`): each piece between operators, quoting ignored, read by `humanWords`. */
function splitHits(command: string): Hit[] {
  const hits: Hit[] = [];
  const separators = new RegExp(COMMAND_SEPARATORS);
  let from = 0;
  for (;;) {
    const separator = separators.exec(command);
    const to = separator === null ? command.length : separator.index;
    const words = [...command.slice(from, to).matchAll(/\S+/g)];
    const found = humanWords(words.map((word) => word[0]));
    if (found !== null) {
      const [program, subcommand] = [words[found[0]], words[found[1]]];
      hits.push({ subcommand: subcommand[0] as Hit["subcommand"], start: from + program.index, end: from + subcommand.index + subcommand[0].length });
    }
    if (separator === null) return hits;
    from = separators.lastIndex;
  }
}

interface Word {
  /** After quote removal. */
  text: string;
  /** `arg`: the program (first) or an argument; `target`: a redirection's file or fd; `here`: a here-string. */
  role: "arg" | "target" | "here";
  owner: Command;
  /** Has quoting, an escape, or a substitution, so it is neither an fd number nor a reserved word. */
  quoted: boolean;
}

interface Command {
  /** Program and arguments. */
  words: Word[];
  hereStrings: string[];
  redirections: number;
  /** The stages of its `a | b | c` pipeline, itself included. */
  pipeline: Command[];
  /** The word whose `$(...)` or backtick substitution this command is in, or null. */
  parent: Word | null;
}

/** Inert text: single-quoted, double-quoted without a substitution, or a quoted-delimiter heredoc body. */
interface Inert {
  start: number;
  end: number;
  owner: Command;
  /** The word it is part of, or null for a heredoc body (the owner's stdin). */
  word: Word | null;
}

interface Heredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
  owner: Command;
}

interface Reading {
  commands: Command[];
  inert: Inert[];
  runsCode: boolean;
}

class Unsure extends Error {}

/**
 * The simple commands and inert text of `source`, read the way bash does, or
 * null for anything this reader does not follow: subshells, groups, compound
 * commands, arithmetic, `${...}`, process substitution, a backslash inside
 * backticks, a substitution in an unquoted heredoc body, an unterminated
 * quote, substitution, or heredoc.
 */
function readShell(source: string): Reading | null {
  const commands: Command[] = [];
  const inert: Inert[] = [];
  let runsCode = false;
  let backticks = 0;
  let i = 0;
  const unsure = (): never => {
    throw new Unsure();
  };

  /** Commands up to `close` (consumed), inside the substitution held by `parent`. */
  function list(close: ")" | "`" | null, parent: Word | null): void {
    const begin = (pipeline: Command[]): Command => {
      const started: Command = { words: [], hereStrings: [], redirections: 0, pipeline, parent };
      pipeline.push(started);
      return started;
    };
    let command = begin([]);
    let word: Word | null = null;
    let role: Word["role"] = "arg";
    const heredocs: Heredoc[] = [];

    const current = (): Word => (word ??= { text: "", role, owner: command, quoted: false });
    const endWord = (): void => {
      if (word === null) return;
      if (word.role === "here") command.hereStrings.push(word.text);
      if (word.role === "arg") {
        if (command.words.length === 0 && !word.quoted && COMPOUND.has(word.text)) unsure();
        if (RUNS_CODE.test(word.text) || (command.words.length === 0 && word.text === ".")) runsCode = true;
        command.words.push(word);
      }
      word = null;
      role = "arg";
    };
    /** An empty command stays open, so `a |` or `a &&` may go on after a newline. */
    const endCommand = (piped: boolean): void => {
      endWord();
      if (role !== "arg") unsure();
      if (command.words.length === 0 && command.hereStrings.length === 0 && command.redirections === 0) {
        if (piped) unsure();
        return;
      }
      commands.push(command);
      command = begin(piped ? command.pipeline : []);
    };
    const substitution = (closer: ")" | "`"): void => {
      const holder = current();
      holder.quoted = true;
      i += closer === "`" ? 1 : 2;
      if (closer === "`") backticks += 1;
      list(closer, holder);
      if (closer === "`") backticks -= 1;
    };
    const doubleQuoted = (): void => {
      const holder = current();
      holder.quoted = true;
      const start = i + 1;
      let substituted = false;
      i += 1;
      while (source[i] !== '"') {
        const c = source[i];
        const next = source[i + 1];
        if (c === undefined || (c === "\\" && backticks > 0) || source.startsWith("$((", i) || source.startsWith("${", i) || source.startsWith("$[", i)) unsure();
        if (c === "\\" && next !== undefined && DQ_ESCAPABLE.includes(next)) {
          if (next !== "\n") holder.text += next;
          i += 2;
        } else if (c === "`" || source.startsWith("$(", i)) {
          substituted = true;
          substitution(c === "`" ? "`" : ")");
        } else {
          holder.text += c;
          i += 1;
        }
      }
      if (!substituted) inert.push({ start, end: i, owner: command, word: holder });
      i += 1;
    };
    const heredocOperator = (stripTabs: boolean): Heredoc => {
      while (source[i] === " " || source[i] === "\t") i += 1;
      let delimiter = "";
      let quoted = false;
      while (i < source.length && !/[\s;&|()<>]/.test(source[i])) {
        const c = source[i];
        if (c === "'" || c === '"') {
          const end = source.indexOf(c, i + 1);
          if (end === -1) unsure();
          delimiter += source.slice(i + 1, end);
          i = end + 1;
          quoted = true;
        } else if (c === "\\" && i + 1 < source.length) {
          delimiter += source[i + 1];
          i += 2;
          quoted = true;
        } else if (c === "$" || c === "`" || c === "\\") {
          unsure();
        } else {
          delimiter += c;
          i += 1;
        }
      }
      if (delimiter === "") unsure();
      command.redirections += 1;
      return { delimiter, quoted, stripTabs, owner: command };
    };
    /** The body starting at `i`, through its delimiter line. */
    const heredocBody = (doc: Heredoc): void => {
      const start = i;
      for (;;) {
        if (i >= source.length) unsure();
        const newline = source.indexOf("\n", i);
        const lineEnd = newline === -1 ? source.length : newline;
        const line = source.slice(i, lineEnd);
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
        i = lineEnd + 1;
      }
      if (doc.quoted) inert.push({ start, end: i, owner: doc.owner, word: null });
      // The commands of a substitution in an unquoted body are not read, so do not guess.
      else if (/\$\(|`/.test(source.slice(start, i))) unsure();
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline + 1;
    };
    const redirection = (): void => {
      if (source[i + 1] === "(") unsure();
      // An unquoted number right before the operator is its fd (`2>&1`), not an argument.
      if (word !== null && word.role === "arg" && !word.quoted && /^\d+$/.test(word.text)) word = null;
      else endWord();
      const operator = /^(?:<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/.exec(source.slice(i, i + 3))?.[0] ?? unsure();
      i += operator.length;
      if (operator === "<<" || operator === "<<-") {
        heredocs.push(heredocOperator(operator === "<<-"));
      } else {
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
        if (heredocs.length > 0) unsure();
        return;
      }
      if (c === "\\") {
        if (next === undefined || backticks > 0) unsure();
        if (next !== "\n") {
          current().text += next;
          current().quoted = true;
        }
        i += 2;
      } else if (c === "'") {
        const end = source.indexOf("'", i + 1);
        if (end === -1) unsure();
        const holder = current();
        holder.quoted = true;
        holder.text += source.slice(i + 1, end);
        inert.push({ start: i + 1, end, owner: command, word: holder });
        i = end + 1;
      } else if (c === "$" && next === "'") {
        let end = i + 2;
        while (end < source.length && source[end] !== "'") end += source[end] === "\\" ? 2 : 1;
        if (end >= source.length) unsure();
        const holder = current();
        holder.quoted = true;
        holder.text += source.slice(i + 2, end);
        i = end + 1;
      } else if (c === '"') {
        doubleQuoted();
      } else if (c === "`" || (c === "$" && next === "(")) {
        if (source.startsWith("$((", i)) unsure();
        substitution(c === "`" ? "`" : ")");
      } else if (c === "$" && (next === "{" || next === "[")) {
        unsure();
      } else if (c === "#" && word === null) {
        const newline = source.indexOf("\n", i);
        i = newline === -1 ? source.length : newline;
      } else if (c === " " || c === "\t") {
        endWord();
        i += 1;
      } else if (c === "\n") {
        endCommand(false);
        i += 1;
        for (const doc of heredocs.splice(0)) heredocBody(doc);
      } else if (c === ";") {
        if (next === ";") unsure();
        endCommand(false);
        i += 1;
      } else if (c === "|") {
        endCommand(next !== "|");
        i += next === "|" || next === "&" ? 2 : 1;
      } else if (c === "&" && next === ">") {
        endWord();
        role = "target";
        command.redirections += 1;
        i += source[i + 2] === ">" ? 3 : 2;
      } else if (c === "&") {
        endCommand(false);
        i += next === "&" ? 2 : 1;
      } else if (c === "<" || c === ">") {
        redirection();
      } else if (c === "(" || c === ")") {
        unsure();
      } else {
        current().text += c;
        i += 1;
      }
    }
    endCommand(false);
    if (close !== null || heredocs.length > 0) unsure();
  }

  try {
    list(null, null);
  } catch (error) {
    // Too deep a nesting of substitutions overflows the stack: read as unsure too.
    if (error instanceof Unsure || error instanceof RangeError) return null;
    throw error;
  }
  return { commands, inert: inert.sort((a, b) => a.start - b.start), runsCode };
}

/** Whether `command` is a program that only passes text along: echo, cat, tee, printf without -v, git commit|tag|notes, gh pr|issue|release|api. */
function dataProgram(command: Command): boolean {
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
      while (args[k] === "-C" || args[k] === "--no-pager") k += args[k] === "-C" ? 2 : 1;
      return GIT_DATA.has(args.at(k) ?? "");
    }
    case "gh":
      return GH_DATA.has(args.at(0) ?? "");
    default:
      return false;
  }
}

/** Whether what `command` reads ends up only as data: every stage of its pipeline is a data program, and a substitution holding it is an argument of one. Memoized per command and per pipeline. */
function dataOnly(command: Command, memo: Map<object, boolean>): boolean {
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
function inertData(hit: Hit, reading: Reading, memo: Map<object, boolean>): boolean {
  const { inert } = reading;
  let low = 0;
  let high = inert.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (inert[middle].start <= hit.start) low = middle + 1;
    else high = middle;
  }
  const text = inert.at(low - 1);
  if (text === undefined || hit.end > text.end) return false;
  if (text.word !== null && (text.word.role === "target" || text.owner.words[0] === text.word)) return false;
  return dataOnly(text.owner, memo);
}

/** The script of a shell given the words after it: the first operand once an option cluster has `c` (`-c`, `-lc`), else null. */
function shellScript(args: string[]): string | null {
  let dashC = false;
  for (let j = 0; j < args.length; j += 1) {
    if (/^[-+][oO]$/.test(args[j])) j += 1;
    else if (/^-[A-Za-z]+$/.test(args[j])) dashC ||= args[j].includes("c");
    else if (!args[j].startsWith("-") && !args[j].startsWith("+")) return dashC ? args[j] : null;
  }
  return null;
}

/** What quote removal shows: `"diarchy" reply`, a shell's `-c` string or here-string (`env sh -o pipefail -c "..."`, `bash <<< "..."`), and `eval`'s arguments. */
function readHuman(reading: Reading, depth: number): "reply" | "stop" | null {
  for (const command of reading.commands) {
    const words = command.words.map((word) => word.text);
    const found = humanWords(words);
    if (found !== null) return words[found[1]] as "reply" | "stop";
    const scripts: string[] = [];
    const shell = words.findIndex((word) => SHELL.test(word));
    if (shell !== -1) {
      const script = shellScript(words.slice(shell + 1));
      scripts.push(...(script === null ? command.hereStrings : [script]));
    }
    const program = programAt(words);
    if (words.at(program) === "eval") scripts.push(words.slice(program + 1).join(" "));
    for (const script of scripts) {
      const subcommand = verdict(script, depth + 1);
      if (subcommand !== null) return subcommand;
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
export function humanCommand(command: string): "reply" | "stop" | null {
  return verdict(command, 0);
}

/** Scripts inside scripts (`eval eval ...`) are read this deep, no deeper. */
const MAX_DEPTH = 4;

function verdict(command: string, depth: number): "reply" | "stop" | null {
  const hits = splitHits(command);
  const reading = readShell(command);
  if (reading === null) return hits.at(0)?.subcommand ?? null;
  const memo = new Map<object, boolean>();
  for (const hit of hits) if (reading.runsCode || !inertData(hit, reading, memo)) return hit.subcommand;
  return depth < MAX_DEPTH ? readHuman(reading, depth) : null;
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
