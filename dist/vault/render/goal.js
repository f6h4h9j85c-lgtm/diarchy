import { GENERATED, SEP, blockTrigger, budgetLine, budgetTrigger, byId, cell, challengerList, code, decisionCount, escapeBlockStarts, hms, humanSlot, italic, localHint, sortMessages, tableRow, tableSeparator, utcDate, } from "./shared.js";
export function renderGoal(messages, state, kickoff, opts = {}) {
    const ordered = sortMessages(messages);
    const chunks = [`${GENERATED}\n# ${kickoff.goal}`];
    if (state?.phase === "BLOCKED")
        chunks.push(questionCallout(ordered, state, opts));
    chunks.push(escapeBlockStarts(kickoff.goal_text), `[chat](chat.md)${SEP}[decisions (${decisionCount(ordered)})](decisions.md)`, "## Status", statusTable(ordered, state, kickoff), `${budgetLine(state)}${SEP}${humanSlot(state, ordered)}`, "## Acceptance Criteria", acTable(state, kickoff), "## Tasks", tasksTable(state));
    return `${chunks.join("\n\n")}\n`;
}
// ---------------------------------------------------------------------------
// 4.2 to 4.4 Tables
// ---------------------------------------------------------------------------
function statusTable(messages, state, kickoff) {
    const last = messages[messages.length - 1];
    const ts = last?.ts ?? kickoff.created;
    const row = [
        state?.phase ?? "PLAN",
        state?.lead ?? kickoff.lead,
        state === null ? kickoff.challenger : challengerList(state),
        `${utcDate(ts)} ${hms(ts)} UTC`,
    ];
    return [tableRow(["phase", "lead", "challenger", "updated"]), tableSeparator(4), tableRow(row)].join("\n");
}
function acTable(state, kickoff) {
    const rows = state === null
        ? kickoff.acceptance_criteria.map((criterion, index) => [`AC${index + 1}`, cell(criterion), "open"])
        : Object.entries(state.acs).map(([id, ac]) => [
            id,
            cell(ac.criterion),
            ac.status === "failing" ? "**failing**" : ac.status,
        ]);
    return [tableRow(["id", "criterion", "status"]), tableSeparator(3), ...rows.map(tableRow)].join("\n");
}
function taskNumber(task) {
    return Number(task.id.slice(1));
}
/** Implementation tasks only: review assignments live in chat.md and as `review` evidence. */
function tasksTable(state) {
    const tasks = Object.values(state?.tasks ?? {})
        .filter((task) => task.kind !== "review")
        .sort((a, b) => taskNumber(a) - taskNumber(b));
    const rows = tasks.map((task) => tableRow([task.id, cell(task.task), task.assignee ?? "", task.branch === null ? "" : code(task.branch), task.status]));
    return [tableRow(["id", "task", "assignee", "branch", "status"]), tableSeparator(5), ...rows].join("\n");
}
// ---------------------------------------------------------------------------
// 4.1 The question callout
// ---------------------------------------------------------------------------
function quote(paragraphs) {
    const lines = ["[!WARNING]"];
    paragraphs.forEach((paragraph, index) => {
        if (index > 0)
            lines.push("");
        lines.push(...paragraph.split("\n"));
    });
    return lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}
/** The BLOCKED body as a nested quote inside the callout. */
function nested(body) {
    return escapeBlockStarts(body.trim())
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
}
function questionCallout(messages, state, opts) {
    const ids = byId(messages);
    const cause = blockTrigger(messages) ?? messages[messages.length - 1];
    const from = state.blocked_from ?? cause.phase;
    const since = `**Human needed** since ${hms(cause.ts)} UTC ${localHint(cause.ts, opts.localTz)}. The run is BLOCKED (from ${from}); nothing moves until you answer.`;
    const replyTo = cause.type === "ASK_HUMAN" && cause.reply_to !== undefined ? ids.get(cause.reply_to) : undefined;
    if (cause.type === "BLOCKED" || replyTo?.type === "BLOCKED") {
        return quote([since, ...externalParagraphs(replyTo ?? cause, from)]);
    }
    if (replyTo?.type === "CHALLENGE")
        return quote([since, ...deadlockParagraphs(cause, replyTo, ids, state, from)]);
    return quote([since, ...budgetParagraphs(cause, state, from)]);
}
function externalParagraphs(blocked, from) {
    return [
        `**${blocked.from} is blocked (external), re ${blocked.re.join(", ")}:**`,
        nested(blocked.body),
        `**To answer:** run \`diarchy reply "<your answer>"\`. It is posted as a DECIDE with basis human, recorded in decisions.md, and ${from} resumes. \`diarchy stop\` ends the run and leaves it BLOCKED.`,
    ];
}
/**
 * A human ruling on an open `plan` is rejected while another thread is open, so the hint drops `--decision` in that case.
 * Otherwise a ruling on an open `plan` closes PLAN at once and, carrying no tasks, opens an empty EXECUTE.
 * A reopened `plan` is already decided: the ruling supersedes it and EXECUTE resumes with its tasks, as for any thread.
 */
function answerLine(decision, state, from) {
    const planOpen = decision === "plan" && state.decisions.plan?.status === "open";
    const otherOpen = Object.entries(state.decisions).some(([id, thread]) => id !== decision && thread.status === "open");
    if (planOpen && otherOpen) {
        return `**To answer:** run \`diarchy reply "<ruling>"\`. Your ruling is recorded as a new DECIDE with basis human, ${from} resumes, and ${state.lead} must then DECIDE plan. \`diarchy stop\` ends the run.`;
    }
    if (planOpen) {
        return `**To answer:** run \`diarchy reply "<ruling>" --decision plan\`. Your ruling closes plan as a DECIDE with basis human, and EXECUTE begins with no tasks: ${state.lead} must ASSIGN each task with new_task. \`diarchy stop\` ends the run.`;
    }
    return `**To answer:** run \`diarchy reply "<ruling>" --decision ${decision}\`. Your ruling closes ${decision} as a DECIDE with basis human and ${from} resumes. \`diarchy stop\` ends the run.`;
}
function deadlockParagraphs(ask, challenge, ids, state, from) {
    const decision = ask.decision_id ?? challenge.decision_id ?? "";
    const target = challenge.reply_to === undefined ? undefined : ids.get(challenge.reply_to);
    const first = target === undefined
        ? ""
        : `1. ${target.from} ${target.type} ${hms(target.ts)}: ${italic(target.claim ?? "")}\n`;
    const test = (challenge.evidence ?? []).find((item) => item.kind === "test");
    const probe = test === undefined ? "" : ` (test ${code(test.test)}${SEP}${test.result === "fail" ? "**fail**" : test.result})`;
    const second = `2. ${challenge.from} CHALLENGE ${hms(challenge.ts)}: ${italic(challenge.claim ?? "")}${probe}`;
    return [
        `**Deadlock on ${decision}, re ${challenge.re.join(", ")}.** ${state.lead} did not DECIDE within 2 messages or 10 minutes. The two positions:`,
        `${first}${second}`,
        answerLine(decision, state, from),
    ];
}
function budgetParagraphs(ask, state, from) {
    const hit = budgetTrigger(ask, state);
    const suggested = String(Number(hit.limit) * 2);
    return [
        `**Budget reached:** ${hit.counter} ${hit.used} of ${hit.limit}. Both agents are stopped.`,
        `**To answer:** run \`diarchy reply "continue" --budget ${hit.counter}=${suggested}\` to raise the limit and resume ${from}, or \`diarchy stop\` to end the run.`,
    ];
}
//# sourceMappingURL=goal.js.map