/**
 * diarchy-mcp: the MCP tool layer of docs/PROTOCOL.md section 10 over one
 * VaultStore. One server posts as one agent, and only one live server per
 * agent acts on a goal: the others answer AGENT_BUSY. Every tool answers with the
 * store's result as JSON text plus structuredContent; a protocol rejection
 * (docs/ANTI-SLOP.md `{ ok: false, rule, message }`) sets isError so the
 * calling agent reads the rule and does what the message says. Arguments that
 * do not fit a tool's input schema are such a rejection too (SCHEMA): the
 * server checks them itself instead of leaving it to the SDK.
 */
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { VERSION } from "../index.js";
import {
  ASSIGN_KINDS,
  BLOCKED_KINDS,
  DECISION_BASES,
  MESSAGE_TYPES,
  STATUS_TASK_STATUSES,
  SchemaError,
  describeIssue,
  evidenceItemSchema,
  isMessageType,
  partialBudgetsSchema,
  schemaMessage,
  typedOnlyMessage,
  type AgentId,
  type MessageType,
  type Rejection,
} from "../protocol/index.js";
import {
  AgentLease,
  CorruptVaultFileError,
  MAX_WAIT_MS,
  NoGoalError,
  VaultStore,
  loadConfig,
  type GoalRef,
  type LockOwner,
  type MessageDraft,
  type WaitProgress,
} from "../vault/index.js";

export interface McpServerOptions {
  projectDir: string;
  agent: AgentId;
  /** Defaults to a VaultStore on `projectDir` for `agent`; tests inject one with a fake clock. */
  store?: VaultStore;
  now?: () => Date;
}

/** Error codes the server adds to the protocol's RuleId set (PROTOCOL.md section 10). */
export const SERVER_ERRORS = ["NO_GOAL", "WRONG_TOOL", "AGENT_BUSY", "INTERNAL"] as const;
export type ServerErrorCode = (typeof SERVER_ERRORS)[number];

export interface ServerError {
  ok: false;
  rule: ServerErrorCode;
  message: string;
}

export type ToolError = Rejection | ServerError;

export const TOOL_NAMES = ["kickoff", "post", "read", "wait_for_reply", "decide", "assign", "status"] as const;

/** Message types `post` refuses because a dedicated tool builds them. */
const DEDICATED_TOOL: Partial<Record<MessageType, string>> = { KICKOFF: "kickoff", DECIDE: "decide", ASSIGN: "assign" };

const NO_GOAL_TEXT = new NoGoalError().message;

const INSTRUCTIONS = [
  "diarchy coordinates two PM agents (lead and challenger) on one goal through a shared vault.",
  "Loop: read, then at most one of post, decide, assign, status, then wait_for_reply; repeat until phase DONE or BLOCKED.",
  "Every message cites acceptance criteria in re. A rejection returns { ok: false, rule, message }: do what message says; never retry unchanged.",
].join(" ");

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const serverError = (rule: ServerErrorCode, message: string): ServerError => ({ ok: false, rule, message });

function toolResult(result: object): CallToolResult {
  const out: CallToolResult = { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
  if ("ok" in result && result.ok === false) out.isError = true;
  return out;
}

function logError(error: unknown): void {
  console.error(`diarchy-mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

/**
 * A stored vault file will not parse: say so, and send the PM to the human
 * instead of a retry. Nothing can post to a goal whose budget.json will not
 * parse, so that one goes to the human outside the vault.
 */
function corruptFileText(error: CorruptVaultFileError): string {
  if (basename(error.file) === "budget.json") {
    return `${error.message} The vault is damaged, not your draft, so do not retry. No tool can reach that goal until the human repairs the file or moves its goal directory out of the vault: stop and tell the human, naming the file.`;
  }
  return `${error.message} The vault is damaged, not your draft, so do not retry. Post BLOCKED with kind external naming that file so the human can fix it or run diarchy stop.`;
}

/**
 * Run a tool body; NoGoalError becomes NO_GOAL, a CorruptVaultFileError (a
 * vault file that will not parse) keeps its rule (SCHEMA, or TYPED_ONLY for an
 * unknown message type) with a message naming the file, anything else
 * INTERNAL. The server never crashes on a bad input.
 */
async function runTool(body: () => Promise<object> | object): Promise<CallToolResult> {
  try {
    return toolResult(await body());
  } catch (error) {
    if (error instanceof NoGoalError) return toolResult(serverError("NO_GOAL", NO_GOAL_TEXT));
    logError(error);
    if (error instanceof CorruptVaultFileError) return toolResult({ ok: false, rule: error.rule, message: corruptFileText(error) } satisfies Rejection);
    if (error instanceof SchemaError) return toolResult({ ok: false, rule: error.rule, message: error.message } satisfies Rejection);
    return toolResult(serverError("INTERNAL", error instanceof Error ? error.message : String(error)));
  }
}

type InputShape = Record<string, z.ZodType>;

/**
 * The input schema a tool registers with the SDK: every declared field as an
 * optional z.unknown(), carrying the declared object's JSON Schema as metadata.
 * tools/list advertises exactly the declared schema, but the SDK's own input
 * check, which answers a mismatch with a plain-text -32602 error and no rule,
 * always passes, and the handler parses the declared shape itself.
 */
function advertisedSchema(shape: InputShape) {
  const json = z.toJSONSchema(z.object(shape), { target: "draft-7", io: "input" });
  delete json.$schema;
  return z.object(Object.fromEntries(Object.keys(shape).map((key) => [key, z.unknown().optional()]))).meta(json);
}

/**
 * Arguments that do not fit the declared shape: ANTI-SLOP.md SCHEMA naming the
 * first bad field, or TYPED_ONLY for a post whose type is not a message type,
 * as the engine answers the same message.
 */
function inputRejection(error: z.ZodError, args: Record<string, unknown>): Rejection {
  const { field, problem } = describeIssue(error.issues[0], args);
  if (field === "type" && args.type !== undefined && !isMessageType(args.type)) return { ok: false, rule: "TYPED_ONLY", message: typedOnlyMessage(args.type) };
  return { ok: false, rule: "SCHEMA", message: schemaMessage(field, problem) };
}

/** The active goal, else the newest, as the store's own read path does. */
function currentGoal(store: VaultStore): GoalRef | null {
  return store.activeGoal() ?? store.listGoals().at(-1) ?? null;
}

function agentBusyText(agent: AgentId, holder: LockOwner): string {
  return `Another diarchy server already acts as ${agent} on this goal (pid ${holder.pid}). One session per agent: end that session, or stop here; once it exits, the next call as ${agent} takes over.`;
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

export function createMcpServer(options: McpServerOptions): McpServer {
  const { projectDir, agent } = options;
  const config = loadConfig(projectDir);
  const store = options.store ?? new VaultStore({ projectDir, config, agent, ...(options.now === undefined ? {} : { now: options.now }) });
  const server = new McpServer({ name: "diarchy", version: VERSION }, { capabilities: { logging: {} }, instructions: INSTRUCTIONS });

  /** The wait_for_reply this server has in flight, if any: one agent, one wait. */
  let waiting: AbortController | null = null;
  /**
   * Every tool call ends an earlier wait before it runs. The agent is
   * sequential, so a new call means nobody reads that wait's result any more
   * (its client timed out without sending notifications/cancelled); left
   * running it would consume the reply and move the cursor past it.
   */
  const run = (body: () => Promise<object> | object): Promise<CallToolResult> => {
    waiting?.abort();
    waiting = null;
    return runTool(body);
  };

  const lease = new AgentLease(agent);
  server.server.onclose = () => lease.release();

  /** AGENT_BUSY while another live server acts as this agent on the current goal; claims the goal otherwise. */
  const busy = (): ServerError | null => {
    const goal = currentGoal(store);
    const holder = goal === null ? null : lease.claim(goal.paths);
    return holder === null ? null : serverError("AGENT_BUSY", agentBusyText(agent, holder));
  };
  /** Run a tool body as this agent: refused with AGENT_BUSY unless this server holds the goal. */
  const asAgent = (body: () => Promise<object> | object): Promise<CallToolResult> => run(() => busy() ?? body());

  /** Register a tool whose arguments this server parses, so a malformed one is a rejection with a rule like any other. */
  const register = <S extends InputShape>(
    name: (typeof TOOL_NAMES)[number],
    config: { title: string; description: string; inputSchema: S },
    handler: (args: z.output<z.ZodObject<S>>, extra: Extra) => Promise<CallToolResult>,
  ): void => {
    const declared = z.object(config.inputSchema);
    server.registerTool(name, { ...config, inputSchema: advertisedSchema(config.inputSchema) }, (args, extra) => {
      const parsed = declared.safeParse(args);
      return parsed.success ? handler(parsed.data, extra) : run(() => inputRejection(parsed.error, args));
    });
  };

  register(
    "kickoff",
    {
      title: "Kick off a goal",
      description:
        "Start a goal; you become lead and the other agent challenger. Use when read returns NO_GOAL or a goal in phase DONE, and a human gave you a goal. Goal text 120 words max on one line, each criterion 40 words max on one line (no line terminators: CR, LF, VT, FF, U+0085, U+2028, U+2029); criteria become AC1.. and are never reworded. Rejected with SINGLE_KICKOFF while a goal is PLAN, EXECUTE, or BLOCKED. Then post a PROPOSE with decision_id plan.",
      inputSchema: {
        goal: z.string().describe("Goal text as one paragraph on one line; becomes the KICKOFF body. Must not contain CR, LF, VT, FF, U+0085, U+2028, or U+2029, or start with `- AC<n>: ` (SCHEMA)."),
        acceptance_criteria: z.array(z.string()).describe("Testable criteria in order, each on one line: no CR, LF, VT, FF, U+0085, U+2028, or U+2029 (SCHEMA)."),
        budgets: partialBudgetsSchema.optional().describe("Per-goal overrides of the diarchy.config.json budgets."),
        slug: z.string().optional().describe("[a-z0-9-]{1,40} for the goal id; default derived from the goal text."),
      },
    },
    // kickoff is serialized by the vault lock; the new goal is claimed for this server right away.
    (args) =>
      run(async () => {
        const result = await store.kickoff(args);
        if (result.ok) busy();
        return result;
      }),
  );

  register(
    "post",
    {
      title: "Post a message",
      description:
        "Post a PROPOSE, CHALLENGE, STATUS, DONE, or BLOCKED to the shared chat. PROPOSE and CHALLENGE need a one-sentence claim; a CHALLENGE also needs reply_to the PROPOSE, its decision_id, and a test evidence item naming the cheapest check that settles it; one CHALLENGE per decision, ever. STATUS and DONE need evidence. BLOCKED needs kind and a body; kind external pages the human. DECIDE and ASSIGN go through the decide and assign tools; the store builds KICKOFF and ASK_HUMAN itself. Returns the message id, the phase, and the types you may post next.",
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
    },
    (args) =>
      asAgent(() => {
        const tool = DEDICATED_TOOL[args.type];
        if (tool !== undefined) return serverError("WRONG_TOOL", `${args.type} goes through the ${tool} tool, not post. Call ${tool} with the same fields.`);
        return store.post({ ...args, re: args.re ?? [] });
      }),
  );

  register(
    "decide",
    {
      title: "Decide a thread",
      description:
        "Lead only: close an open thread (plan or D<n>) with a DECIDE. After a CHALLENGE you must do exactly one of: adopt it (basis adopted-challenge, reply_to the CHALLENGE, claim restates its position), reject it on evidence (basis test, evidence has a test with result pass or fail), or rule by authority (basis authority, body says why the test cannot run). Deciding plan with tasks moves the goal to EXECUTE. In EXECUTE every thread is decided, so pass supersedes instead of decision_id and cite new evidence (a failed test, a human message, or an external URL). Mandatory within 2 messages or 10 minutes of a CHALLENGE or the goal deadlocks.",
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
    },
    (args) => asAgent(() => store.post({ ...args, type: "DECIDE", to: "all", re: args.re ?? [] })),
  );

  register(
    "assign",
    {
      title: "Assign work",
      description:
        "Lead only, EXECUTE only: hand a task to an agent (the lead may assign itself). kind implement takes a task id or new_task; omit worktree and branch so they come from diarchy.config.json. kind review takes the PR url, which must already appear as pr evidence in a STATUS, plus new_task \"Review <pr url>\" (never the implement task's id), and may not target the PR's author (NO_SELF_REVIEW). An agent still owing a review cannot be assigned implementation (BUSY_REVIEWING). reason, if given, is availability, continuity, or load-balance; never route by model or by frontend/backend ownership. The assignee replies with status.",
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
    },
    (args) =>
      asAgent(() => {
        const draft: MessageDraft = { ...args, type: "ASSIGN", re: args.re ?? [] };
        if (args.kind === "implement") {
          draft.worktree ??= posix.join(config.worktrees.root, args.to);
          // The newest goal even after DONE, so a late ASSIGN reaches the engine whole and gets PHASE_GATE, not a SCHEMA about branch.
          const goal = currentGoal(store);
          if (draft.branch === undefined && goal !== null) draft.branch = `${config.worktrees.branch_prefix}/${goal.goalId}/${args.to}`;
        }
        return store.post(draft);
      }),
  );

  register(
    "status",
    {
      title: "Report work",
      description:
        "Post a STATUS with evidence: the only message that counts as work. Use it when a commit lands, a PR opens, tests run, or a review is done; with a commit, pr, review, or a passing or failing test it resets the talk budget that otherwise blocks further discussion in EXECUTE (a pending test, file, or link alone does not). In EXECUTE a test item with result pass or fail sets the status of every AC in re (DONE needs every AC passing this way), except that beside a request_changes review only fail items count, so cite exactly the criteria the test covers. A review item is the only thing that counts as a review and must come from a non-author. Name task and task_status when the work belongs to a task; a review task closes with your review evidence, not with task_status done.",
      inputSchema: {
        re,
        task: z.string().optional().describe("Task id T<n> this reports on."),
        task_status: z.enum(STATUS_TASK_STATUSES).optional().describe("in_progress or done; updates the task row in goal.md."),
        evidence: evidence.describe("At least one item: commit, pr, test, file, review, human, or external."),
        body,
      },
    },
    (args) => asAgent(() => store.post({ ...args, type: "STATUS", to: "all", re: args.re ?? [] })),
  );

  register(
    "read",
    {
      title: "Read the chat",
      description:
        "Return the goal text (goal_text), every acceptance criterion with its text and status open, passing, or failing (acs), messages from the other agent, the human, and the system since your inbox cursor, plus phase, your role, the types you may post now, budgets, lead, and challenger. Plan against goal_text and acs. Call it first in every turn and after any rejection. Advances the cursor; pass since (a message id) to re-read from a point. Returns NO_GOAL when nothing was kicked off.",
      inputSchema: { since: z.string().optional().describe("Message id to read after; default: your inbox cursor.") },
    },
    (args) => asAgent(() => store.read(args) ?? serverError("NO_GOAL", NO_GOAL_TEXT)),
  );

  register(
    "wait_for_reply",
    {
      title: "Wait for a reply",
      description:
        `Block until the other agent, the human, or the system posts, then return the same result as read. Use it instead of polling read. timeout_ms defaults to and is capped at ${MAX_WAIT_MS}; on expiry it returns { timeout: true } and you call it again (the goal may also have moved to BLOCKED by deadline, which arrives as a system ASK_HUMAN). Sends a progress notification every 15 s. A wait that is cancelled, or overtaken by your next call, also returns { timeout: true } and leaves your inbox cursor alone, so the reply arrives on that next call.`,
      inputSchema: { timeout_ms: z.number().int().positive().optional().describe(`Milliseconds to wait; default and cap ${MAX_WAIT_MS}.`) },
    },
    (args, extra) =>
      asAgent(() => {
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
            if (waiting === mine) waiting = null;
          });
      }),
  );

  const view = (title: string, uri: string, file: "goalMd" | "chatMd", description: string): void => {
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
async function notifyProgress(server: McpServer, extra: Extra, timeoutMs: number, { elapsedMs, phase }: WaitProgress): Promise<void> {
  const seconds = Math.round(elapsedMs / 1000);
  const total = timeoutMs / 1000;
  const message = `wait_for_reply: ${seconds} s of ${total} elapsed, phase ${phase}`;
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: seconds, total, message } });
  }
  await server.server.sendLoggingMessage({ level: "info", logger: "diarchy", data: message }, extra.sessionId);
}
