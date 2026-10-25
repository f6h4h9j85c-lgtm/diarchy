/**
 * The protocol engine: runs the rules in order, applies the accepted
 * message's state transition, and fires the store triggers (TOTAL_BUDGET,
 * WALL_CLOCK, DEADLOCK). Pure: no filesystem, no clock; `now` is a parameter.
 *
 * Store contract: call `tick` before `evaluate` on each post so time-based
 * transitions land first; persist `state` and act on `effects` of every
 * Transition returned.
 */
import { RULES, RULES_IN_ORDER } from "./rules.js";
import { checkMessageShape, compactTs, isoSeconds } from "./schema.js";
import { deadlinePassed, evidenceKey, isPm, limitHit, messageRef, minutesSince, newEvidenceKeys, nextDecisionId, nextTaskId, repliesToOpenChallenge, totalBudgetReached, } from "./state.js";
import { truncateWords } from "./text.js";
import { AGENT_HUMAN, AGENT_SYSTEM, DEFAULT_LIMITS, } from "./types.js";
export { allowedTypes } from "./state.js";
const DEADLOCK_MINUTES = 10;
const DEADLOCK_REMAINING = 2;
const ASK_HUMAN_BODY_WORDS = 100;
// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------
/** Run every rule in ANTI-SLOP.md order; on acceptance apply the transition. */
export function evaluate(message, state, options) {
    const shape = checkMessageShape(message);
    const ctx = {
        message: shape.ok ? shape.message : message,
        state,
        now: options.now,
        callerAgent: options.callerAgent,
    };
    for (const id of RULES_IN_ORDER) {
        const rejection = RULES[id](ctx);
        if (rejection !== null)
            return rejection;
    }
    return accept(ctx);
}
function accept(ctx) {
    const state = structuredClone(ctx.state);
    const message = { ...ctx.message };
    const effects = [];
    applyCounters(state, message);
    applyByType(state, message, effects);
    state.messages.push({
        id: message.id,
        from: message.from,
        type: message.type,
        decision_id: message.decision_id ?? null,
        re: [...message.re],
    });
    state.used.wall_clock_minutes = Math.floor(minutesSince(state.created, ctx.now));
    state.updated = message.ts;
    applyTriggers(state, message, effects, ctx.now);
    return { ok: true, message, state, effects };
}
const TALK_EXEMPT = ["STATUS", "BLOCKED", "DONE"];
function applyCounters(state, message) {
    if (!isPm(state, message.from))
        return;
    state.used.messages_total += 1;
    if (state.phase === "PLAN" && message.type !== "KICKOFF")
        state.used.plan_messages += 1;
    if (message.type === "STATUS") {
        state.used.talk_since_work = 0;
    }
    else if (state.phase === "EXECUTE" && !TALK_EXEMPT.includes(message.type) && !repliesToOpenChallenge(state, message)) {
        state.used.talk_since_work += 1;
    }
}
function applyByType(state, message, effects) {
    switch (message.type) {
        case "KICKOFF":
            return applyKickoff(state, message, effects);
        case "PROPOSE":
            return applyPropose(state, message, effects);
        case "CHALLENGE":
            return applyChallenge(state, message);
        case "DECIDE":
            return applyDecide(state, message, effects);
        case "ASSIGN":
            return applyAssign(state, message, effects);
        case "STATUS":
            return applyWork(state, message, effects);
        case "DONE":
            applyWork(state, message, effects);
            return setPhase(state, effects, "DONE");
        case "BLOCKED":
            return applyBlocked(state, message, effects);
        default:
            return undefined;
    }
}
function setPhase(state, effects, to) {
    effects.push({ kind: "phase", from: state.phase, to });
    state.phase = to;
}
function newDecision(status, proposer) {
    return { status, proposer, messages: 0, challenges: 0, supersedes: null, superseded_by: null, evidence: [], challenge: null };
}
function recordEvidence(decision, keys) {
    for (const key of keys) {
        if (!decision.evidence.includes(key))
            decision.evidence.push(key);
    }
}
function applyKickoff(state, message, effects) {
    state.kickoff_id = message.id;
    state.decisions.plan = newDecision("open", null);
    effects.push({ kind: "phase", from: null, to: "PLAN" }, { kind: "decision_opened", id: "plan" });
}
function applyPropose(state, message, effects) {
    const id = message.decision_id ?? nextDecisionId(state);
    message.decision_id = id;
    let decision = state.decisions[id];
    if (decision === undefined) {
        decision = newDecision("open", message.from);
        state.decisions[id] = decision;
        effects.push({ kind: "decision_opened", id });
    }
    decision.proposer ??= message.from;
    decision.messages += 1;
}
function applyChallenge(state, message) {
    const id = message.decision_id ?? "plan";
    const decision = state.decisions[id];
    if (decision === undefined)
        return;
    const items = message.evidence ?? [];
    const fresh = newEvidenceKeys(state, id, items);
    decision.messages += 1;
    decision.challenges += 1;
    recordEvidence(decision, items.map(evidenceKey));
    decision.challenge = { id: message.id, from: message.from, new_evidence: fresh };
    const deadline = new Date(Date.parse(message.ts) + DEADLOCK_MINUTES * 60_000);
    state.deadlock_watch = {
        decision_id: id,
        challenge_id: message.id,
        remaining: DEADLOCK_REMAINING,
        deadline: isoSeconds(deadline),
    };
}
function applyDecide(state, message, effects) {
    const human = message.from === AGENT_HUMAN;
    const keys = (message.evidence ?? []).map(evidenceKey);
    let id = message.decision_id;
    if (id !== undefined) {
        const decision = state.decisions[id];
        if (decision !== undefined) {
            decision.status = "decided";
            decision.challenge = null;
            recordEvidence(decision, keys);
        }
        effects.push({ kind: "decision_closed", id, supersedes: null });
    }
    else if (message.supersedes !== undefined) {
        id = nextDecisionId(state);
        message.decision_id = id;
        const old = state.decisions[message.supersedes];
        if (old !== undefined) {
            old.status = "superseded";
            old.superseded_by = id;
            old.challenge = null;
        }
        state.decisions[id] = { ...newDecision("decided", message.from), supersedes: message.supersedes, evidence: keys };
        effects.push({ kind: "decision_closed", id, supersedes: message.supersedes });
    }
    else if (human) {
        id = nextDecisionId(state);
        message.decision_id = id;
        state.decisions[id] = { ...newDecision("decided", message.from), evidence: keys };
        effects.push({ kind: "decision_closed", id, supersedes: null });
    }
    const watch = state.deadlock_watch;
    if (watch !== null && (human || watch.decision_id === id || watch.decision_id === message.supersedes)) {
        state.deadlock_watch = null;
    }
    if (human)
        applyHumanDecide(state, message, effects);
    if (id === "plan" && state.phase === "PLAN")
        closePlan(state, message, effects);
}
function applyHumanDecide(state, message, effects) {
    if (state.phase === "BLOCKED")
        setPhase(state, effects, state.blocked_from ?? "EXECUTE");
    state.blocked_from = null;
    if (message.budgets !== undefined)
        state.limits = { ...state.limits, ...message.budgets };
}
function closePlan(state, message, effects) {
    for (const text of message.tasks ?? []) {
        const task = blankTask(nextTaskId(state), text);
        state.tasks[task.id] = task;
        effects.push(taskEffect(task));
    }
    for (const criterion of message.ac_add ?? []) {
        const ac = `AC${Object.keys(state.acs).length + 1}`;
        state.acs[ac] = { criterion, status: "open" };
        effects.push({ kind: "ac_added", ac, criterion });
    }
    setPhase(state, effects, "EXECUTE");
}
function blankTask(id, text) {
    return { id, task: text, kind: null, assignee: null, branch: null, worktree: null, pr: null, status: "todo" };
}
function taskEffect(task) {
    return { kind: "task", id: task.id, task: task.task, status: task.status, assignee: task.assignee, branch: task.branch };
}
function applyAssign(state, message, effects) {
    const id = message.task ?? nextTaskId(state);
    const task = state.tasks[id] ?? blankTask(id, message.new_task ?? "");
    task.kind = message.kind === "review" ? "review" : "implement";
    task.assignee = message.to;
    task.status = "assigned";
    if (task.kind === "implement") {
        task.branch = message.branch ?? null;
        task.worktree = message.worktree ?? null;
    }
    else {
        task.pr = message.pr ?? null;
    }
    state.tasks[id] = task;
    effects.push(taskEffect(task));
}
/** STATUS and DONE: PR registry, reviews, AC statuses, task status. */
function applyWork(state, message, effects) {
    const items = message.evidence ?? [];
    for (const item of items) {
        if (item.kind === "pr" && !(item.url in state.prs))
            state.prs[item.url] = { author: message.from, reviews: [] };
    }
    for (const item of items) {
        if (item.kind === "review")
            applyReview(state, message.from, item.url, item.verdict, effects);
        if (item.kind === "test" && item.result !== "pending")
            applyTest(state, message.re, item.result, effects);
    }
    if (message.task !== undefined && message.task_status !== undefined) {
        const task = state.tasks[message.task];
        if (task !== undefined && task.status !== message.task_status) {
            task.status = message.task_status;
            effects.push(taskEffect(task));
        }
    }
}
function applyReview(state, by, url, verdict, effects) {
    state.prs[url]?.reviews.push({ by, verdict });
    for (const task of Object.values(state.tasks)) {
        if (task.kind === "review" && task.pr === url && task.assignee === by && task.status !== "done") {
            task.status = "done";
            effects.push(taskEffect(task));
        }
    }
}
function applyTest(state, re, result, effects) {
    const status = result === "pass" ? "passing" : "failing";
    for (const ac of re) {
        const entry = state.acs[ac];
        if (entry === undefined || entry.status === status)
            continue;
        entry.status = status;
        effects.push({ kind: "ac_status", ac, status });
    }
}
function applyBlocked(state, message, effects) {
    if (message.kind !== "external")
        return;
    const summary = truncateWords(message.body, ASK_HUMAN_BODY_WORDS).replace(/[.!?]+$/, "");
    block(state, effects, "BLOCKED", {
        re: message.re,
        body: `${message.from} is BLOCKED (external): ${summary}. Answer with \`diarchy reply "<text>"\`.`,
        reply_to: message.id,
        decision_id: null,
    });
}
function block(state, effects, reason, ask) {
    state.blocked_from = state.phase;
    setPhase(state, effects, "BLOCKED");
    effects.push({ kind: "system_message", type: "ASK_HUMAN", reason, to: "human", ...ask });
}
function allAcs(state) {
    return Object.keys(state.acs);
}
function blockForTotalBudget(state, effects) {
    const { messages_total: used } = state.used;
    const { messages_total: limit } = state.limits;
    block(state, effects, "TOTAL_BUDGET", {
        re: allAcs(state),
        body: `Goal used ${used} of ${limit} messages and is BLOCKED. Answer with \`diarchy reply "<text>" --budget messages_total=<n>\`.`,
        reply_to: null,
        decision_id: null,
    });
}
function blockForLimit(state, effects, hit) {
    const body = hit === "wall_clock"
        ? `Wall clock ${state.limits.wall_clock_minutes} min exceeded; goal is BLOCKED. Answer with \`diarchy reply "<text>" --budget wall_clock_minutes=<n>\`.`
        : `Spend ${state.used.spend_usd} of ${state.limits.spend_usd} USD reached; goal is BLOCKED. Answer with \`diarchy reply "<text>" --budget spend_usd=<n>\`.`;
    block(state, effects, "WALL_CLOCK", { re: allAcs(state), body, reply_to: null, decision_id: null });
}
function blockForDeadlock(state, effects) {
    const watch = state.deadlock_watch;
    if (watch === null)
        return;
    const challenge = messageRef(state, watch.challenge_id);
    block(state, effects, "DEADLOCK", {
        re: challenge?.re ?? allAcs(state),
        body: `Lead did not DECIDE ${watch.decision_id} within ${DEADLOCK_REMAINING} messages or ${DEADLOCK_MINUTES} minutes. Goal BLOCKED; human paged.`,
        reply_to: watch.challenge_id,
        decision_id: watch.decision_id,
    });
}
function inProgress(state) {
    return state.phase === "PLAN" || state.phase === "EXECUTE";
}
function applyTriggers(state, message, effects, now) {
    if (!inProgress(state))
        return;
    if (totalBudgetReached(state))
        return blockForTotalBudget(state, effects);
    const hit = limitHit(state, now);
    if (hit !== null)
        return blockForLimit(state, effects, hit);
    const watch = state.deadlock_watch;
    if (watch === null)
        return;
    if (watch.challenge_id !== message.id)
        watch.remaining -= 1;
    if (watch.remaining <= 0 || deadlinePassed(watch, now))
        blockForDeadlock(state, effects);
}
/** Time-based transitions for `wait_for_reply`: WALL_CLOCK and the DEADLOCK timer. */
export function tick(state, now) {
    if (!inProgress(state))
        return null;
    const hit = limitHit(state, now);
    const deadlocked = state.deadlock_watch !== null && deadlinePassed(state.deadlock_watch, now);
    if (hit === null && !deadlocked)
        return null;
    const next = structuredClone(state);
    const effects = [];
    next.used.wall_clock_minutes = Math.floor(minutesSince(next.created, now));
    next.updated = isoSeconds(now);
    if (hit !== null)
        blockForLimit(next, effects, hit);
    else
        blockForDeadlock(next, effects);
    return { ok: true, state: next, effects };
}
// ---------------------------------------------------------------------------
// initialState and assignId
// ---------------------------------------------------------------------------
/** Goal state right after kickoff.md is written, before the KICKOFF message is evaluated. */
export function initialState(kickoff, config, now) {
    const acs = {};
    kickoff.acceptance_criteria.forEach((criterion, index) => {
        acs[`AC${index + 1}`] = { criterion, status: "open" };
    });
    const seq = {};
    for (const agent of [...kickoff.agents, AGENT_HUMAN, AGENT_SYSTEM])
        seq[agent] = 0;
    return {
        protocol_version: 1,
        goal: kickoff.goal,
        created: kickoff.created,
        lead: kickoff.lead,
        challenger: kickoff.challenger,
        agents: [...kickoff.agents],
        kickoff_id: null,
        phase: "PLAN",
        blocked_from: null,
        limits: { ...DEFAULT_LIMITS, ...config.budgets, ...kickoff.budgets },
        used: { plan_messages: 0, messages_total: 0, talk_since_work: 0, wall_clock_minutes: 0, spend_usd: 0 },
        seq,
        last_ts: null,
        decisions: {},
        prs: {},
        deadlock_watch: null,
        acs,
        tasks: {},
        messages: [],
        review_required: config.review.required,
        updated: isoSeconds(now),
    };
}
/**
 * PROTOCOL.md 2.1: per-agent seq, and a ts strictly after the previous one
 * (the store sleeps to `ts` if it is in the future). Call under the goal lock.
 */
export function assignId(state, from, type, now) {
    const seq = (state.seq[from] ?? 0) + 1;
    let ts = isoSeconds(now);
    if (state.last_ts !== null && ts <= state.last_ts) {
        ts = isoSeconds(new Date(Date.parse(state.last_ts) + 1_000));
    }
    const id = `${compactTs(ts)}-${String(seq).padStart(4, "0")}-${from}-${type}`;
    return { id, ts, seq, state: { ...state, seq: { ...state.seq, [from]: seq }, last_ts: ts } };
}
//# sourceMappingURL=engine.js.map