/**
 * diarchy-mcp: the MCP tool layer of docs/PROTOCOL.md section 10 over one
 * VaultStore. One server posts as one agent. Every tool answers with the
 * store's result as JSON text plus structuredContent; a protocol rejection
 * (docs/ANTI-SLOP.md `{ ok: false, rule, message }`) sets isError so the
 * calling agent reads the rule and does what the message says.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "../index.js";
import { ASSIGN_KINDS, BLOCKED_KINDS, DECISION_BASES, MESSAGE_TYPES, STATUS_TASK_STATUSES, SchemaError, evidenceItemSchema, partialBudgetsSchema, } from "../protocol/index.js";
import { CorruptVaultFileError, MAX_WAIT_MS, NoGoalError, VaultStore, loadConfig, } from "../vault/index.js";
/** Error codes the server adds to the protocol's RuleId set (PROTOCOL.md section 10). */
export const SERVER_ERRORS = ["NO_GOAL", "WRONG_TOOL", "INTERNAL"];
export const TOOL_NAMES = ["kickoff", "post", "read", "wait_for_reply", "decide", "assign", "status"];
/** Message types `post` refuses because a dedicated tool builds them. */
const DEDICATED_TOOL = { KICKOFF: "kickoff", DECIDE: "decide", ASSIGN: "assign" };
const NO_GOAL_TEXT = new NoGoalError().message;
const INSTRUCTIONS = [
    "diarchy coordinates two PM agents (lead and challenger) on one goal through a shared vault.",
    "Loop: read, then at most one of post, decide, assign, status, then wait_for_reply; repeat until phase DONE or BLOCKED.",
    "Every message cites acceptance criteria in re. A rejection returns { ok: false, rule, message }: do what message says; never retry unchanged.",
].join(" ");
const serverError = (rule, message) => ({ ok: false, rule, message });
function toolResult(result) {
    const out = { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
    if ("ok" in result && result.ok === false)
        out.isError = true;
    return out;
}
function logError(error) {
    console.error(`diarchy-mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}
/** A stored vault file will not parse: say so, and send the PM to the human instead of a retry. */
function corruptFileText(error) {
    return `${error.message} The vault is damaged, not your draft, so do not retry. Post BLOCKED with kind external naming that file so the human can fix it or run diarchy stop.`;
}
/**
 * Run a tool body; NoGoalError becomes NO_GOAL, a CorruptVaultFileError (a
 * vault file that will not parse) keeps its rule (SCHEMA, or TYPED_ONLY for an
 * unknown message type) with a message naming the file, anything else
 * INTERNAL. The server never crashes on a bad input.
 */
async function runTool(body) {
    try {
        return toolResult(await body());
    }
    catch (error) {
        if (error instanceof NoGoalError)
            return toolResult(serverError("NO_GOAL", NO_GOAL_TEXT));
        logError(error);
        if (error instanceof CorruptVaultFileError)
            return toolResult({ ok: false, rule: error.rule, message: corruptFileText(error) });
        if (error instanceof SchemaError)
            return toolResult({ ok: false, rule: error.rule, message: error.message });
        return toolResult(serverError("INTERNAL", error instanceof Error ? error.message : String(error)));
    }
}
/** The active goal, else the newest, as the store's own read path does. */
function currentGoal(store) {
    return store.activeGoal() ?? store.listGoals().at(-1) ?? null;
}
// ---------------------------------------------------------------------------
// Input fields shared by several tools
// ---------------------------------------------------------------------------
const re = z
    .array(z.string())
    .optional()
    .describe('Acceptance criteria ids this message is about, e.g. ["AC1", "AC3"]. The protocol requires at least one that exists in goal.md (CITE_AC).');
const body = z
    .string()
    .optional()
    .describe("Free text, 120 words max. Must add something: acknowledgements such as agreed, thanks, or LGTM are rejected (NO_ACK).");
const evidence = z.array(evidenceItemSchema);
const replyTo = z.string().optional().describe("Message id this answers.");
export function createMcpServer(options) {
    const { projectDir, agent } = options;
    const config = loadConfig(projectDir);
    const store = options.store ?? new VaultStore({ projectDir, config, agent, ...(options.now === undefined ? {} : { now: options.now }) });
    const server = new McpServer({ name: "diarchy", version: VERSION }, { capabilities: { logging: {} }, instructions: INSTRUCTIONS });
    /** The wait_for_reply this server has in flight, if any: one agent, one wait. */
    let waiting = null;
    /**
     * Every tool call ends an earlier wait before it runs. The agent is
     * sequential, so a new call means nobody reads that wait's result any more
     * (its client timed out without sending notifications/cancelled); left
     * running it would consume the reply and move the cursor past it.
     */
    const run = (body) => {
        waiting?.abort();
        waiting = null;
        return runTool(body);
    };
    server.registerTool("kickoff", {
        title: "Kick off a goal",
        description: "Start the one goal this vault will run; you become lead and the other agent challenger. Use only when read returns NO_GOAL and a human gave you a goal. Goal text 120 words max on one line, each criterion 40 words max on one line (no line terminators: CR, LF, VT, FF, U+0085, U+2028, U+2029); criteria become AC1.. and are never reworded. Rejected with SINGLE_KICKOFF while a goal is PLAN, EXECUTE, or BLOCKED. Then post a PROPOSE with decision_id plan.",
        inputSchema: {
            goal: z.string().describe("Goal text as one paragraph on one line; becomes the KICKOFF body. Must not contain CR, LF, VT, FF, U+0085, U+2028, or U+2029, or start with `- AC<n>: ` (SCHEMA)."),
            acceptance_criteria: z.array(z.string()).describe("Testable criteria in order, each on one line: no CR, LF, VT, FF, U+0085, U+2028, or U+2029 (SCHEMA)."),
            budgets: partialBudgetsSchema.optional().describe("Per-goal overrides of the diarchy.config.json budgets."),
            slug: z.string().optional().describe("[a-z0-9-]{1,40} for the goal id; default derived from the goal text."),
        },
    }, (args) => run(() => store.kickoff(args)));
    server.registerTool("post", {
        title: "Post a message",
        description: "Post a PROPOSE, CHALLENGE, STATUS, DONE, or BLOCKED to the shared chat. PROPOSE and CHALLENGE need a one-sentence claim; a CHALLENGE also needs reply_to the PROPOSE, its decision_id, and a test evidence item naming the cheapest check that settles it; one CHALLENGE per decision, ever. STATUS and DONE need evidence. BLOCKED needs kind and a body; kind external pages the human. DECIDE and ASSIGN go through the decide and assign tools; the store builds KICKOFF and ASK_HUMAN itself. Returns the message id, the phase, and the types you may post next.",
        inputSchema: {
            type: z.enum(MESSAGE_TYPES).describe("PROPOSE, CHALLENGE, STATUS, DONE, or BLOCKED."),
            to: z.string().default("all").describe("An agent id, or all."),
            re,
            body,
            claim: z.string().optional().describe("PROPOSE and CHALLENGE: exactly one falsifiable sentence, 40 words max."),
            evidence: evidence.optional().describe("STATUS, DONE, CHALLENGE: evidence items (PROTOCOL.md 3.1)."),
            reply_to: replyTo,
            decision_id: z.string().optional().describe("PROPOSE: plan (lead only) or omit for a new D<n>. CHALLENGE: the thread challenged."),
            kind: z.enum(BLOCKED_KINDS).optional().describe("BLOCKED only: external or internal."),
        },
    }, (args) => run(() => {
        const tool = DEDICATED_TOOL[args.type];
        if (tool !== undefined)
            return serverError("WRONG_TOOL", `${args.type} goes through the ${tool} tool, not post. Call ${tool} with the same fields.`);
        return store.post({ ...args, re: args.re ?? [] });
    }));
    server.registerTool("decide", {
        title: "Decide a thread",
        description: "Lead only: close an open thread (plan or D<n>) with a DECIDE. After a CHALLENGE you must do exactly one of: adopt it (basis adopted-challenge, reply_to the CHALLENGE, claim restates its position), reject it on evidence (basis test, evidence has a test with result pass or fail), or rule by authority (basis authority, body says why the test cannot run). Deciding plan with tasks moves the goal to EXECUTE. In EXECUTE every thread is decided, so pass supersedes instead of decision_id and cite new evidence (a failed test, a human message, or an external URL). Mandatory within 2 messages or 10 minutes of a CHALLENGE or the goal deadlocks.",
        inputSchema: {
            claim: z.string().describe("The ruling as one sentence, 40 words max."),
            re,
            basis: z.enum(DECISION_BASES).describe("test, adopted-challenge, or authority. human is reserved for the human."),
            decision_id: z.string().optional().describe("The open thread: plan or D<n>. Omit when supersedes is set."),
            supersedes: z.string().optional().describe("Decided thread to reopen; the store assigns the next D<n>."),
            reply_to: replyTo,
            tasks: z.array(z.string()).optional().describe("plan only: tasks, one line and 40 words max each, numbered T1.. in goal.md."),
            ac_add: z.array(z.string()).optional().describe("plan only: criteria appended as AC<n+1>.., 40 words each."),
            evidence: evidence.optional().describe("basis test: a test item with result pass or fail. supersedes: the new evidence."),
            body,
        },
    }, (args) => run(() => store.post({ ...args, type: "DECIDE", to: "all", re: args.re ?? [] })));
    server.registerTool("assign", {
        title: "Assign work",
        description: "Lead only, EXECUTE only: hand a task to an agent (the lead may assign itself). kind implement takes a task id or new_task plus worktree and branch, defaulted from diarchy.config.json when omitted. kind review takes the PR url, which must already appear as pr evidence in a STATUS, and may not target the PR's author (NO_SELF_REVIEW). An agent still owing a review cannot be assigned implementation (BUSY_REVIEWING). reason, if given, is availability, continuity, or load-balance; never route by model or by frontend/backend ownership. The assignee replies with status.",
        inputSchema: {
            to: z.string().describe("Assignee agent id."),
            task: z.string().optional().describe("Existing task id T<n>. Exactly one of task or new_task."),
            new_task: z.string().optional().describe("Text of a task not in goal.md yet, one line and 40 words max; the store numbers it."),
            kind: z.enum(ASSIGN_KINDS).describe("implement or review."),
            worktree: z.string().optional().describe("implement: default <worktrees.root>/<to>."),
            branch: z.string().optional().describe("implement: default <branch_prefix>/<goal-id>/<to>."),
            pr: z.string().optional().describe("review: the PR url."),
            reason: z.string().optional().describe("availability, continuity, or load-balance."),
            re,
            body,
        },
    }, (args) => run(() => {
        const draft = { ...args, type: "ASSIGN", re: args.re ?? [] };
        if (args.kind === "implement") {
            draft.worktree ??= posix.join(config.worktrees.root, args.to);
            const goal = store.activeGoal();
            if (draft.branch === undefined && goal !== null)
                draft.branch = `${config.worktrees.branch_prefix}/${goal.goalId}/${args.to}`;
        }
        return store.post(draft);
    }));
    server.registerTool("status", {
        title: "Report work",
        description: "Post a STATUS with evidence: the only message that counts as work. Use it when a commit lands, a PR opens, tests run, or a review is done; it resets the talk budget that otherwise blocks further discussion in EXECUTE. In EXECUTE a test item with result pass or fail sets the status of every AC in re (DONE needs every AC passing this way), so cite exactly the criteria the test covers. A review item is the only thing that counts as a review and must come from a non-author. Name task and task_status when the work belongs to a task.",
        inputSchema: {
            re,
            task: z.string().optional().describe("Task id T<n> this reports on."),
            task_status: z.enum(STATUS_TASK_STATUSES).optional().describe("in_progress or done; updates the task row in goal.md."),
            evidence: evidence.describe("At least one item: commit, pr, test, file, review, human, or external."),
            body,
        },
    }, (args) => run(() => store.post({ ...args, type: "STATUS", to: "all", re: args.re ?? [] })));
    server.registerTool("read", {
        title: "Read the chat",
        description: "Return the goal text (goal_text), every acceptance criterion with its text and status open, passing, or failing (acs), messages from the other agent, the human, and the system since your inbox cursor, plus phase, your role, the types you may post now, budgets, lead, and challenger. Plan against goal_text and acs. Call it first in every turn and after any rejection. Advances the cursor; pass since (a message id) to re-read from a point. Returns NO_GOAL when nothing was kicked off.",
        inputSchema: { since: z.string().optional().describe("Message id to read after; default: your inbox cursor.") },
    }, (args) => run(() => store.read(args) ?? serverError("NO_GOAL", NO_GOAL_TEXT)));
    server.registerTool("wait_for_reply", {
        title: "Wait for a reply",
        description: `Block until the other agent, the human, or the system posts, then return the same result as read. Use it instead of polling read. timeout_ms defaults to and is capped at ${MAX_WAIT_MS}; on expiry it returns { timeout: true } and you call it again (the goal may also have moved to BLOCKED by deadline, which arrives as a system ASK_HUMAN). Sends a progress notification every 15 s. A wait that is cancelled, or overtaken by your next call, also returns { timeout: true } and leaves your inbox cursor alone, so the reply arrives on that next call.`,
        inputSchema: { timeout_ms: z.number().int().positive().optional().describe(`Milliseconds to wait; default and cap ${MAX_WAIT_MS}.`) },
    }, (args, extra) => run(() => {
        const timeoutMs = Math.min(args.timeout_ms ?? MAX_WAIT_MS, MAX_WAIT_MS);
        const mine = new AbortController();
        waiting = mine;
        return store
            .waitForReply({
            timeoutMs,
            signal: AbortSignal.any([extra.signal, mine.signal]),
            onProgress: (progress) => void notifyProgress(server, extra, timeoutMs, progress).catch(logError),
        })
            .finally(() => {
            if (waiting === mine)
                waiting = null;
        });
    }));
    const view = (title, uri, file, description) => {
        server.registerResource(title, uri, { title, description, mimeType: "text/markdown" }, (url) => {
            const goal = currentGoal(store);
            const text = goal === null ? `${NO_GOAL_TEXT}\n` : readFileSync(goal.paths[file], "utf8");
            return { contents: [{ uri: url.href, mimeType: "text/markdown", text }] };
        });
    };
    view("goal.md", "diarchy://goal", "goalMd", "The current goal: text, status, acceptance criteria, tasks, and budget line, rendered by the store.");
    view("chat.md", "diarchy://chat", "chatMd", "The merged chat transcript of the current goal, rendered by the store.");
    return server;
}
/** PROTOCOL.md section 10: a progress notification every 15 s, plus an info log line for clients without progress support. */
async function notifyProgress(server, extra, timeoutMs, { elapsedMs, phase }) {
    const seconds = Math.round(elapsedMs / 1000);
    const total = timeoutMs / 1000;
    const message = `wait_for_reply: ${seconds} s of ${total} elapsed, phase ${phase}`;
    const progressToken = extra._meta?.progressToken;
    if (progressToken !== undefined) {
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: seconds, total, message } });
    }
    await server.server.sendLoggingMessage({ level: "info", logger: "diarchy", data: message }, extra.sessionId);
}
//# sourceMappingURL=server.js.map