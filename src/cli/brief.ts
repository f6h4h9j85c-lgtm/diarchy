/**
 * What a goal needs from an agent or the human right now. Shared by `status`,
 * `inbox-skim`, and `gate`; pure over GoalState plus the message list, except
 * for reading an inbox cursor file (never writing it).
 */
import {
  FIELD_MAX_CHARS,
  oneLine,
  reviewOwed,
  threadsBeforePlan,
  type AgentId,
  type GoalState,
  type Message,
  type TaskStatus,
} from "../protocol/index.js";
import { readInbox, type GoalRef } from "../vault/index.js";
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

/** Tasks still owed: implement tasks not done, review tasks whose review is still owed (`reviewOwed`, as BUSY_REVIEWING counts them). */
export function openAssignments(state: GoalState, agent?: AgentId): Assignment[] {
  const open: Assignment[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.assignee === null || task.kind === null || task.status === "todo") continue;
    if (agent !== undefined && task.assignee !== agent) continue;
    if (task.kind === "review" ? !reviewOwed(state, task) : task.status === "done") continue;
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

export interface ChallengedThread {
  id: string;
  from: AgentId;
  challengeId: string;
  /** False for a decided thread (an EXECUTE CHALLENGE): only a DECIDE with `supersedes` answers it. */
  open: boolean;
}

/** Decisions whose CHALLENGE still awaits the lead's DECIDE, open or decided; the one the deadlock watch is on first. */
export function challengedThreads(state: GoalState): ChallengedThread[] {
  const watched = state.deadlock_watch?.decision_id;
  return Object.entries(state.decisions)
    .flatMap(([id, decision]) =>
      decision.challenge === null
        ? []
        : [{ id, from: decision.challenge.from, challengeId: decision.challenge.id, open: decision.status === "open" }],
    )
    .sort((a, b) => Number(b.id === watched) - Number(a.id === watched));
}

export interface ChangesRequested {
  url: string;
  author: AgentId;
  /** The agent whose latest review of the PR asked for changes. */
  by: AgentId;
  /** The author has posted a STATUS with a commit for this PR since that review. */
  fixed: boolean;
}

/** PRs no other agent has approved whose latest review by another agent is request_changes (the fix and re-review loop). */
export function changesRequested(state: GoalState, messages: Message[]): ChangesRequested[] {
  const ordered = sortMessages(messages);
  const found: ChangesRequested[] = [];
  for (const [url, pr] of Object.entries(state.prs)) {
    const others = pr.reviews.filter((review) => review.by !== pr.author);
    const latest = others[others.length - 1];
    if (latest === undefined || latest.verdict !== "request_changes" || others.some((review) => review.verdict === "approve")) continue;
    let reviewedAt = ordered.length - 1;
    while (reviewedAt >= 0 && !isReviewOf(ordered[reviewedAt], latest.by, url)) reviewedAt -= 1;
    // The task named by the STATUS that introduced the PR (its first `pr` evidence) is the PR's implement task.
    const task = ordered.find((message) => message.type === "STATUS" && (message.evidence ?? []).some((item) => item.kind === "pr" && item.url === url))?.task;
    const fixed = ordered.slice(reviewedAt + 1).some((message) => isFixOf(message, pr.author, url, task));
    found.push({ url, author: pr.author, by: latest.by, fixed });
  }
  return found;
}

function isReviewOf(message: Message, by: AgentId, url: string): boolean {
  return message.type === "STATUS" && message.from === by && (message.evidence ?? []).some((item) => item.kind === "review" && item.url === url);
}

function citesUrl(message: Message, url: string): boolean {
  return (message.evidence ?? []).some((item) => "url" in item && item.url === url);
}

/** A STATUS from the author with a commit that ties to this PR: it cites the PR's url, or names the PR's implement task. */
function isFixOf(message: Message, author: AgentId, url: string, task: string | undefined): boolean {
  if (message.type !== "STATUS" || message.from !== author) return false;
  if (!(message.evidence ?? []).some((item) => item.kind === "commit")) return false;
  return citesUrl(message, url) || (task !== undefined && message.task === task);
}

/** A thread the lead PROPOSEd itself that no other PM has posted after yet: the challenger's CHALLENGE window is still open. */
function awaitsChallenger(state: GoalState, ordered: Message[], id: string): boolean {
  if (state.decisions[id]?.proposer !== state.lead) return false;
  const proposed = ordered.findIndex((message) => message.type === "PROPOSE" && message.decision_id === id);
  if (proposed < 0) return false;
  return !ordered.slice(proposed + 1).some((message) => message.from !== state.lead && state.agents.includes(message.from));
}

/**
 * Messages after the agent's inbox cursor, excluding its own. Reads the cursor
 * file, never moves it; one that will not parse counts as no cursor, as in the store.
 */
export function unreadFor(goal: GoalRef, messages: Message[], agent: AgentId): Message[] {
  const { cursor } = readInbox(goal.paths.inbox(agent), agent);
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
    // A human ruling on `plan` is rejected by PHASE_GATE while another thread is open; a plain reply opens a new decided thread and unblocks.
    return decision === "plan" && threadsBeforePlan(state).length > 0 ? 'diarchy reply "<ruling>"' : `diarchy reply "<ruling>" --decision ${decision}`;
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
  /** Imperative, names the MCP tool to call. One line: agent-authored parts pass through `oneLine`. */
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
  const first = threadsBeforePlan(state);
  // PHASE_GATE decides plan last, so point the lead at the other open threads first.
  const decideFirst = (id = first[0]): string => `decide ${first.join(", ")} first (call decide with decision_id ${id}), then plan`;
  // A CHALLENGE outranks the lead's own tasks: every message posted before the DECIDE spends the deadlock watch.
  if (lead) {
    const challenged = challengedThreads(state)[0];
    if (challenged !== undefined) {
      const watch = state.deadlock_watch;
      const due = watch?.decision_id !== challenged.id ? "" : ` (deadlock in ${watch.remaining} messages or by ${hms(watch.deadline)} UTC)`;
      const awaiting = `thread ${challenged.id} has a CHALLENGE from ${challenged.from} awaiting your DECIDE`;
      if (!challenged.open) {
        return { text: `${awaiting}: call decide with supersedes ${challenged.id}, reply_to ${challenged.challengeId}${due}`, owes: true };
      }
      if (challenged.id === "plan" && first.length > 0) return { text: `${awaiting}, but plan is decided last: ${decideFirst()}${due}`, owes: true };
      return { text: `${awaiting}: call decide${due}`, owes: true };
    }
  }
  const review = openAssignments(state, agent).find((assignment) => assignment.kind === "review");
  if (review !== undefined && review.pr !== null) {
    return { text: `you hold review of PR ${oneLine(review.pr, FIELD_MAX_CHARS)}: review it, then call status with review evidence`, owes: true };
  }
  const implement = openAssignments(state, agent).find((assignment) => assignment.kind === "implement");
  if (implement !== undefined) {
    const where = implement.branch === null ? "" : ` on branch ${oneLine(implement.branch, FIELD_MAX_CHARS)}`;
    // DONE 9.2(f) needs pr evidence from every implementer unless review.required is false.
    const evidence = state.review_required ? "commit, pr, and test" : "commit and test";
    return {
      text: `you hold ${implement.task} (${oneLine(implement.text)})${where}: finish it, then call status with ${evidence} evidence`,
      owes: true,
    };
  }
  if (unread.length > 0) {
    return { text: `${unread.length} unread message${unread.length === 1 ? "" : "s"}: call read, then act on them`, owes: true };
  }
  const toFix = changesRequested(state, messages).find((pr) => pr.author === agent && !pr.fixed);
  if (toFix !== undefined) {
    return {
      text: `PR ${oneLine(toFix.url, FIELD_MAX_CHARS)} has request_changes from ${toFix.by}: fix it, then call status with commit evidence and this PR as pr evidence`,
      owes: true,
    };
  }
  if (lead && state.phase === "PLAN") {
    const plan = state.decisions.plan;
    if (plan !== undefined && plan.status === "open") {
      if (plan.messages === 0) return { text: "post PROPOSE with decision_id plan (call post)", owes: true };
      // Silence is legal (PROPOSE -> DECIDE, PROTOCOL.md section 7); diarchy-pm bounds the wait the same way.
      const wait = "wait_for_reply for a CHALLENGE; after two timeouts with none, or once the challenger posts something else,";
      if (first.length > 0) {
        // A thread the lead opened keeps the challenger's CHALLENGE window, as plan does; one the challenger opened is the lead's to DECIDE now.
        const ordered = sortMessages(messages);
        const ready = first.find((id) => !awaitsChallenger(state, ordered, id));
        return ready === undefined ? { text: `${wait} ${decideFirst()}`, owes: false } : { text: decideFirst(ready), owes: true };
      }
      return { text: `${wait} call decide with decision_id plan (basis authority, body: no CHALLENGE came)`, owes: false };
    }
  }
  if (lead && state.phase === "EXECUTE") {
    const tasks = Object.values(state.tasks);
    const todo = tasks.find((task) => task.status === "todo");
    if (todo !== undefined) return { text: `assign ${todo.id} (${oneLine(todo.task)}): call assign`, owes: true };
    // A human ruling on an open plan (`diarchy reply --decision plan`) opens EXECUTE with no tasks.
    if (!tasks.some((task) => task.kind === "implement")) return { text: "EXECUTE has no tasks: ASSIGN each with new_task (call assign)", owes: true };
    const reviewing = new Set(tasks.filter((task) => reviewOwed(state, task)).map((task) => task.pr));
    const rereview = changesRequested(state, messages).find((pr) => pr.fixed && !reviewing.has(pr.url));
    if (rereview !== undefined) {
      return { text: `assign a re-review of PR ${oneLine(rereview.url, FIELD_MAX_CHARS)} to ${rereview.by}: call assign`, owes: true };
    }
    const unreviewed = Object.entries(state.prs).find(
      ([url, pr]) => !pr.reviews.some((review) => review.by !== pr.author) && !reviewing.has(url),
    );
    if (unreviewed !== undefined) {
      return { text: `assign review of PR ${oneLine(unreviewed[0], FIELD_MAX_CHARS)} to the other agent: call assign`, owes: true };
    }
  }
  if (state.phase === "PLAN" && !lead) {
    const plan = state.decisions.plan;
    if (plan !== undefined && plan.status === "open" && plan.messages === 1 && plan.challenges === 0) {
      return { text: "the plan PROPOSE is open: post one CHALLENGE with a test (call post) or stay silent and wait_for_reply", owes: false };
    }
  }
  return { text: lead ? "nothing owed; call wait_for_reply for the other PM's STATUS" : "nothing owed; call wait_for_reply", owes: false };
}
