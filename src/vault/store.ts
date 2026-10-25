/**
 * VaultStore: the file layer of docs/PROTOCOL.md section 2 and the store
 * duties behind the MCP tools (section 10). One instance posts as one agent.
 * Rules live in the protocol engine; this module owns locking, ids, files,
 * cursors, and rendering.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_HUMAN,
  AGENT_SYSTEM,
  BODY_MAX_WORDS,
  GOAL_ID_PATTERN,
  allowedTypes,
  assignId,
  checkMessageShape,
  evaluate,
  initialState,
  isoSeconds,
  parseGoalState,
  parseKickoffFile,
  parseMessageFile,
  parseMessageId,
  roleOf,
  serializeMessageFile,
  tick,
  wordCount,
  type AgentId,
  type DiarchyConfig,
  type GoalState,
  type Kickoff,
  type Message,
  type Phase,
  type Rejection,
  type RuleId,
  type Transition,
} from "../protocol/index.js";
import { resolveVaultPaths, vaultPaths, type GoalPaths } from "./config.js";
import { atomicWrite, readJson, sleep as realSleep } from "./files.js";
import { serializeKickoff, slugify, suffixSlug } from "./kickoff.js";
import { withDirLock } from "./lock.js";
import { renderChat } from "./render/chat.js";
import { renderDecisions } from "./render/decisions.js";
import { renderGoal } from "./render/goal.js";
import { lastOfType, type RenderOptions } from "./render/shared.js";
import { NoGoalError } from "./types.js";
import type {
  GoalRef,
  KickoffInput,
  KickoffResult,
  MessageDraft,
  PostOk,
  PostResult,
  ReadResult,
  ReplyOptions,
  VaultStoreOptions,
  WaitOptions,
  WaitResult,
} from "./types.js";

export { LOCK_STALE_MS } from "./lock.js";
export const MAX_WAIT_MS = 110_000;
export const PROGRESS_MS = 15_000;
export const DEFAULT_POLL_MS = 500;
const LOCK_RETRY_MS = 20;
const AC_MAX_WORDS = 40;
/** A directory touched this recently is re-scanned even if its mtime looks unchanged (coarse mtime clocks). */
const RECENT_MS = 2_000;
/** Under chat/: where crash recovery moves message files budget.json never recorded (PROTOCOL.md 2.2). */
const ORPHANS_DIR = ".orphans";
/** Under goals/: the vault lock that serializes kickoff (PROTOCOL.md 2). */
const VAULT_LOCK = ".lock";

interface Inbox {
  protocol_version: 1;
  agent: AgentId;
  cursor: string | null;
  updated: string;
}

interface Accepted {
  ok: true;
  message: Message;
  state: GoalState;
  transition: Transition;
}

const reject = (rule: RuleId, message: string): Rejection => ({ ok: false, rule, message });

/** Non-empty bodies end with exactly one newline, as in the PROTOCOL.md examples. */
function normalizeBody(body: string | undefined): string {
  const text = (body ?? "").replace(/\r\n/g, "\n").trimEnd();
  return text === "" ? "" : `${text}\n`;
}

// ---------------------------------------------------------------------------
// VaultStore
// ---------------------------------------------------------------------------

export class VaultStore {
  readonly agent: AgentId;
  private readonly projectDir: string;
  private readonly config: DiarchyConfig;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly renderOptions: RenderOptions;
  private readonly pollIntervalMs: number;
  /** Per goal directory: chat/ files the open transaction wrote since its last budget.json commit. */
  private readonly uncommitted = new Map<string, string[]>();
  /** budget.json files already reported as unreadable, so a poll loop warns once. */
  private readonly warned = new Set<string>();

  constructor(options: VaultStoreOptions) {
    this.agent = options.agent;
    this.projectDir = resolve(options.projectDir);
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? realSleep;
    this.renderOptions = options.localTz === undefined ? {} : { localTz: options.localTz };
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  /**
   * Every goal with a readable budget.json, oldest first. A goal whose
   * budget.json does not parse (damaged, or another protocol_version) is
   * skipped with one stderr warning naming the file, so it cannot take the
   * rest of the vault down with it (PROTOCOL.md 2.3).
   */
  listGoals(): GoalRef[] {
    const { goals } = vaultPaths(this.projectDir, this.config);
    if (!existsSync(goals)) return [];
    const refs: GoalRef[] = [];
    for (const name of readdirSync(goals).sort()) {
      const paths = resolveVaultPaths(this.projectDir, this.config, name);
      if (!existsSync(paths.budget)) continue;
      let state: GoalState;
      try {
        state = this.loadState(paths);
      } catch (error) {
        this.warnUnreadable(paths, error);
        continue;
      }
      refs.push({ goalId: name, phase: state.phase, lead: state.lead, challenger: state.challenger, created: state.created, paths });
    }
    return refs.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  }

  private warnUnreadable(paths: GoalPaths, error: unknown): void {
    if (this.warned.has(paths.budget)) return;
    this.warned.add(paths.budget);
    console.error(`diarchy: skipping goal ${paths.goalId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** The one goal in PLAN, EXECUTE, or BLOCKED, if any. */
  activeGoal(): GoalRef | null {
    const active = this.listGoals().filter((goal) => goal.phase !== "DONE");
    return active[active.length - 1] ?? null;
  }

  /** The active goal, else the newest (so `read` keeps working after DONE). */
  private currentGoal(): GoalRef | null {
    const goals = this.listGoals();
    return this.activeGoal() ?? goals[goals.length - 1] ?? null;
  }

  private requireGoal(): GoalRef {
    const goal = this.currentGoal();
    if (goal === null) throw new NoGoalError();
    return goal;
  }

  // -------------------------------------------------------------------------
  // Read-only helpers
  // -------------------------------------------------------------------------

  state(): GoalState | null {
    const goal = this.currentGoal();
    return goal === null ? null : this.loadState(goal.paths);
  }

  listMessages(): Message[] {
    const goal = this.currentGoal();
    return goal === null ? [] : this.readMessages(goal.paths, this.loadState(goal.paths));
  }

  readKickoff(): Kickoff | null {
    const goal = this.currentGoal();
    return goal === null ? null : this.loadKickoff(goal.paths);
  }

  /** Re-render goal.md, chat.md, decisions.md from the files on disk. */
  render(): void {
    const goal = this.requireGoal();
    this.renderFiles(goal.paths, this.loadKickoff(goal.paths), this.loadState(goal.paths));
  }

  // -------------------------------------------------------------------------
  // kickoff
  // -------------------------------------------------------------------------

  /**
   * Start a goal. The whole kickoff runs under the vault lock (goals/.lock), so
   * two PMs kicking off at once cannot both start a goal: the second sees the
   * first one active and gets SINGLE_KICKOFF.
   */
  async kickoff(input: KickoffInput): Promise<KickoffResult> {
    const active = this.activeGoal();
    if (active !== null) return singleKickoff(active.goalId, active.phase);
    const agents = Object.keys(this.config.agents);
    if (agents.length < 2) throw new Error("diarchy.config.json must declare at least two agents");
    const problem = this.kickoffProblem(input, agents);
    if (problem !== null) return problem;
    const { goals } = vaultPaths(this.projectDir, this.config);
    mkdirSync(goals, { recursive: true });
    return withDirLock(join(goals, VAULT_LOCK), LOCK_RETRY_MS, realSleep, () => this.kickoffLocked(input, agents));
  }

  private async kickoffLocked(input: KickoffInput, agents: AgentId[]): Promise<KickoffResult> {
    const active = this.activeGoal();
    if (active !== null) return singleKickoff(active.goalId, active.phase);
    const lead = input.lead ?? this.defaultLead(agents);
    if (agents.includes(this.agent) && lead !== this.agent) {
      return reject("ROLE_GATE", `KICKOFF may only be posted by the lead (${lead}). You are the challenger.`);
    }
    const now = this.now();
    const created = isoSeconds(now);
    const goalId = this.newGoalId(input, created);
    if (typeof goalId !== "string") return goalId;
    const paths = resolveVaultPaths(this.projectDir, this.config, goalId);

    const kickoff: Kickoff = {
      protocol_version: 1,
      goal: goalId,
      lead,
      challenger: agents.find((agent) => agent !== lead) ?? agents[0],
      agents,
      budgets: input.budgets ?? {},
      project: this.projectDir,
      vault: paths.vault,
      created,
      by: this.agent,
      goal_text: input.goal.trim(),
      acceptance_criteria: input.acceptance_criteria.map((criterion) => criterion.trim()),
    };
    mkdirSync(paths.chatDir, { recursive: true });
    mkdirSync(paths.inboxDir, { recursive: true });
    atomicWrite(paths.kickoff, serializeKickoff(kickoff), { durable: true });
    const state = initialState(kickoff, this.config, now);
    return this.withLock(paths, async () => {
      let committed = false;
      try {
        this.persist(paths, state);
        const draft: MessageDraft = { type: "KICKOFF", to: "all", re: Object.keys(state.acs), body: kickoff.goal_text };
        const outcome = await this.accept(paths, state, draft);
        if (!outcome.ok) return outcome;
        const final = await this.applyEffects(paths, outcome.transition);
        this.persist(paths, final);
        committed = true;
        this.renderFiles(paths, kickoff, final);
        return { ...this.postOk(outcome.message, final), goal_id: goalId, lead, challenger: kickoff.challenger, kickoff_id: outcome.message.id };
      } finally {
        // Until its KICKOFF commits, the goal is a placeholder: a rejection or a failure removes all of it.
        if (!committed) rmSync(paths.goal, { recursive: true, force: true });
      }
    });
  }

  private kickoffProblem(input: KickoffInput, agents: string[]): Rejection | null {
    const words = wordCount(input.goal);
    if (words === 0) return reject("SCHEMA", schemaText("goal", "required"));
    if (words > BODY_MAX_WORDS) {
      return reject("WORD_CAP", `Body is ${words} words; cut to ${BODY_MAX_WORDS} or fewer. Put detail in a file and cite it as \`file\` evidence.`);
    }
    if (input.acceptance_criteria.length === 0) return reject("SCHEMA", schemaText("acceptance_criteria", "at least one criterion"));
    for (const [index, criterion] of input.acceptance_criteria.entries()) {
      const count = wordCount(criterion);
      if (count === 0) return reject("SCHEMA", schemaText(`acceptance_criteria.${index}`, "required"));
      if (count > AC_MAX_WORDS) return reject("WORD_CAP", `AC${index + 1} is ${count} words; cut to ${AC_MAX_WORDS} or fewer.`);
    }
    if (input.lead !== undefined && !agents.includes(input.lead)) {
      return reject("SCHEMA", schemaText("lead", `must be one of ${agents.join(", ")}`));
    }
    return null;
  }

  /**
   * `<YYYYMMDD>-<slug>`, slug from `slug` or the goal text (a time-based
   * `goal-HHMMSS` when the text has no Latin letters or digits). Under the vault
   * lock no goal is active, so an id that is taken belongs to a finished or
   * abandoned goal: the slug gets the first free `-2`, `-3`, ... suffix instead.
   * An explicit `goal_id` is used as given or refused.
   */
  private newGoalId(input: KickoffInput, created: string): string | Rejection {
    if (input.goal_id !== undefined) {
      if (!GOAL_ID_PATTERN.test(input.goal_id)) return reject("SCHEMA", schemaText("goal_id", "must be <YYYYMMDD>-<slug> with slug [a-z0-9-]{1,40}"));
      if (this.goalIdTaken(input.goal_id)) return reject("SCHEMA", schemaText("goal_id", `${input.goal_id} already exists; pick another id`));
      return input.goal_id;
    }
    const day = created.slice(0, 10).replace(/-/g, "");
    const slug = input.slug ?? slugify(input.goal, `goal-${created.slice(11, 19).replace(/:/g, "")}`);
    if (!GOAL_ID_PATTERN.test(`${day}-${slug}`)) return reject("SCHEMA", schemaText("slug", "must be [a-z0-9-]{1,40}"));
    for (let n = 1; ; n += 1) {
      const goalId = `${day}-${n === 1 ? slug : suffixSlug(slug, n)}`;
      if (!this.goalIdTaken(goalId)) return goalId;
    }
  }

  /** kickoff never reuses a goal directory that holds a kickoff.md or a budget.json. */
  private goalIdTaken(goalId: string): boolean {
    const paths = resolveVaultPaths(this.projectDir, this.config, goalId);
    return existsSync(paths.kickoff) || existsSync(paths.budget);
  }

  /** A PM kicking off leads; the launcher alternates from the previous goal's lead. */
  private defaultLead(agents: string[]): AgentId {
    if (agents.includes(this.agent)) return this.agent;
    const goals = this.listGoals();
    const previous = goals[goals.length - 1];
    if (previous === undefined) return agents[0];
    return agents.find((agent) => agent !== previous.lead) ?? agents[0];
  }

  // -------------------------------------------------------------------------
  // post
  // -------------------------------------------------------------------------

  /** One transaction (PROTOCOL.md 2.2): lock, recover, tick, evaluate, write, effects, persist (the commit), render. */
  async post(draft: MessageDraft): Promise<PostResult> {
    const goal = this.requireGoal();
    return this.withLock(goal.paths, async () => {
      const kickoff = this.loadKickoff(goal.paths);
      const state = await this.tickLocked(goal.paths, kickoff, this.loadState(goal.paths));
      const outcome = await this.accept(goal.paths, state, draft);
      if (!outcome.ok) return outcome;
      const final = await this.applyEffects(goal.paths, outcome.transition);
      this.persist(goal.paths, final);
      this.renderFiles(goal.paths, kickoff, final);
      return this.postOk(outcome.message, final);
    });
  }

  /** Assign id, evaluate, and on acceptance write the message file. Call under the lock. */
  private async accept(paths: GoalPaths, state: GoalState, draft: MessageDraft): Promise<Accepted | Rejection> {
    const from = draft.from ?? this.agent;
    const assigned = assignId(state, from, draft.type, this.now());
    const message: Message = {
      ...draft,
      protocol_version: 1,
      id: assigned.id,
      goal: state.goal,
      from,
      phase: state.phase,
      ts: assigned.ts,
      body: normalizeBody(draft.body),
    };
    const now = new Date(Math.max(this.now().getTime(), Date.parse(assigned.ts)));
    const result = evaluate(message, assigned.state, { now, callerAgent: this.agent });
    if (!result.ok) return result;
    await this.waitUntil(result.message.ts);
    this.writeMessage(paths, result.message);
    return { ok: true, message: result.message, state: result.state, transition: result };
  }

  /** Write the system ASK_HUMAN for every `system_message` effect through the same path. */
  private async applyEffects(paths: GoalPaths, transition: Transition): Promise<GoalState> {
    let state = transition.state;
    for (const effect of transition.effects) {
      if (effect.kind !== "system_message") continue;
      const assigned = assignId(state, AGENT_SYSTEM, effect.type, this.now());
      const message: Message = {
        protocol_version: 1,
        id: assigned.id,
        goal: state.goal,
        from: AGENT_SYSTEM,
        to: effect.to,
        type: effect.type,
        re: [...effect.re],
        phase: assigned.state.phase,
        ts: assigned.ts,
        body: normalizeBody(effect.body),
      };
      if (effect.reply_to !== null) message.reply_to = effect.reply_to;
      if (effect.decision_id !== null) message.decision_id = effect.decision_id;
      const now = new Date(Math.max(this.now().getTime(), Date.parse(assigned.ts)));
      const result = evaluate(message, assigned.state, { now, callerAgent: AGENT_SYSTEM });
      if (!result.ok) throw new Error(`system ${effect.type} rejected: ${result.rule} ${result.message}`);
      await this.waitUntil(result.message.ts);
      this.writeMessage(paths, result.message);
      state = result.state;
    }
    return state;
  }

  /** Time-based transitions (DEADLOCK deadline, WALL_CLOCK) land before anything else. Call under the lock. */
  private async tickLocked(paths: GoalPaths, kickoff: Kickoff, state: GoalState): Promise<GoalState> {
    const transition = tick(state, this.now());
    if (transition === null) return state;
    const final = await this.applyEffects(paths, transition);
    this.persist(paths, final);
    this.renderFiles(paths, kickoff, final);
    return final;
  }

  private postOk(message: Message, state: GoalState): PostOk {
    const seq = parseMessageId(message.id)?.seq ?? 0;
    const ok: PostOk = {
      ok: true,
      id: message.id,
      ts: message.ts,
      seq,
      phase: state.phase,
      allowed_types: allowedTypes(state, this.agent),
      budgets: { used: state.used, limits: state.limits },
    };
    if (message.decision_id !== undefined) ok.decision_id = message.decision_id;
    return ok;
  }

  // -------------------------------------------------------------------------
  // read and wait_for_reply
  // -------------------------------------------------------------------------

  /** Messages after this agent's cursor, excluding its own; advances the cursor. */
  read(options: { since?: string } = {}): ReadResult | null {
    const goal = this.currentGoal();
    if (goal === null) return null;
    const state = this.loadState(goal.paths);
    const all = this.readMessages(goal.paths, state);
    const cursor = options.since ?? this.loadCursor(goal.paths);
    const messages = all.filter((message) => (cursor === null || message.id > cursor) && message.from !== this.agent);
    const last = all[all.length - 1];
    const next = last === undefined ? cursor : last.id;
    if (next !== this.loadCursor(goal.paths)) this.saveCursor(goal.paths, next);
    return {
      goal: goal.goalId,
      phase: state.phase,
      role: roleOf(state, this.agent),
      allowed_types: allowedTypes(state, this.agent),
      budgets: { used: state.used, limits: state.limits },
      lead: state.lead,
      challenger: state.challenger,
      messages,
      cursor: next,
    };
  }

  /**
   * Resolve as soon as `read()` has something, or `{ timeout: true }`. Polls the
   * chat directory every `pollIntervalMs` (fs.watch only wakes the poll early),
   * runs the engine tick on every poll, and reports progress every 15 s.
   */
  async waitForReply(options: WaitOptions = {}): Promise<WaitResult> {
    const goal = this.requireGoal();
    const timeout = Math.min(options.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
    const start = this.now().getTime();
    let nextProgress = start + PROGRESS_MS;
    let seenMtime = -1;
    let wake: (() => void) | null = null;
    const watcher = this.watchChat(goal.paths, () => wake?.());
    try {
      for (;;) {
        const ticked = await this.tickIfDue(goal);
        const mtime = this.chatMtime(goal.paths);
        const quiet = mtime === seenMtime && Date.now() - mtime > RECENT_MS;
        seenMtime = mtime;
        if (ticked || !quiet) {
          const result = this.read();
          if (result !== null && result.messages.length > 0) return result;
        }
        const elapsed = this.now().getTime() - start;
        if (elapsed >= timeout) return { timeout: true };
        if (this.now().getTime() >= nextProgress) {
          options.onProgress?.({ elapsedMs: elapsed, phase: this.loadState(goal.paths).phase });
          nextProgress += PROGRESS_MS;
        }
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, this.pollIntervalMs);
          wake = () => {
            clearTimeout(timer);
            resolveWait();
          };
        });
        wake = null;
      }
    } finally {
      watcher?.close();
    }
  }

  /** Apply a due tick under the lock; returns whether the phase moved. */
  private async tickIfDue(goal: GoalRef): Promise<boolean> {
    if (tick(this.loadState(goal.paths), this.now()) === null) return false;
    return this.withLock(goal.paths, async () => {
      const state = this.loadState(goal.paths);
      const after = await this.tickLocked(goal.paths, this.loadKickoff(goal.paths), state);
      return after !== state;
    });
  }

  private watchChat(paths: GoalPaths, onChange: () => void): FSWatcher | null {
    try {
      const watcher = watch(paths.chatDir, onChange);
      watcher.on("error", () => undefined);
      return watcher;
    } catch {
      return null;
    }
  }

  private chatMtime(paths: GoalPaths): number {
    try {
      return statSync(paths.chatDir).mtimeMs;
    } catch {
      return -1;
    }
  }

  // -------------------------------------------------------------------------
  // The human: diarchy reply, diarchy stop
  // -------------------------------------------------------------------------

  /**
   * DECIDE `basis: human` answering the latest ASK_HUMAN; `decision` names the
   * thread to close (an open thread by `decision_id`, a decided one by
   * `supersedes`). A ruling without terminal punctuation gets a period so
   * `diarchy reply "continue"` is one claim.
   */
  async reply(text: string, options: ReplyOptions = {}): Promise<PostResult> {
    this.requireHuman("reply");
    const goal = this.requireGoal();
    const state = this.loadState(goal.paths);
    const ask = lastOfType(this.readMessages(goal.paths, state), "ASK_HUMAN");
    const ruling = text.trim();
    const draft: MessageDraft = {
      type: "DECIDE",
      to: "all",
      re: ask?.re ?? Object.keys(state.acs),
      claim: /[.!?]$/.test(ruling) ? ruling : `${ruling}.`,
      basis: "human",
    };
    if (options.body !== undefined) draft.body = options.body;
    if (ask !== undefined) draft.reply_to = ask.id;
    if (options.budgets !== undefined) draft.budgets = options.budgets;
    if (options.decision !== undefined) {
      if (state.decisions[options.decision]?.status === "open") draft.decision_id = options.decision;
      else draft.supersedes = options.decision;
    }
    return this.post(draft);
  }

  /** Leave the goal BLOCKED with a human BLOCKED (external) message saying why. */
  async stop(reason: string): Promise<PostResult> {
    this.requireHuman("stop");
    const goal = this.requireGoal();
    if (wordCount(reason) === 0) return reject("SCHEMA", schemaText("body", "required"));
    return this.withLock(goal.paths, async () => {
      const kickoff = this.loadKickoff(goal.paths);
      const state = this.loadState(goal.paths);
      if (state.phase === "DONE") return reject("PHASE_GATE", "BLOCKED is not allowed in phase DONE. Allowed now: none.");
      const assigned = assignId(state, AGENT_HUMAN, "BLOCKED", this.now());
      const shape = checkMessageShape({
        protocol_version: 1,
        id: assigned.id,
        goal: state.goal,
        from: AGENT_HUMAN,
        to: "all",
        type: "BLOCKED",
        re: Object.keys(state.acs),
        kind: "external",
        phase: state.phase,
        ts: assigned.ts,
        body: normalizeBody(reason),
      });
      if (!shape.ok) return reject(shape.rule, shape.message);
      const message = shape.message;
      await this.waitUntil(message.ts);
      this.writeMessage(goal.paths, message);
      const next = structuredClone(assigned.state);
      if (next.phase !== "BLOCKED") {
        next.blocked_from = next.phase;
        next.phase = "BLOCKED";
      }
      next.messages.push({ id: message.id, from: message.from, type: message.type, decision_id: null, re: [...message.re] });
      next.used.wall_clock_minutes = Math.floor((Date.parse(message.ts) - Date.parse(next.created)) / 60_000);
      next.updated = message.ts;
      this.persist(goal.paths, next);
      this.renderFiles(goal.paths, kickoff, next);
      return this.postOk(message, next);
    });
  }

  private requireHuman(action: string): void {
    if (this.agent !== AGENT_HUMAN) throw new Error(`${action} is for the human; this store posts as "${this.agent}"`);
  }

  // -------------------------------------------------------------------------
  // Lock (PROTOCOL.md 2.2)
  // -------------------------------------------------------------------------

  /**
   * Writing budget.json commits a transaction (PROTOCOL.md 2.2). A throw removes
   * the chat/ files written since the last commit; a crash's leftovers are moved
   * aside by the next transaction before it reads anything.
   */
  private async withLock<T>(paths: GoalPaths, body: () => Promise<T>): Promise<T> {
    return withDirLock(paths.lock, LOCK_RETRY_MS, realSleep, async () => {
      const written: string[] = [];
      this.uncommitted.set(paths.goal, written);
      try {
        this.recoverOrphans(paths);
        return await body();
      } catch (error) {
        for (const path of written) rmSync(path, { force: true });
        throw error;
      } finally {
        this.uncommitted.delete(paths.goal);
      }
    });
  }

  /** Under the lock: a chat/ file whose id budget.json does not record never committed; move it to chat/.orphans/. */
  private recoverOrphans(paths: GoalPaths): void {
    if (!existsSync(paths.budget) || !existsSync(paths.chatDir)) return;
    const committed = committedIds(this.loadState(paths));
    const orphans = join(paths.chatDir, ORPHANS_DIR);
    for (const name of readdirSync(paths.chatDir)) {
      if (!name.endsWith(".md") || committed.has(name.slice(0, -3))) continue;
      mkdirSync(orphans, { recursive: true });
      let target = join(orphans, name);
      for (let n = 1; existsSync(target); n += 1) target = join(orphans, `${name.slice(0, -3)}.${n}.md`);
      renameSync(join(paths.chatDir, name), target);
    }
  }

  /** The store never writes a message whose ts is still in the future. */
  private async waitUntil(ts: string): Promise<void> {
    const ms = Date.parse(ts) - this.now().getTime();
    if (ms > 0) await this.sleep(ms);
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /** chat/ files are writer-owned and immutable: own agent or system only, never overwritten. */
  private writeMessage(paths: GoalPaths, message: Message): void {
    const parts = parseMessageId(message.id);
    if (parts === null || (parts.agent !== this.agent && parts.agent !== AGENT_SYSTEM)) {
      throw new Error(`WRITER_OWNED: this store posts as "${this.agent}" and cannot write ${message.id}`);
    }
    const path = join(paths.chatDir, `${message.id}.md`);
    if (existsSync(path)) throw new Error(`refusing to overwrite message file ${path}`);
    atomicWrite(path, serializeMessageFile(message), { durable: true });
    this.uncommitted.get(paths.goal)?.push(path);
  }

  /** The committed messages: chat/ files whose id `state` records, in (ts, seq) order. Nothing else is read or rendered. */
  private readMessages(paths: GoalPaths, state: GoalState): Message[] {
    if (!existsSync(paths.chatDir)) return [];
    const committed = committedIds(state);
    return readdirSync(paths.chatDir)
      .filter((name) => name.endsWith(".md") && committed.has(name.slice(0, -3)))
      .sort()
      .map((name) => parseMessageFile(readFileSync(join(paths.chatDir, name), "utf8")));
  }

  /** budget.json of one goal; a file that does not parse throws an error naming it. */
  private loadState(paths: GoalPaths): GoalState {
    try {
      return parseGoalState(readJson(paths.budget));
    } catch (error) {
      throw new Error(`${paths.budget} does not parse: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /** The commit point: every chat/ file written so far is now accepted. */
  private persist(paths: GoalPaths, state: GoalState): void {
    atomicWrite(paths.budget, `${JSON.stringify(state, null, 2)}\n`, { durable: true });
    this.uncommitted.get(paths.goal)?.splice(0);
  }

  private loadKickoff(paths: GoalPaths): Kickoff {
    return parseKickoffFile(readFileSync(paths.kickoff, "utf8"));
  }

  private loadCursor(paths: GoalPaths): string | null {
    const path = paths.inbox(this.agent);
    if (!existsSync(path)) return null;
    return (readJson(path) as Inbox).cursor;
  }

  private saveCursor(paths: GoalPaths, cursor: string | null): void {
    mkdirSync(paths.inboxDir, { recursive: true });
    const inbox: Inbox = { protocol_version: 1, agent: this.agent, cursor, updated: isoSeconds(this.now()) };
    atomicWrite(paths.inbox(this.agent), `${JSON.stringify(inbox, null, 2)}\n`);
  }

  private renderFiles(paths: GoalPaths, kickoff: Kickoff, state: GoalState): void {
    const messages = this.readMessages(paths, state);
    atomicWrite(paths.goalMd, renderGoal(messages, state, kickoff, this.renderOptions));
    atomicWrite(paths.chatMd, renderChat(messages, state, kickoff, this.renderOptions));
    atomicWrite(paths.decisionsMd, renderDecisions(messages, state, kickoff));
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function schemaText(field: string, problem: string): string {
  return `Field "${field}": ${problem}. Fix it per PROTOCOL.md section 3 and post again.`;
}

function committedIds(state: GoalState): Set<string> {
  return new Set(state.messages.map((ref) => ref.id));
}

function singleKickoff(goalId: string, phase: Phase): Rejection {
  return reject("SINGLE_KICKOFF", `Goal ${goalId} is already active (phase ${phase}). Call read instead of kickoff.`);
}
