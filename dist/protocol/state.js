/** Read-only queries over GoalState shared by the rules and the engine. */
import { AGENT_HUMAN, AGENT_SYSTEM, } from "./types.js";
export function isPm(state, agent) {
    return state.agents.includes(agent);
}
export function isKnownSender(state, agent) {
    return isPm(state, agent) || agent === AGENT_HUMAN || agent === AGENT_SYSTEM;
}
export function roleOf(state, agent) {
    if (agent === state.lead)
        return "lead";
    if (isPm(state, agent))
        return "challenger";
    if (agent === AGENT_HUMAN)
        return "human";
    if (agent === AGENT_SYSTEM)
        return "system";
    return "unknown";
}
export function challengers(state) {
    return state.agents.filter((agent) => agent !== state.lead);
}
// ---------------------------------------------------------------------------
// Time and budgets
// ---------------------------------------------------------------------------
export function minutesSince(iso, now) {
    return (now.getTime() - Date.parse(iso)) / 60_000;
}
/** WALL_CLOCK: wall clock, or spend when a spend limit is configured. */
export function limitHit(state, now) {
    if (minutesSince(state.created, now) >= state.limits.wall_clock_minutes)
        return "wall_clock";
    if (state.limits.spend_usd !== null && state.used.spend_usd >= state.limits.spend_usd)
        return "spend";
    return null;
}
export function totalBudgetReached(state) {
    return state.used.messages_total >= state.limits.messages_total;
}
export function planBudgetSpent(state) {
    return state.used.plan_messages >= state.limits.plan_messages;
}
export function talkRatioReached(state) {
    return state.used.talk_since_work >= state.limits.talk_work_ratio;
}
export function deadlinePassed(watch, now) {
    return now.getTime() >= Date.parse(watch.deadline);
}
// ---------------------------------------------------------------------------
// Messages and decisions
// ---------------------------------------------------------------------------
export function messageRef(state, id) {
    return state.messages.find((ref) => ref.id === id);
}
/** The decision a PROPOSE/CHALLENGE/DECIDE acts on: `decision_id`, else `supersedes`. */
export function targetDecisionId(message) {
    return message.decision_id ?? message.supersedes;
}
/** A decision id followed by every decision it supersedes, transitively. */
export function decisionLineage(state, id) {
    const lineage = [];
    let current = id;
    while (current !== null && !lineage.includes(current)) {
        lineage.push(current);
        current = state.decisions[current]?.supersedes ?? null;
    }
    return lineage;
}
export function openThreads(state) {
    return Object.entries(state.decisions)
        .filter(([, decision]) => decision.status === "open")
        .map(([id]) => id);
}
/** Open threads other than `plan`: PHASE_GATE refuses DECIDE `plan` until each is decided (PROTOCOL.md section 6). */
export function threadsBeforePlan(state) {
    return openThreads(state).filter((id) => id !== "plan");
}
export function challengeCount(state, id) {
    return decisionLineage(state, id).reduce((sum, d) => sum + (state.decisions[d]?.challenges ?? 0), 0);
}
export function nextDecisionId(state) {
    const used = Object.keys(state.decisions).filter((id) => id !== "plan").length;
    return `D${used + 1}`;
}
export function nextTaskId(state) {
    return `T${Object.keys(state.tasks).length + 1}`;
}
/** DECIDE that answers the CHALLENGE still open on its decision (TALK_WORK_RATIO exemption). */
export function repliesToOpenChallenge(state, message) {
    if (message.type !== "DECIDE")
        return false;
    const target = targetDecisionId(message);
    const challenge = target === undefined ? null : (state.decisions[target]?.challenge ?? null);
    return challenge !== null && message.reply_to === challenge.id;
}
// ---------------------------------------------------------------------------
// Evidence (PROTOCOL.md 3.1 "new evidence")
// ---------------------------------------------------------------------------
export function evidenceKey(item) {
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
export function qualifiesAsNew(item) {
    if (item.kind === "test")
        return item.result === "fail";
    return item.kind === "human" || item.kind === "external";
}
export function citedEvidenceKeys(state, decisionId) {
    const keys = new Set();
    for (const id of decisionLineage(state, decisionId)) {
        for (const key of state.decisions[id]?.evidence ?? [])
            keys.add(key);
    }
    return keys;
}
/** Keys of the items that count as new evidence relative to `decisionId`. */
export function newEvidenceKeys(state, decisionId, items) {
    const cited = citedEvidenceKeys(state, decisionId);
    return items.filter(qualifiesAsNew).map(evidenceKey).filter((key) => !cited.has(key));
}
/** Who introduced a PR: the registry, or this very message's `pr` item. */
export function prAuthor(state, message, url) {
    const registered = state.prs[url]?.author;
    if (registered !== undefined)
        return registered;
    const introduced = (message.evidence ?? []).some((item) => item.kind === "pr" && item.url === url);
    return introduced ? message.from : undefined;
}
/** Has `agent` introduced a PR on this goal (first `pr` evidence)? DONE 9.2(f). */
export function authoredPr(state, agent) {
    return agent !== null && Object.values(state.prs).some((pr) => pr.author === agent);
}
/**
 * Does this review task still owe its review? The engine closes a review task
 * only when its assignee's `review` evidence on the PR lands (a STATUS with
 * task_status done leaves it as it was), so one that is not done is owed, a
 * re-review ASSIGNed after an earlier review included. A done task with no
 * review from its assignee is still owed: diarchy 0.2.0 and older let a STATUS
 * mark a review task done, and goals they stored keep that status.
 */
export function reviewOwed(state, task) {
    if (task.kind !== "review" || task.assignee === null || task.pr === null)
        return false;
    if (task.status !== "done")
        return true;
    return !(state.prs[task.pr]?.reviews.some((review) => review.by === task.assignee) ?? false);
}
/** The PR an agent still owes a review on, if any (BUSY_REVIEWING). */
export function pendingReviewUrl(state, agent) {
    return Object.values(state.tasks).find((task) => task.assignee === agent && reviewOwed(state, task))?.pr ?? undefined;
}
// ---------------------------------------------------------------------------
// Phase and role gates (PROTOCOL.md sections 4 to 6)
// ---------------------------------------------------------------------------
const PHASE_TYPES = {
    PLAN: ["PROPOSE", "CHALLENGE", "DECIDE", "STATUS", "BLOCKED"],
    EXECUTE: ["STATUS", "ASSIGN", "BLOCKED", "DONE", "CHALLENGE", "DECIDE"],
    BLOCKED: ["DECIDE", "ASK_HUMAN"],
    DONE: [],
};
const ROLE_TYPES = {
    lead: ["KICKOFF", "PROPOSE", "DECIDE", "ASSIGN", "STATUS", "DONE", "BLOCKED"],
    challenger: ["PROPOSE", "CHALLENGE", "STATUS", "BLOCKED"],
    human: ["KICKOFF", "DECIDE"],
    system: ["ASK_HUMAN"],
    unknown: [],
};
/** Is `type` legal in the current phase for any sender? */
export function phaseAllows(state, type) {
    if (type === "KICKOFF")
        return state.kickoff_id === null;
    if (state.kickoff_id === null)
        return false;
    return PHASE_TYPES[state.phase].includes(type);
}
/** May this role post `type` now? DECIDE is the lead's, except in BLOCKED where it is the human's. */
export function roleAllows(state, role, type) {
    if (type === "DECIDE")
        return state.phase === "BLOCKED" ? role === "human" : role === "lead";
    return ROLE_TYPES[role].includes(type);
}
const TALK_GATED_EXEMPT = ["STATUS", "BLOCKED", "DONE"];
/** A PM DECIDE needs a thread with a PROPOSE or a decided one to supersede, unless PLAN_BUDGET is spent (TWO_ROUNDS). */
function decideHasTarget(state) {
    return planBudgetSpent(state) || Object.values(state.decisions).some((d) => d.status !== "open" || d.messages > 0);
}
/** Types the agent may post now, after phase, role, thread, and budget gates. */
export function allowedTypes(state, agent) {
    const role = roleOf(state, agent);
    if (state.kickoff_id === null)
        return roleAllows(state, role, "KICKOFF") ? ["KICKOFF"] : [];
    let types = PHASE_TYPES[state.phase].filter((type) => roleAllows(state, role, type));
    if (!isPm(state, agent))
        return types;
    if (totalBudgetReached(state))
        return [];
    if (!decideHasTarget(state))
        types = types.filter((type) => type !== "DECIDE");
    // PHASE_GATE: the lead owes a DECIDE on the watched thread before the next CHALLENGE.
    if (state.deadlock_watch !== null)
        types = types.filter((type) => type !== "CHALLENGE");
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
//# sourceMappingURL=state.js.map