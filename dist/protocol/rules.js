/**
 * One function per ANTI-SLOP.md rule. Each returns a Rejection whose text is
 * the doc's error message with placeholders filled, or null when the rule
 * passes. `RULES_IN_ORDER` is the doc's evaluation order.
 */
import { checkMessageShape, compactTs, isMessageType, parseMessageId, schemaMessage, typedOnlyMessage, } from "./schema.js";
import { allowedTypes, authoredPr, challengeCount, challengers, isKnownSender, isPm, limitHit, messageRef, newEvidenceKeys, openThreads, pendingReviewUrl, phaseAllows, planBudgetSpent, prAuthor, repliesToOpenChallenge, roleOf, talkRatioReached, targetDecisionId, totalBudgetReached, } from "./state.js";
import { BODY_MAX_WORDS, isAck, isOneClaim, wordCount } from "./text.js";
import { AGENT_HUMAN, AGENT_SYSTEM, ASSIGN_REASONS, RULE_IDS, } from "./types.js";
export const RULES_IN_ORDER = [...RULE_IDS];
const reject = (rule, message) => ({ ok: false, rule, message });
/** Read a field before the shape is known (WRITER_OWNED and TYPED_ONLY run first). */
function rawField(message, key) {
    return message[key];
}
const CLAIM_TYPES = ["PROPOSE", "CHALLENGE", "DECIDE"];
const BODY_REQUIRED = ["KICKOFF", "BLOCKED", "ASK_HUMAN"];
const TALK_EXEMPT = ["STATUS", "BLOCKED", "DONE"];
// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const writerOwned = ({ message, callerAgent }) => {
    const from = rawField(message, "from");
    if (from === undefined || from === callerAgent)
        return null;
    return reject("WRITER_OWNED", `This server posts as "${callerAgent}". Set from: ${callerAgent} or omit it.`);
};
// ---------------------------------------------------------------------------
// validator (stateless), plus the store half of SCHEMA
// ---------------------------------------------------------------------------
function identityProblem(message, state) {
    if (message.goal !== state.goal)
        return { field: "goal", problem: `expected ${state.goal}` };
    if (message.phase !== state.phase)
        return { field: "phase", problem: `expected ${state.phase}` };
    const parts = parseMessageId(message.id);
    if (parts === null)
        return { field: "id", problem: "must be a message id" };
    if (parts.agent !== message.from)
        return { field: "id", problem: "agent segment must equal from" };
    if (parts.type !== message.type)
        return { field: "id", problem: "type segment must equal type" };
    if (parts.ts_compact !== compactTs(message.ts))
        return { field: "id", problem: "timestamp segment must equal ts" };
    if (!isKnownSender(state, message.from))
        return { field: "from", problem: `unknown agent ${message.from}` };
    if (message.to !== "all" && message.to !== AGENT_HUMAN && !isPm(state, message.to)) {
        return { field: "to", problem: `unknown agent ${message.to}` };
    }
    if (message.reply_to !== undefined && messageRef(state, message.reply_to) === undefined) {
        return { field: "reply_to", problem: `${message.reply_to} does not exist` };
    }
    return null;
}
function decideProblem(message, state) {
    if (message.supersedes !== undefined) {
        if (message.decision_id !== undefined) {
            return { field: "decision_id", problem: "omit it when supersedes is set; the store assigns the next D<n>" };
        }
        const old = state.decisions[message.supersedes];
        if (old === undefined)
            return { field: "supersedes", problem: `unknown decision ${message.supersedes}` };
        if (old.status === "superseded") {
            return {
                field: "supersedes",
                problem: `${message.supersedes} is already superseded by ${old.superseded_by}; supersede that instead`,
            };
        }
    }
    else if (message.decision_id !== undefined && state.decisions[message.decision_id] === undefined) {
        return { field: "decision_id", problem: `unknown decision ${message.decision_id}` };
    }
    const human = message.from === AGENT_HUMAN;
    if ((message.basis === "human") !== human) {
        return { field: "basis", problem: human ? "the human decides with basis human" : "human is reserved for the human" };
    }
    const target = targetDecisionId(message);
    if (message.basis === "adopted-challenge" && target !== undefined) {
        const challenge = state.decisions[target]?.challenge ?? null;
        if (challenge === null || message.reply_to !== challenge.id) {
            return { field: "basis", problem: `adopted-challenge requires reply_to the open CHALLENGE on decision ${target}` };
        }
    }
    if (message.tasks !== undefined && message.decision_id !== "plan") {
        return { field: "tasks", problem: "allowed only on decision plan" };
    }
    if (message.ac_add !== undefined && message.decision_id !== "plan") {
        return { field: "ac_add", problem: "allowed only on decision plan" };
    }
    if (message.budgets !== undefined && !human)
        return { field: "budgets", problem: "human only" };
    return null;
}
function threadProblem(message, state) {
    if (message.type === "KICKOFF") {
        const all = Object.keys(state.acs);
        const cited = new Set(message.re);
        if (all.length !== cited.size || !all.every((ac) => cited.has(ac))) {
            return { field: "re", problem: `KICKOFF must cite every acceptance criterion (${all.join(", ")})` };
        }
    }
    if (message.type === "PROPOSE" && message.decision_id !== undefined && !(message.decision_id in state.decisions)) {
        return { field: "decision_id", problem: `unknown decision ${message.decision_id}; omit it and the store assigns one` };
    }
    if (message.type === "CHALLENGE" && message.decision_id !== undefined) {
        const decision = state.decisions[message.decision_id];
        if (decision === undefined)
            return { field: "decision_id", problem: `unknown decision ${message.decision_id}` };
        if (decision.status === "superseded") {
            // No DECIDE can answer it: the lead supersedes only the live decision (decideProblem).
            return {
                field: "decision_id",
                problem: `${message.decision_id} is superseded by ${decision.superseded_by}; challenge that instead`,
            };
        }
        const target = message.reply_to === undefined ? undefined : messageRef(state, message.reply_to);
        if (target !== undefined && target.decision_id !== message.decision_id) {
            return { field: "reply_to", problem: `${message.reply_to} is not on decision ${message.decision_id}` };
        }
    }
    if (message.type === "DECIDE")
        return decideProblem(message, state);
    return null;
}
function workProblem(message, state) {
    if (message.type === "ASSIGN") {
        if (!isPm(state, message.to))
            return { field: "to", problem: "ASSIGN needs an agent id" };
        if (message.pr !== undefined && !(message.pr in state.prs)) {
            return { field: "pr", problem: `${message.pr} has no pr evidence yet; the implementer posts STATUS with pr evidence first` };
        }
    }
    if ((message.type === "ASSIGN" || message.type === "STATUS") && message.task !== undefined) {
        if (!(message.task in state.tasks))
            return { field: "task", problem: `unknown task ${message.task}` };
    }
    for (const item of message.evidence ?? []) {
        if (item.kind === "human") {
            const ref = messageRef(state, item.id);
            if (ref === undefined || ref.from !== AGENT_HUMAN)
                return { field: "evidence", problem: `human message ${item.id} not found` };
        }
        if (item.kind === "review" && prAuthor(state, message, item.url) === undefined) {
            return { field: "evidence", problem: `review url ${item.url} has no prior pr evidence` };
        }
    }
    return null;
}
/** Store-level SCHEMA checks: references that must exist in goal state. */
export function stateProblem(message, state) {
    return identityProblem(message, state) ?? threadProblem(message, state) ?? workProblem(message, state);
}
const schema = ({ message, state }) => {
    const shape = checkMessageShape(message);
    if (!shape.ok)
        return shape.rule === "SCHEMA" ? reject("SCHEMA", shape.message) : null;
    const problem = stateProblem(shape.message, state);
    return problem === null ? null : reject("SCHEMA", schemaMessage(problem.field, problem.problem));
};
const typedOnly = ({ message }) => {
    const type = rawField(message, "type");
    return isMessageType(type) ? null : reject("TYPED_ONLY", typedOnlyMessage(type));
};
const humanLastResort = ({ message }) => {
    if (message.type !== "ASK_HUMAN" || message.from === AGENT_SYSTEM)
        return null;
    return reject("HUMAN_LAST_RESORT", "Agents do not post ASK_HUMAN. Post BLOCKED with kind: external and the store pages the human.");
};
const oneClaim = ({ message }) => {
    if (!CLAIM_TYPES.includes(message.type) || isOneClaim(message.claim ?? ""))
        return null;
    return reject("ONE_CLAIM", "Put exactly one falsifiable sentence in `claim` (40 words max, one terminal punctuation mark). Move everything else to the body.");
};
const wordCap = ({ message }) => {
    const words = wordCount(message.body);
    if (words <= BODY_MAX_WORDS)
        return null;
    return reject("WORD_CAP", `Body is ${words} words; cut to ${BODY_MAX_WORDS} or fewer. Put detail in a file and cite it as \`file\` evidence.`);
};
const challengeNeedsTest = ({ message }) => {
    if (message.type !== "CHALLENGE")
        return null;
    const hasTest = (message.evidence ?? []).some((item) => item.kind === "test" && item.test.trim() !== "");
    if (hasTest)
        return null;
    return reject("CHALLENGE_NEEDS_TEST", "Add an evidence item `kind: test` whose `test` names the cheapest check that would settle this claim.");
};
const noDomainRouting = ({ message }) => {
    if (message.type !== "ASSIGN" || message.reason === undefined)
        return null;
    if (ASSIGN_REASONS.includes(message.reason))
        return null;
    return reject("NO_DOMAIN_ROUTING", "`reason` must be availability, continuity, or load-balance. Do not route work by model or by frontend/backend ownership.");
};
const noAck = ({ message }) => {
    const emptyBody = message.body.trim() === "";
    const adds = !(BODY_REQUIRED.includes(message.type) && emptyBody) &&
        !isAck(message.body, message.claim) &&
        !(message.type === "STATUS" && (message.evidence ?? []).length === 0);
    if (adds)
        return null;
    return reject("NO_ACK", "This message adds nothing. Post STATUS with evidence, a CHALLENGE with a test, or post nothing.");
};
// ---------------------------------------------------------------------------
// store (needs goal state)
// ---------------------------------------------------------------------------
const singleKickoff = ({ message, state }) => {
    if (message.type !== "KICKOFF" || state.kickoff_id === null)
        return null;
    return reject("SINGLE_KICKOFF", `Goal ${state.goal} is already active (phase ${state.phase}). Call read instead of kickoff.`);
};
const totalBudget = ({ message, state }) => {
    if (!isPm(state, message.from) || !totalBudgetReached(state))
        return null;
    const { messages_total: used } = state.used;
    const { messages_total: limit } = state.limits;
    return reject("TOTAL_BUDGET", `Goal used ${used} of ${limit} messages and is BLOCKED. The human has been paged; stop posting and wait.`);
};
const wallClock = ({ message, state, now }) => {
    if (!isPm(state, message.from) || limitHit(state, now) === null)
        return null;
    return reject("WALL_CLOCK", `Wall clock ${state.limits.wall_clock_minutes} min exceeded; goal is BLOCKED. The human has been paged; stop posting and wait.`);
};
const phaseGate = ({ message, state, callerAgent }) => {
    const planDecideWhileOpen = message.type === "DECIDE" &&
        message.decision_id === "plan" &&
        openThreads(state).some((id) => id !== "plan");
    // One watch at a time: a second CHALLENGE would replace it and leave the first one unenforced.
    const challengeWhileWatched = message.type === "CHALLENGE" &&
        state.deadlock_watch !== null &&
        message.decision_id !== state.deadlock_watch.decision_id;
    if (phaseAllows(state, message.type) && !planDecideWhileOpen && !challengeWhileWatched)
        return null;
    const allowed = allowedTypes(state, callerAgent);
    return reject("PHASE_GATE", `${message.type} is not allowed in phase ${state.phase}. Allowed now: ${allowed.length > 0 ? allowed.join(", ") : "none"}.`);
};
function requiredRoles(message, state) {
    const lead = { roles: ["lead"], label: "lead", agents: state.lead };
    const pm = { roles: ["lead", "challenger"], label: "lead or challenger", agents: state.agents.join(", ") };
    switch (message.type) {
        case "KICKOFF":
            return { roles: ["human", "lead"], label: "lead", agents: state.lead };
        case "PROPOSE":
            return message.decision_id === "plan" ? lead : pm;
        case "CHALLENGE":
            return { roles: ["challenger"], label: "challenger", agents: challengers(state).join(", ") };
        case "DECIDE":
            return state.phase === "BLOCKED" ? { roles: ["human"], label: "human", agents: AGENT_HUMAN } : lead;
        case "ASSIGN":
        case "DONE":
            return lead;
        case "ASK_HUMAN":
            return { roles: ["system"], label: "system", agents: AGENT_SYSTEM };
        default:
            return pm;
    }
}
const roleGate = ({ message, state }) => {
    const required = requiredRoles(message, state);
    const role = roleOf(state, message.from);
    if (required.roles.includes(role))
        return null;
    return reject("ROLE_GATE", `${message.type} may only be posted by the ${required.label} (${required.agents}). You are the ${role}.`);
};
const planBudget = ({ message, state }) => {
    if (state.phase !== "PLAN" || !isPm(state, message.from) || !planBudgetSpent(state))
        return null;
    if (message.type === "BLOCKED" || (message.type === "DECIDE" && message.from === state.lead))
        return null;
    return reject("PLAN_BUDGET", `PLAN budget (${state.limits.plan_messages} messages) is spent. Lead: post DECIDE with decision_id plan now. Challenger: wait.`);
};
const talkWorkRatio = ({ message, state }) => {
    if (state.phase !== "EXECUTE" || !isPm(state, message.from) || !talkRatioReached(state))
        return null;
    if (TALK_EXEMPT.includes(message.type) || repliesToOpenChallenge(state, message))
        return null;
    return reject("TALK_WORK_RATIO", `${state.used.talk_since_work} messages since the last STATUS with work evidence. Post STATUS with a commit, pr, review, or a passing or failing test, or post BLOCKED or DONE, before anything else.`);
};
const citeAc = ({ message, state }) => {
    const known = Object.keys(state.acs);
    const unknown = message.re.filter((ac) => !(ac in state.acs));
    if (message.re.length > 0 && unknown.length === 0)
        return null;
    return reject("CITE_AC", `Set \`re\` to acceptance criteria that exist in goal.md (${known.join(", ")}). Unknown: ${unknown.length > 0 ? unknown.join(", ") : "none cited"}.`);
};
const newEvidence = ({ message, state }) => {
    if (message.type !== "CHALLENGE" || message.decision_id === undefined)
        return null;
    const decision = state.decisions[message.decision_id];
    const needsNew = state.phase === "EXECUTE" || decision?.status !== "open";
    if (!needsNew || newEvidenceKeys(state, message.decision_id, message.evidence ?? []).length > 0)
        return null;
    return reject("NEW_EVIDENCE", `This CHALLENGE needs new evidence: a \`test\` with result fail, a \`human\` message, or an \`external\` URL not cited before on decision ${message.decision_id}.`);
};
const oneChallenge = ({ message, state }) => {
    if (message.type !== "CHALLENGE" || message.decision_id === undefined)
        return null;
    if (challengeCount(state, message.decision_id) < state.limits.challenges_per_decision)
        return null;
    return reject("ONE_CHALLENGE", `Decision ${message.decision_id} was already challenged once. Wait for the lead's DECIDE; reopening needs new evidence.`);
};
const twoRounds = ({ message, state }) => {
    if (message.decision_id === undefined)
        return null;
    const decision = state.decisions[message.decision_id];
    if (decision === undefined || decision.status !== "open")
        return null;
    if (message.type === "DECIDE") {
        // The human may rule on any thread, and a spent PLAN budget leaves the lead's DECIDE as the only way out.
        if (decision.messages > 0 || message.from === AGENT_HUMAN || planBudgetSpent(state))
            return null;
        return reject("TWO_ROUNDS", `Decision ${message.decision_id} has no PROPOSE yet. Only the lead's PROPOSE may follow.`);
    }
    if (message.type !== "PROPOSE" && message.type !== "CHALLENGE")
        return null;
    const overflow = message.type === "PROPOSE" ? decision.messages >= 1 : decision.messages >= state.limits.rounds_per_decision;
    if (!overflow)
        return null;
    return reject("TWO_ROUNDS", `Decision ${message.decision_id} already has a PROPOSE and a CHALLENGE. Only the lead's DECIDE may follow.`);
};
function immutableTarget(message, state) {
    if (message.type === "PROPOSE") {
        const decision = message.decision_id === undefined ? undefined : state.decisions[message.decision_id];
        return decision !== undefined && decision.status !== "open" ? (message.decision_id ?? null) : null;
    }
    if (message.type !== "DECIDE")
        return null;
    if (message.supersedes === undefined) {
        const decision = message.decision_id === undefined ? undefined : state.decisions[message.decision_id];
        return decision !== undefined && decision.status !== "open" ? (message.decision_id ?? null) : null;
    }
    if (message.from === AGENT_HUMAN)
        return null;
    const old = state.decisions[message.supersedes];
    const own = newEvidenceKeys(state, message.supersedes, message.evidence ?? []).length > 0;
    const viaChallenge = old?.challenge !== null &&
        old?.challenge !== undefined &&
        message.reply_to === old.challenge.id &&
        old.challenge.new_evidence.length > 0;
    return own || viaChallenge ? null : message.supersedes;
}
const decisionImmutable = ({ message, state }) => {
    const id = immutableTarget(message, state);
    if (id === null)
        return null;
    return reject("DECISION_IMMUTABLE", `Decision ${id} is decided. To supersede it, cite new evidence: a \`test\` with result fail, a \`human\` message, or an \`external\` URL.`);
};
function selfReviewedUrl(message, state) {
    if (message.type === "ASSIGN" && message.kind === "review" && message.pr !== undefined) {
        if (state.prs[message.pr]?.author === message.to)
            return message.pr;
    }
    for (const item of message.evidence ?? []) {
        if (item.kind === "review" && prAuthor(state, message, item.url) === message.from)
            return item.url;
    }
    return null;
}
const noSelfReview = ({ message, state }) => {
    const url = selfReviewedUrl(message, state);
    if (url === null)
        return null;
    return reject("NO_SELF_REVIEW", `You authored ${url}. Review evidence must come from the other agent; ask the lead to ASSIGN a review.`);
};
const busyReviewing = ({ message, state }) => {
    if (message.type !== "ASSIGN" || message.kind !== "implement")
        return null;
    const url = pendingReviewUrl(state, message.to);
    if (url === undefined)
        return null;
    return reject("BUSY_REVIEWING", `${message.to} is reviewing ${url}. Assign implementation to another agent or wait for the review evidence.`);
};
/**
 * PROTOCOL.md 9.2 (a) to (f), as a list of what is missing. Only recorded
 * state counts: the DONE's own evidence is an attestation and cannot set an
 * AC passing, register a PR, or close a task, so a PR it cites must already
 * be registered and approved (c).
 */
export function doneMissing(message, state) {
    const missing = [];
    if (state.phase !== "EXECUTE")
        missing.push(`phase is ${state.phase}`);
    if (message.from !== state.lead)
        missing.push(`sender ${message.from} is not the lead`);
    for (const [ac, { status }] of Object.entries(state.acs)) {
        if (status === "failing")
            missing.push(`${ac} latest test failed`);
        else if (status !== "passing")
            missing.push(`${ac} has no passing test`);
    }
    if (state.review_required) {
        for (const [url, pr] of Object.entries(state.prs)) {
            const approved = pr.reviews.some((review) => review.verdict === "approve" && review.by !== pr.author);
            if (!approved)
                missing.push(`PR ${url} has no approve review from the other agent`);
        }
        const cited = new Set((message.evidence ?? []).flatMap((item) => (item.kind === "pr" ? [item.url] : [])));
        for (const url of cited) {
            if (!(url in state.prs))
                missing.push(`PR ${url} was never posted in a STATUS or reviewed`);
        }
    }
    for (const id of openThreads(state))
        missing.push(`decision ${id} is open`);
    for (const [id, decision] of Object.entries(state.decisions)) {
        if (decision.challenge !== null)
            missing.push(`decision ${id} has an unanswered CHALLENGE`);
    }
    if (state.deadlock_watch !== null)
        missing.push(`deadlock watch on ${state.deadlock_watch.decision_id} is active`);
    for (const task of Object.values(state.tasks)) {
        if (task.status !== "done")
            missing.push(`task ${task.id} is ${task.status}`);
        else if (state.review_required && task.kind !== "review" && !authoredPr(state, task.assignee)) {
            missing.push(`task ${task.id} has no pr evidence from ${task.assignee ?? "an assignee"}`);
        }
    }
    if (state.review_required && Object.keys(state.prs).length === 0)
        missing.push("no PR is registered");
    return missing;
}
const donePrecondition = ({ message, state }) => {
    if (message.type !== "DONE")
        return null;
    const missing = doneMissing(message, state);
    if (missing.length === 0)
        return null;
    return reject("DONE_PRECONDITION", `Not done: ${missing.join("; ")}. Finish every task, post STATUS with passing tests for each AC, and get the other agent's approve review on each PR.`);
};
/** DEADLOCK is a store trigger, not a rejection; the engine fires it after acceptance. */
const deadlock = () => null;
export const RULES = {
    WRITER_OWNED: writerOwned,
    SCHEMA: schema,
    TYPED_ONLY: typedOnly,
    HUMAN_LAST_RESORT: humanLastResort,
    ONE_CLAIM: oneClaim,
    WORD_CAP: wordCap,
    CHALLENGE_NEEDS_TEST: challengeNeedsTest,
    NO_DOMAIN_ROUTING: noDomainRouting,
    NO_ACK: noAck,
    SINGLE_KICKOFF: singleKickoff,
    TOTAL_BUDGET: totalBudget,
    WALL_CLOCK: wallClock,
    PHASE_GATE: phaseGate,
    ROLE_GATE: roleGate,
    PLAN_BUDGET: planBudget,
    TALK_WORK_RATIO: talkWorkRatio,
    CITE_AC: citeAc,
    NEW_EVIDENCE: newEvidence,
    ONE_CHALLENGE: oneChallenge,
    TWO_ROUNDS: twoRounds,
    DECISION_IMMUTABLE: decisionImmutable,
    NO_SELF_REVIEW: noSelfReview,
    BUSY_REVIEWING: busyReviewing,
    DONE_PRECONDITION: donePrecondition,
    DEADLOCK: deadlock,
};
//# sourceMappingURL=rules.js.map