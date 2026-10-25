/**
 * What a goal needs from an agent or the human right now. Shared by `status`,
 * `inbox-skim`, and `gate`; pure over GoalState plus the message list, except
 * for reading an inbox cursor file (never writing it).
 */
import { existsSync, readFileSync } from "node:fs";

import { openThreads, type AgentId, type GoalState, type Message, type TaskStatus } from "../protocol/index.js";
import type { GoalRef } from "../vault/index.js";
import { budgetTrigger, hms, lastOfType, sortMessages } from "../vault/render/shared.js";

export interface Assignment {
  task: string;
  kind: "implement" | "review";
  text: string;
  assignee: AgentId;
  branch: string | null;
  pr: string | null;
  status: TaskStatus;
}

/** Tasks still owed: implement tasks not done, review tasks with no review evidence from the assignee yet. */
export function openAssignments(state: GoalState, agent?: AgentId): Assignment[] {
  const open: Assignment[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.assignee === null || task.kind === null || task.status === "done" || task.status === "todo") continue;
    if (agent !== undefined && task.assignee !== agent) continue;
    if (task.kind === "review") {
      const reviewed = task.pr !== null && (state.prs[task.pr]?.reviews.some((review) => review.by === task.assignee) ?? false);
      if (reviewed) continue;
    }
    open.push({
      task: task.id,
      kind: task.kind,
      text: task.task,
      assignee: task.assignee,
      branch: task.branch,
      pr: task.pr,
      status: task.status,
    });
  }
  return open;
}

/** Open threads whose CHALLENGE still awaits the lead's DECIDE. */
export function challengedThreads(state: GoalState): { id: string; from: AgentId; challengeId: string }[] {
  return openThreads(state)
    .map((id) => ({ id, challenge: state.decisions[id]?.challenge ?? null }))
    .filter((entry): entry is { id: string; challenge: NonNullable<typeof entry.challenge> } => entry.challenge !== null)
    .map(({ id, challenge }) => ({ id, from: challenge.from, challengeId: challenge.id }));
}

/** Messages after the agent's inbox cursor, excluding its own. Reads the cursor file; never moves it. */
export function unreadFor(goal: GoalRef, messages: Message[], agent: AgentId): Message[] {
  const path = goal.paths.inbox(agent);
  let cursor: string | null = null;
  if (existsSync(path)) {
    const inbox = JSON.parse(readFileSync(path, "utf8")) as { cursor?: string | null };
    cursor = inbox.cursor ?? null;
  }
  return sortMessages(messages).filter((message) => (cursor === null || message.id > cursor) && message.from !== agent);
}

/**
 * The `diarchy reply` invocation that answers the current block, mirroring the
 * goal.md question callout (RENDERING.md 4.1). Null unless BLOCKED.
 */
export function replyHint(state: GoalState, messages: Message[]): string | null {
  if (state.phase !== "BLOCKED") return null;
  const ordered = sortMessages(messages);
  const ask = lastOfType(ordered, "ASK_HUMAN");
  if (ask === undefined) return 'diarchy reply "<your answer>"';
  const replyTo = ask.reply_to === undefined ? undefined : ordered.find((message) => message.id === ask.reply_to);
  if (replyTo?.type === "CHALLENGE") {
    const decision = ask.decision_id ?? replyTo.decision_id ?? "plan";
    return `diarchy reply "<ruling>" --decision ${decision}`;
  }
  if (replyTo !== undefined || ask.reply_to !== undefined) return 'diarchy reply "<your answer>"';
  const hit = budgetTrigger(ask, state);
  return `diarchy reply "continue" --budget ${hit.counter}=${Number(hit.limit) * 2}`;
}

/** Why the run is BLOCKED, in one short clause. */
export function blockSummary(state: GoalState, messages: Message[]): string {
  const ordered = sortMessages(messages);
  const stop = [...ordered].reverse().find((message) => message.type === "BLOCKED" && message.from === "human");
  const ask = lastOfType(ordered, "ASK_HUMAN");
  if (stop !== undefined && (ask === undefined || stop.ts > ask.ts)) return "stopped by the human";
  if (ask === undefined) return "blocked";
  const replyTo = ask.reply_to === undefined ? undefined : ordered.find((message) => message.id === ask.reply_to);
  if (replyTo?.type === "BLOCKED") return `${replyTo.from} is blocked (${replyTo.kind ?? "external"})`;
  if (replyTo?.type === "CHALLENGE") return `deadlock on ${ask.decision_id ?? replyTo.decision_id ?? "plan"}`;
  const hit = budgetTrigger(ask, state);
  return `budget reached: ${hit.counter} ${hit.used} of ${hit.limit}`;
}

/** Which store trigger blocked the run: WALL_CLOCK (clock or spend), TOTAL_BUDGET, DEADLOCK, BLOCKED, or STOP. */
export function blockReason(state: GoalState, messages: Message[]): "WALL_CLOCK" | "TOTAL_BUDGET" | "DEADLOCK" | "BLOCKED" | "STOP" {
  const ordered = sortMessages(messages);
  const stop = [...ordered].reverse().find((message) => message.type === "BLOCKED" && message.from === "human");
  const ask = lastOfType(ordered, "ASK_HUMAN");
  if (stop !== undefined && (ask === undefined || stop.ts > ask.ts)) return "STOP";
  if (ask === undefined) return "BLOCKED";
  if (ask.reply_to !== undefined) {
    const replyTo = ordered.find((message) => message.id === ask.reply_to);
    return replyTo?.type === "CHALLENGE" ? "DEADLOCK" : "BLOCKED";
  }
  return budgetTrigger(ask, state).counter === "messages_total" ? "TOTAL_BUDGET" : "WALL_CLOCK";
}

export interface NextStep {
  /** Imperative, names the MCP tool to call. */
  text: string;
  /** True when the agent owes the goal something now (the Stop gate blocks on this). */
  owes: boolean;
}

/** The imperative next step for `agent`, in priority order. */
export function nextStep(state: GoalState, messages: Message[], agent: AgentId, unread: Message[]): NextStep {
  const lead = state.lead === agent;
  if (state.phase === "DONE") return { text: "goal is DONE; nothing to do", owes: false };
  if (state.phase === "BLOCKED") {
    return { text: `waiting on the human (${blockSummary(state, messages)}); call wait_for_reply`, owes: false };
  }
  const review = openAssignments(state, agent).find((assignment) => assignment.kind === "review");
  if (review !== undefined && review.pr !== null) {
    return { text: `you hold review of PR ${review.pr}: review it, then call status with review evidence`, owes: true };
  }
  const implement = openAssignments(state, agent).find((assignment) => assignment.kind === "implement");
  if (implement !== undefined) {
    const where = implement.branch === null ? "" : ` on branch ${implement.branch}`;
    return {
      text: `you hold ${implement.task} (${implement.text})${where}: finish it, then call status with commit and test evidence`,
      owes: true,
    };
  }
  if (lead) {
    const challenged = challengedThreads(state)[0];
    if (challenged !== undefined) {
      const watch = state.deadlock_watch;
      const due = watch === null ? "" : ` (deadlock in ${watch.remaining} messages or by ${hms(watch.deadline)} UTC)`;
      return { text: `thread ${challenged.id} has a CHALLENGE from ${challenged.from} awaiting your DECIDE: call decide${due}`, owes: true };
    }
  }
  if (unread.length > 0) {
    return { text: `${unread.length} unread message${unread.length === 1 ? "" : "s"}: call read, then act on them`, owes: true };
  }
  if (lead && state.phase === "PLAN") {
    const plan = state.decisions.plan;
    if (plan !== undefined && plan.status === "open") {
      if (plan.messages === 0) return { text: "post PROPOSE with decision_id plan (call post)", owes: true };
      return { text: "wait_for_reply for a CHALLENGE, then call decide with decision_id plan", owes: false };
    }
  }
  if (lead && state.phase === "EXECUTE") {
    const todo = Object.values(state.tasks).find((task) => task.status === "todo");
    if (todo !== undefined) return { text: `assign ${todo.id} (${todo.task}): call assign`, owes: true };
    const unreviewed = Object.entries(state.prs).find(
      ([url, pr]) =>
        !pr.reviews.some((review) => review.verdict === "approve" && review.by !== pr.author) &&
        !Object.values(state.tasks).some((task) => task.kind === "review" && task.pr === url),
    );
    if (unreviewed !== undefined) return { text: `assign review of PR ${unreviewed[0]} to the other agent: call assign`, owes: true };
  }
  if (state.phase === "PLAN" && !lead) {
    const plan = state.decisions.plan;
    if (plan !== undefined && plan.status === "open" && plan.messages === 1 && plan.challenges === 0) {
      return { text: "the plan PROPOSE is open: post one CHALLENGE with a test (call post) or stay silent and wait_for_reply", owes: false };
    }
  }
  return { text: lead ? "nothing owed; call wait_for_reply for the other PM's STATUS" : "nothing owed; call wait_for_reply", owes: false };
}
