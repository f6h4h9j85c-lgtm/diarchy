/** chat.md: docs/RENDERING.md section 2. Pure and byte-deterministic. */
import type { GoalState, Kickoff, Message, Phase } from "../../protocol/index.js";
import {
  GENERATED,
  SEP,
  GLYPHS,
  bodyParagraph,
  budgetLine,
  budgetTrigger,
  byId,
  challengerList,
  code,
  evidenceBullet,
  hms,
  humanSlot,
  inline,
  italic,
  link,
  localHint,
  messageRef,
  navLine,
  sortMessages,
  utcDate,
  type RenderOptions,
} from "./shared.js";

const SUMMARY_MAX = 80;

export function renderChat(
  messages: Message[],
  state: GoalState | null,
  kickoff: Kickoff,
  opts: RenderOptions = {},
): string {
  const ordered = sortMessages(messages);
  const ctx: Context = { byId: byId(ordered), newTaskIds: newTaskIds(ordered), acCount: kickoff.acceptance_criteria.length };
  const chunks: string[] = [`${GENERATED}\n# Chat: ${kickoff.goal}`, strip(ordered, state, kickoff, opts), "---"];
  ordered.forEach((message, index) => {
    chunks.push(block(message, ctx));
    const headings = headingsAfter(ordered, index, state);
    if (index + 1 < ordered.length || headings.length > 0) chunks.push("---", ...headings);
  });
  return `${chunks.join("\n\n")}\n`;
}

interface Context {
  byId: Map<string, Message>;
  /** Task id the engine gave each ASSIGN that carried `new_task`. */
  newTaskIds: Map<string, string>;
  /** Acceptance criteria present at kickoff; `ac_add` numbers continue from here. */
  acCount: number;
}

/** Replays task numbering: plan tasks first, then one per `new_task` ASSIGN in message order. */
function newTaskIds(messages: Message[]): Map<string, string> {
  const ids = new Map<string, string>();
  let count = 0;
  for (const message of messages) {
    if (message.type === "DECIDE" && message.decision_id === "plan") count += (message.tasks ?? []).length;
    if (message.type === "ASSIGN" && message.task === undefined) {
      count += 1;
      ids.set(message.id, `T${count}`);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 2.1 The strip
// ---------------------------------------------------------------------------

function callout(kind: "NOTE" | "WARNING", paragraphs: string[]): string {
  const lines = [`[!${kind}]`];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) lines.push("");
    lines.push(...paragraph.split("\n"));
  });
  return lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

function strip(messages: Message[], state: GoalState | null, kickoff: Kickoff, opts: RenderOptions): string {
  const last: Message | undefined = messages[messages.length - 1];
  const phase = state?.phase ?? last?.phase ?? "PLAN";
  const blocked = phase === "BLOCKED";
  const phaseText = blocked && state?.blocked_from ? `**BLOCKED** from ${state.blocked_from}` : `**${phase}**`;
  const lead = state?.lead ?? kickoff.lead;
  const challengers = state === null ? kickoff.challenger : challengerList(state);
  const stateLine = [phaseText, humanSlot(state, messages), `lead ${lead}`, `challenger ${challengers}`].join(SEP);
  const ts = last?.ts ?? kickoff.created;
  let latest = `${utcDate(ts)}${SEP}last ${hms(ts)} UTC ${localHint(ts, opts.localTz)}`;
  if (last !== undefined) {
    const text = summary(last);
    latest += `${SEP}${last.from} ${last.type}${text === "" ? "" : `: ${text}`}`;
  }
  const nav = `${blocked ? "Question and how to answer: " : ""}${navLine(messages)}`;
  return callout(blocked ? "WARNING" : "NOTE", [stateLine, budgetLine(state), latest, nav]);
}

/** Claim, else the first body line, cut at 80 characters on whitespace. */
function summary(message: Message): string {
  const text = inline(message.claim ?? message.body.trim().split("\n")[0] ?? "").trim();
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.lastIndexOf(" ", SUMMARY_MAX);
  return `${(cut > 0 ? text.slice(0, cut) : text.slice(0, SUMMARY_MAX)).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// 2.2 Message block
// ---------------------------------------------------------------------------

function block(message: Message, ctx: Context): string {
  const decision = message.decision_id === undefined ? "" : `${SEP}${message.decision_id}`;
  const header = `**${message.from} → ${message.to}${SEP}${message.type}${decision}${SEP}re ${message.re.join(", ")}${SEP}${hms(message.ts)}**`;
  const parts = [`${GLYPHS[message.type]} ${header}`];
  const fields = fieldsLine(message, ctx);
  if (fields !== "") parts.push(fields);
  if (message.claim !== undefined) parts.push(italic(message.claim));
  const body = bodyParagraph(message.body);
  if (body !== "") parts.push(body);
  const evidence = message.evidence ?? [];
  if (evidence.length > 0) parts.push(evidence.map((item) => evidenceBullet(item, ctx.byId)).join("\n"));
  const tasks = message.type === "DECIDE" && message.decision_id === "plan" ? (message.tasks ?? []) : [];
  if (tasks.length > 0) {
    parts.push(["Tasks:", ...tasks.map((task, index) => `- T${index + 1}: ${inline(task)}`)].join("\n"));
  }
  const added = message.type === "DECIDE" && message.decision_id === "plan" ? (message.ac_add ?? []) : [];
  if (added.length > 0) {
    const lines = added.map((criterion, index) => `- AC${ctx.acCount + index + 1}: ${inline(criterion)}`);
    parts.push(["Acceptance criteria added:", ...lines].join("\n"));
  }
  return parts.join("\n\n");
}

function replyingTo(message: Message, ctx: Context): string[] {
  return message.reply_to === undefined ? [] : [`replying to ${messageRef(message.reply_to, ctx.byId)}`];
}

function fieldsLine(message: Message, ctx: Context): string {
  const segments: string[] = [];
  switch (message.type) {
    case "PROPOSE":
    case "CHALLENGE":
      segments.push(...replyingTo(message, ctx));
      break;
    case "DECIDE":
      segments.push(`basis: ${message.basis ?? ""}`);
      if (message.supersedes !== undefined) segments.push(`supersedes: ${message.supersedes}`);
      segments.push(...replyingTo(message, ctx));
      if (message.budgets !== undefined) {
        const pairs = Object.entries(message.budgets).map(([key, value]) => `${key} ${String(value)}`);
        segments.push(`budgets: ${pairs.join(", ")}`);
      }
      break;
    case "ASSIGN":
      segments.push(...assignFields(message, ctx));
      break;
    case "STATUS":
      if (message.task !== undefined) {
        segments.push(message.task_status === undefined ? message.task : `${message.task} ${message.task_status}`);
      }
      break;
    case "BLOCKED":
      segments.push(
        message.kind === "internal" ? "kind: internal · lead must ASSIGN or DECIDE" : "kind: external · the human is paged",
      );
      break;
    case "ASK_HUMAN":
      if (message.reply_to !== undefined) segments.push(...replyingTo(message, ctx));
      else {
        const trigger = budgetTrigger(message, null);
        segments.push(`budget: ${trigger.counter} ${trigger.used} of ${trigger.limit}`);
      }
      break;
    default:
      break;
  }
  return segments.join(SEP);
}

function assignFields(message: Message, ctx: Context): string[] {
  const segments: string[] = [];
  if (message.kind === "review") {
    segments.push(`review ${message.pr === undefined ? "" : link(message.pr)}`.trimEnd());
  } else {
    const task = message.task ?? ctx.newTaskIds.get(message.id) ?? "";
    segments.push(`implement ${task} on ${code(message.branch ?? "")}`);
    if (message.new_task !== undefined) segments.push(`new task: ${inline(message.new_task)}`);
  }
  if (message.reason !== undefined) segments.push(`reason: ${inline(message.reason)}`);
  return segments;
}

// ---------------------------------------------------------------------------
// 2.3 Phase headings and 2.4 day headings
// ---------------------------------------------------------------------------

/**
 * Phases a message's acceptance passes through that no later message records:
 * KICKOFF opens PLAN, a `plan` DECIDE opens EXECUTE, a human DECIDE restores
 * the phase the run was blocked from (and a human `plan` ruling then opens EXECUTE).
 */
function impliedPhases(message: Message, index: number, ordered: Message[]): Phase[] {
  if (message.type === "KICKOFF") return ["PLAN"];
  if (message.type !== "DECIDE") return [];
  const phases: Phase[] = [];
  let phase: Phase = message.phase;
  if (message.from === "human" && phase === "BLOCKED") {
    const earlier = ordered.slice(0, index).reverse().find((candidate) => candidate.phase !== "BLOCKED");
    phase = earlier?.phase ?? "EXECUTE";
    phases.push(phase);
  }
  if (message.decision_id === "plan" && phase === "PLAN") phases.push("EXECUTE");
  return phases;
}

function headingsAfter(ordered: Message[], index: number, state: GoalState | null): string[] {
  const message = ordered[index];
  const next: Message | undefined = ordered[index + 1];
  const headings: string[] = [];
  let phase = message.phase;
  for (const implied of impliedPhases(message, index, ordered)) {
    if (implied !== phase || message.type === "KICKOFF") headings.push(`## → ${implied}${SEP}${hms(message.ts)}`);
    phase = implied;
  }
  const to = next?.phase ?? state?.phase ?? phase;
  if (to !== phase) {
    // An external BLOCKED moves the phase at its own time. Every other block
    // (deadlock, budget, wall clock) is dated by the system ASK_HUMAN that
    // announces it, since no message of this agent caused the transition.
    const answered = message.type === "BLOCKED" && message.kind === "external" && next?.reply_to === message.id;
    const at = next?.type === "ASK_HUMAN" && !answered ? next.ts : message.ts;
    headings.push(`## → ${to}${SEP}${hms(at)}`);
  }
  if (next !== undefined && utcDate(next.ts) !== utcDate(message.ts)) headings.push(`## ${utcDate(next.ts)} UTC`);
  return headings;
}
