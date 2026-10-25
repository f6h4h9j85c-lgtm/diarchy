/**
 * What a goal needs from an agent or the human right now. Shared by `status`,
 * `inbox-skim`, and `gate`; pure over GoalState plus the message list, except
 * for reading an inbox cursor file (never writing it).
 */
import { existsSync, readFileSync } from "node:fs";
import { FIELD_MAX_CHARS, oneLine, reviewOwed, threadsBeforePlan, } from "../protocol/index.js";
import { budgetTrigger, hms, lastOfType, sortMessages } from "../vault/render/shared.js";
/** Tasks still owed: implement tasks not done, review tasks whose review is still owed (`reviewOwed`, as BUSY_REVIEWING counts them). */
export function openAssignments(state, agent) {
    const open = [];
    for (const task of Object.values(state.tasks)) {
        if (task.assignee === null || task.kind === null || task.status === "todo")
            continue;
        if (agent !== undefined && task.assignee !== agent)
            continue;
        if (task.kind === "review" ? !reviewOwed(state, task) : task.status === "done")
            continue;
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
/** Decisions whose CHALLENGE still awaits the lead's DECIDE, open or decided; the one the deadlock watch is on first. */
export function challengedThreads(state) {
    const watched = state.deadlock_watch?.decision_id;
    return Object.entries(state.decisions)
        .flatMap(([id, decision]) => decision.challenge === null
        ? []
        : [{ id, from: decision.challenge.from, challengeId: decision.challenge.id, open: decision.status === "open" }])
        .sort((a, b) => Number(b.id === watched) - Number(a.id === watched));
}
/** PRs no other agent has approved whose latest review by another agent is request_changes (the fix and re-review loop). */
export function changesRequested(state, messages) {
    const ordered = sortMessages(messages);
    const found = [];
    for (const [url, pr] of Object.entries(state.prs)) {
        const others = pr.reviews.filter((review) => review.by !== pr.author);
        const latest = others[others.length - 1];
        if (latest === undefined || latest.verdict !== "request_changes" || others.some((review) => review.verdict === "approve"))
            continue;
        let reviewedAt = ordered.length - 1;
        while (reviewedAt >= 0 && !isReviewOf(ordered[reviewedAt], latest.by, url))
            reviewedAt -= 1;
        const fixed = ordered.slice(reviewedAt + 1).some((message) => isFixOf(message, pr.author, url));
        found.push({ url, author: pr.author, by: latest.by, fixed });
    }
    return found;
}
function isReviewOf(message, by, url) {
    return message.type === "STATUS" && message.from === by && (message.evidence ?? []).some((item) => item.kind === "review" && item.url === url);
}
/** A STATUS from the author with a commit, citing this PR or no PR at all. */
function isFixOf(message, author, url) {
    if (message.type !== "STATUS" || message.from !== author)
        return false;
    const evidence = message.evidence ?? [];
    const prs = evidence.flatMap((item) => (item.kind === "pr" ? [item.url] : []));
    return evidence.some((item) => item.kind === "commit") && (prs.length === 0 || prs.includes(url));
}
/** Messages after the agent's inbox cursor, excluding its own. Reads the cursor file; never moves it. */
export function unreadFor(goal, messages, agent) {
    const path = goal.paths.inbox(agent);
    let cursor = null;
    if (existsSync(path)) {
        const inbox = JSON.parse(readFileSync(path, "utf8"));
        cursor = inbox.cursor ?? null;
    }
    return sortMessages(messages).filter((message) => (cursor === null || message.id > cursor) && message.from !== agent);
}
/**
 * The `diarchy reply` invocation that answers the current block, mirroring the
 * goal.md question callout (RENDERING.md 4.1). Null unless BLOCKED.
 */
export function replyHint(state, messages) {
    if (state.phase !== "BLOCKED")
        return null;
    const ordered = sortMessages(messages);
    const ask = lastOfType(ordered, "ASK_HUMAN");
    if (ask === undefined)
        return 'diarchy reply "<your answer>"';
    const replyTo = ask.reply_to === undefined ? undefined : ordered.find((message) => message.id === ask.reply_to);
    if (replyTo?.type === "CHALLENGE") {
        const decision = ask.decision_id ?? replyTo.decision_id ?? "plan";
        // A human ruling on `plan` is rejected by PHASE_GATE while another thread is open; a plain reply opens a new decided thread and unblocks.
        return decision === "plan" && threadsBeforePlan(state).length > 0 ? 'diarchy reply "<ruling>"' : `diarchy reply "<ruling>" --decision ${decision}`;
    }
    if (replyTo !== undefined || ask.reply_to !== undefined)
        return 'diarchy reply "<your answer>"';
    const hit = budgetTrigger(ask, state);
    return `diarchy reply "continue" --budget ${hit.counter}=${Number(hit.limit) * 2}`;
}
/** Why the run is BLOCKED, in one short clause. */
export function blockSummary(state, messages) {
    const ordered = sortMessages(messages);
    const stop = [...ordered].reverse().find((message) => message.type === "BLOCKED" && message.from === "human");
    const ask = lastOfType(ordered, "ASK_HUMAN");
    if (stop !== undefined && (ask === undefined || stop.ts > ask.ts))
        return "stopped by the human";
    if (ask === undefined)
        return "blocked";
    const replyTo = ask.reply_to === undefined ? undefined : ordered.find((message) => message.id === ask.reply_to);
    if (replyTo?.type === "BLOCKED")
        return `${replyTo.from} is blocked (${replyTo.kind ?? "external"})`;
    if (replyTo?.type === "CHALLENGE")
        return `deadlock on ${ask.decision_id ?? replyTo.decision_id ?? "plan"}`;
    const hit = budgetTrigger(ask, state);
    return `budget reached: ${hit.counter} ${hit.used} of ${hit.limit}`;
}
/** Which store trigger blocked the run: WALL_CLOCK (clock or spend), TOTAL_BUDGET, DEADLOCK, BLOCKED, or STOP. */
export function blockReason(state, messages) {
    const ordered = sortMessages(messages);
    const stop = [...ordered].reverse().find((message) => message.type === "BLOCKED" && message.from === "human");
    const ask = lastOfType(ordered, "ASK_HUMAN");
    if (stop !== undefined && (ask === undefined || stop.ts > ask.ts))
        return "STOP";
    if (ask === undefined)
        return "BLOCKED";
    if (ask.reply_to !== undefined) {
        const replyTo = ordered.find((message) => message.id === ask.reply_to);
        return replyTo?.type === "CHALLENGE" ? "DEADLOCK" : "BLOCKED";
    }
    return budgetTrigger(ask, state).counter === "messages_total" ? "TOTAL_BUDGET" : "WALL_CLOCK";
}
/** The imperative next step for `agent`, in priority order. */
export function nextStep(state, messages, agent, unread) {
    const lead = state.lead === agent;
    if (state.phase === "DONE")
        return { text: "goal is DONE; nothing to do", owes: false };
    if (state.phase === "BLOCKED") {
        return { text: `waiting on the human (${blockSummary(state, messages)}); call wait_for_reply`, owes: false };
    }
    const review = openAssignments(state, agent).find((assignment) => assignment.kind === "review");
    if (review !== undefined && review.pr !== null) {
        return { text: `you hold review of PR ${oneLine(review.pr, FIELD_MAX_CHARS)}: review it, then call status with review evidence`, owes: true };
    }
    const implement = openAssignments(state, agent).find((assignment) => assignment.kind === "implement");
    if (implement !== undefined) {
        const where = implement.branch === null ? "" : ` on branch ${oneLine(implement.branch, FIELD_MAX_CHARS)}`;
        return {
            text: `you hold ${implement.task} (${oneLine(implement.text)})${where}: finish it, then call status with commit and test evidence`,
            owes: true,
        };
    }
    const first = threadsBeforePlan(state);
    // PHASE_GATE decides plan last, so point the lead at the other open threads first.
    const decideFirst = `decide ${first.join(", ")} first (call decide with decision_id ${first[0]}), then plan`;
    if (lead) {
        const challenged = challengedThreads(state)[0];
        if (challenged !== undefined) {
            const watch = state.deadlock_watch;
            const due = watch?.decision_id !== challenged.id ? "" : ` (deadlock in ${watch.remaining} messages or by ${hms(watch.deadline)} UTC)`;
            const awaiting = `thread ${challenged.id} has a CHALLENGE from ${challenged.from} awaiting your DECIDE`;
            if (!challenged.open) {
                return { text: `${awaiting}: call decide with supersedes ${challenged.id}, reply_to ${challenged.challengeId}${due}`, owes: true };
            }
            if (challenged.id === "plan" && first.length > 0)
                return { text: `${awaiting}, but plan is decided last: ${decideFirst}${due}`, owes: true };
            return { text: `${awaiting}: call decide${due}`, owes: true };
        }
    }
    if (unread.length > 0) {
        return { text: `${unread.length} unread message${unread.length === 1 ? "" : "s"}: call read, then act on them`, owes: true };
    }
    const toFix = changesRequested(state, messages).find((pr) => pr.author === agent && !pr.fixed);
    if (toFix !== undefined) {
        return {
            text: `PR ${oneLine(toFix.url, FIELD_MAX_CHARS)} has request_changes from ${toFix.by}: fix it, then call status with commit evidence`,
            owes: true,
        };
    }
    if (lead && state.phase === "PLAN") {
        const plan = state.decisions.plan;
        if (plan !== undefined && plan.status === "open") {
            if (plan.messages === 0)
                return { text: "post PROPOSE with decision_id plan (call post)", owes: true };
            if (first.length > 0)
                return { text: decideFirst, owes: true };
            // Silence is legal (PROPOSE -> DECIDE, PROTOCOL.md section 7); diarchy-pm bounds the wait the same way.
            return {
                text: "wait_for_reply for a CHALLENGE; after two timeouts with none, or once the challenger posts something else, call decide with decision_id plan (basis authority, body: no CHALLENGE came)",
                owes: false,
            };
        }
    }
    if (lead && state.phase === "EXECUTE") {
        const tasks = Object.values(state.tasks);
        const todo = tasks.find((task) => task.status === "todo");
        if (todo !== undefined)
            return { text: `assign ${todo.id} (${oneLine(todo.task)}): call assign`, owes: true };
        // A human ruling on an open plan (`diarchy reply --decision plan`) opens EXECUTE with no tasks.
        if (!tasks.some((task) => task.kind === "implement"))
            return { text: "EXECUTE has no tasks: ASSIGN each with new_task (call assign)", owes: true };
        const reviewing = new Set(tasks.filter((task) => reviewOwed(state, task)).map((task) => task.pr));
        const rereview = changesRequested(state, messages).find((pr) => pr.fixed && !reviewing.has(pr.url));
        if (rereview !== undefined) {
            return { text: `assign a re-review of PR ${oneLine(rereview.url, FIELD_MAX_CHARS)} to ${rereview.by}: call assign`, owes: true };
        }
        const unreviewed = Object.entries(state.prs).find(([url, pr]) => !pr.reviews.some((review) => review.by !== pr.author) && !reviewing.has(url));
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
//# sourceMappingURL=brief.js.map