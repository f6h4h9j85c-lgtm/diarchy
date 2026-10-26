/** Read-only queries over GoalState shared by the rules and the engine. */
import {
  AGENT_HUMAN,
  AGENT_SYSTEM,
  type AgentId,
  type DeadlockWatch,
  type EvidenceItem,
  type GoalState,
  type Message,
  type MessageRef,
  type MessageType,
  type Phase,
  type TaskState,
} from "./types.js";

export type Role = "lead" | "challenger" | "human" | "system" | "unknown";

export function isPm(state: GoalState, agent: string): boolean {
  return state.agents.includes(agent);
}

export function isKnownSender(state: GoalState, agent: string): boolean {
  return isPm(state, agent) || agent === AGENT_HUMAN || agent === AGENT_SYSTEM;
}

export function roleOf(state: GoalState, agent: string): Role {
  if (agent === state.lead) return "lead";
  if (isPm(state, agent)) return "challenger";
  if (agent === AGENT_HUMAN) return "human";
  if (agent === AGENT_SYSTEM) return "system";
  return "unknown";
}

export function challengers(state: GoalState): AgentId[] {
  return state.agents.filter((agent) => agent !== state.lead);
}

// ---------------------------------------------------------------------------
// Time and budgets
// ---------------------------------------------------------------------------

export function minutesSince(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 60_000;
}

export type LimitHit = "wall_clock" | "spend";

/** WALL_CLOCK: wall clock, or spend when a spend limit is configured. */
export function limitHit(state: GoalState, now: Date): LimitHit | null {
  if (minutesSince(state.created, now) >= state.limits.wall_clock_minutes) return "wall_clock";
  if (state.limits.spend_usd !== null && state.used.spend_usd >= state.limits.spend_usd) return "spend";
  return null;
}

export function totalBudgetReached(state: GoalState): boolean {
  return state.used.messages_total >= state.limits.messages_total;
}

export function planBudgetSpent(state: GoalState): boolean {
  return state.used.plan_messages >= state.limits.plan_messages;
}

export function talkRatioReached(state: GoalState): boolean {
  return state.used.talk_since_work >= state.limits.talk_work_ratio;
}

export function deadlinePassed(watch: DeadlockWatch, now: Date): boolean {
  return now.getTime() >= Date.parse(watch.deadline);
}

// ---------------------------------------------------------------------------
// Messages and decisions
// ---------------------------------------------------------------------------

export function messageRef(state: GoalState, id: string): MessageRef | undefined {
  return state.messages.find((ref) => ref.id === id);
}

/** The decision a PROPOSE/CHALLENGE/DECIDE acts on: `decision_id`, else `supersedes`. */
export function targetDecisionId(message: Message): string | undefined {
  return message.decision_id ?? message.supersedes;
}

/** A decision id followed by every decision it supersedes, transitively. */
export function decisionLineage(state: GoalState, id: string): string[] {
  const lineage: string[] = [];
  let current: string | null = id;
  while (current !== null && !lineage.includes(current)) {
    lineage.push(current);
    current = state.decisions[current]?.supersedes ?? null;
  }
  return lineage;
}

export function openThreads(state: GoalState): string[] {
  return Object.entries(state.decisions)
    .filter(([, decision]) => decision.status === "open")
    .map(([id]) => id);
}

/** Open threads other than `plan`: PHASE_GATE refuses DECIDE `plan` until each is decided (PROTOCOL.md section 6). */
export function threadsBeforePlan(state: GoalState): string[] {
  return openThreads(state).filter((id) => id !== "plan");
}

export function challengeCount(state: GoalState, id: string): number {
  return decisionLineage(state, id).reduce((sum, d) => sum + (state.decisions[d]?.challenges ?? 0), 0);
}

export function nextDecisionId(state: GoalState): string {
  const used = Object.keys(state.decisions).filter((id) => id !== "plan").length;
  return `D${used + 1}`;
}

export function nextTaskId(state: GoalState): string {
  return `T${Object.keys(state.tasks).length + 1}`;
}

/** DECIDE that answers the CHALLENGE still open on its decision (TALK_WORK_RATIO exemption). */
export function repliesToOpenChallenge(state: GoalState, message: Message): boolean {
  if (message.type !== "DECIDE") return false;
  const target = targetDecisionId(message);
  const challenge = target === undefined ? null : (state.decisions[target]?.challenge ?? null);
  return challenge !== null && message.reply_to === challenge.id;
}

// ---------------------------------------------------------------------------
// Evidence (PROTOCOL.md 3.1 "new evidence")
// ---------------------------------------------------------------------------

export function evidenceKey(item: EvidenceItem): string {
  switch (item.kind) {
    case "commit":
      return `commit:${item.sha}`;
    case "test":
      return `test:${item.test}`;
    case "file":
      return `file:${item.path}`;
    case "human":
      return `human:${item.id}`;
    default:
      return `${item.kind}:${item.url}`;
  }
}

export function qualifiesAsNew(item: EvidenceItem): boolean {
  if (item.kind === "test") return item.result === "fail";
  return item.kind === "human" || item.kind === "external";
}

export function citedEvidenceKeys(state: GoalState, decisionId: string): Set<string> {
  const keys = new Set<string>();
  for (const id of decisionLineage(state, decisionId)) {
    for (const key of state.decisions[id]?.evidence ?? []) keys.add(key);
  }
  return keys;
}

/** Keys of the items that count as new evidence relative to `decisionId`. */
export function newEvidenceKeys(state: GoalState, decisionId: string, items: EvidenceItem[]): string[] {
  const cited = citedEvidenceKeys(state, decisionId);
  return items.filter(qualifiesAsNew).map(evidenceKey).filter((key) => !cited.has(key));
}

/** Who introduced a PR: the registry, or this very message's `pr` item. */
export function prAuthor(state: GoalState, message: Message, url: string): AgentId | undefined {
  const registered = state.prs[url]?.author;
  if (registered !== undefined) return registered;
  const introduced = (message.evidence ?? []).some((item) => item.kind === "pr" && item.url === url);
  return introduced ? message.from : undefined;
}

/** Has `agent` introduced a PR on this goal (first `pr` evidence)? DONE 9.2(f). */
export function authoredPr(state: GoalState, agent: AgentId | null): boolean {
  return agent !== null && Object.values(state.prs).some((pr) => pr.author === agent);
}

/**
 * Does this review task still owe its review? The engine closes a review task
 * when its assignee's `review` evidence on the PR lands, so one that is not done
 * is owed, a re-review ASSIGNed after an earlier review included. A STATUS
 * marking it done settles it only if the assignee has reviewed that PR at all
 * (budget.json keeps no record of which review closed which task).
 */
export function reviewOwed(state: GoalState, task: TaskState): boolean {
  if (task.kind !== "review" || task.assignee === null || task.pr === null) return false;
  if (task.status !== "done") return true;
  return !(state.prs[task.pr]?.reviews.some((review) => review.by === task.assignee) ?? false);
}

/** The PR an agent still owes a review on, if any (BUSY_REVIEWING). */
export function pendingReviewUrl(state: GoalState, agent: AgentId): string | undefined {
  return Object.values(state.tasks).find((task) => task.assignee === agent && reviewOwed(state, task))?.pr ?? undefined;
}

// ---------------------------------------------------------------------------
// Phase and role gates (PROTOCOL.md sections 4 to 6)
// ---------------------------------------------------------------------------

const PHASE_TYPES: Record<Phase, MessageType[]> = {
  PLAN: ["PROPOSE", "CHALLENGE", "DECIDE", "STATUS", "BLOCKED"],
  EXECUTE: ["STATUS", "ASSIGN", "BLOCKED", "DONE", "CHALLENGE", "DECIDE"],
  BLOCKED: ["DECIDE", "ASK_HUMAN"],
  DONE: [],
};

const ROLE_TYPES: Record<Role, MessageType[]> = {
  lead: ["KICKOFF", "PROPOSE", "DECIDE", "ASSIGN", "STATUS", "DONE", "BLOCKED"],
  challenger: ["PROPOSE", "CHALLENGE", "STATUS", "BLOCKED"],
  human: ["KICKOFF", "DECIDE"],
  system: ["ASK_HUMAN"],
  unknown: [],
};

/** Is `type` legal in the current phase for any sender? */
export function phaseAllows(state: GoalState, type: MessageType): boolean {
  if (type === "KICKOFF") return state.kickoff_id === null;
  if (state.kickoff_id === null) return false;
  return PHASE_TYPES[state.phase].includes(type);
}

/** May this role post `type` now? DECIDE is the lead's, except in BLOCKED where it is the human's. */
export function roleAllows(state: GoalState, role: Role, type: MessageType): boolean {
  if (type === "DECIDE") return state.phase === "BLOCKED" ? role === "human" : role === "lead";
  return ROLE_TYPES[role].includes(type);
}

const TALK_GATED_EXEMPT: MessageType[] = ["STATUS", "BLOCKED", "DONE"];

/** A PM DECIDE needs a thread with a PROPOSE or a decided one to supersede, unless PLAN_BUDGET is spent (TWO_ROUNDS). */
function decideHasTarget(state: GoalState): boolean {
  return planBudgetSpent(state) || Object.values(state.decisions).some((d) => d.status !== "open" || d.messages > 0);
}

/** Types the agent may post now, after phase, role, thread, and budget gates. */
export function allowedTypes(state: GoalState, agent: AgentId): MessageType[] {
  const role = roleOf(state, agent);
  if (state.kickoff_id === null) return roleAllows(state, role, "KICKOFF") ? ["KICKOFF"] : [];
  let types = PHASE_TYPES[state.phase].filter((type) => roleAllows(state, role, type));
  if (!isPm(state, agent)) return types;
  if (totalBudgetReached(state)) return [];
  if (!decideHasTarget(state)) types = types.filter((type) => type !== "DECIDE");
  // PHASE_GATE: the lead owes a DECIDE on the watched thread before the next CHALLENGE.
  if (state.deadlock_watch !== null) types = types.filter((type) => type !== "CHALLENGE");
  if (state.phase === "PLAN" && planBudgetSpent(state)) {
    types = types.filter((type) => type === "BLOCKED" || (type === "DECIDE" && role === "lead"));
  }
  if (state.phase === "EXECUTE" && talkRatioReached(state)) {
    // Only a DECIDE answering an open CHALLENGE is exempt (TALK_WORK_RATIO).
    const challengeOpen = Object.values(state.decisions).some((decision) => decision.challenge !== null);
    types = types.filter((type) => TALK_GATED_EXEMPT.includes(type) || (type === "DECIDE" && challengeOpen));
  }
  return types;
}
