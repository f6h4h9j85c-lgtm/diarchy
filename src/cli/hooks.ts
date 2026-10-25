/**
 * The two hook-facing commands. Both never throw, always exit 0, and read the
 * agent's inbox cursor without moving it.
 *
 * `inbox-skim --agent <id>` (SessionStart): a brief of at most 15 lines, or
 * nothing when no goal is active.
 *
 * `gate --agent <id>` (Stop): `{"decision":"block","reason":"..."}` while the
 * agent owes the goal something in PLAN/EXECUTE, else nothing. After
 * GATE_CAP consecutive blocks with no new message (tracked in
 * `.diarchy/gate-<agent>.json`) it stops blocking so a stuck agent can end its turn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { roleOf } from "../protocol/index.js";
import { budgetLine } from "../vault/render/shared.js";
import { nextStep, openAssignments, unreadFor } from "./brief.js";
import { headerLine, humanStore } from "./common.js";

export const GATE_CAP = 12;
const SKIM_MAX_LINES = 15;
const SKIM_MAX_HEADERS = 8;

export function runInboxSkim(projectDir: string, agent: string): string[] {
  const store = humanStore(projectDir);
  const goal = store.activeGoal();
  if (goal === null) return [];
  const state = store.state();
  if (state === null || state.goal !== goal.goalId) return [];
  const messages = store.listMessages();
  const unread = unreadFor(goal, messages, agent);
  const lines: string[] = [];
  lines.push(`diarchy goal ${goal.goalId} · phase ${state.phase} · you are ${agent} (${roleOf(state, agent)})`);
  lines.push(`budget: ${budgetLine(state)}`);
  const owed = openAssignments(state, agent);
  if (owed.length > 0) {
    const items = owed.map((item) => (item.kind === "review" ? `review of ${item.pr ?? "?"}` : `${item.task} implement`));
    lines.push(`your open assignments: ${items.join(", ")}`);
  }
  lines.push(`unread: ${unread.length} message${unread.length === 1 ? "" : "s"}`);
  const shown = unread.slice(-SKIM_MAX_HEADERS);
  if (unread.length > shown.length) lines.push(`  (${unread.length - shown.length} older not shown)`);
  for (const message of shown) lines.push(`  ${headerLine(message)}`);
  lines.push(`next: ${nextStep(state, messages, agent, unread).text}`);
  return lines.slice(0, SKIM_MAX_LINES);
}

interface GateRecord {
  blocks: number;
  last_message_id: string | null;
  updated: string;
}

export function gateRecordPath(projectDir: string, agent: string): string {
  return join(projectDir, ".diarchy", `gate-${agent}.json`);
}

function loadGateRecord(path: string): GateRecord {
  const empty: GateRecord = { blocks: 0, last_message_id: null, updated: "" };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GateRecord>;
    return {
      blocks: typeof raw.blocks === "number" && Number.isFinite(raw.blocks) ? raw.blocks : 0,
      last_message_id: typeof raw.last_message_id === "string" ? raw.last_message_id : null,
      updated: typeof raw.updated === "string" ? raw.updated : "",
    };
  } catch {
    return empty;
  }
}

function saveGateRecord(path: string, record: GateRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export interface GateDecision {
  decision: "block";
  reason: string;
}

/** The block decision, or null to let the turn end. The hook JSON on stdin is drained by the caller and not needed. */
export function runGate(projectDir: string, agent: string): GateDecision | null {
  const store = humanStore(projectDir);
  const goal = store.activeGoal();
  if (goal === null || (goal.phase !== "PLAN" && goal.phase !== "EXECUTE")) return null;
  const state = store.state();
  if (state === null || state.goal !== goal.goalId) return null;
  const messages = store.listMessages();
  const unread = unreadFor(goal, messages, agent);
  const step = nextStep(state, messages, agent, unread);
  const path = gateRecordPath(projectDir, agent);
  const lastId = messages.length === 0 ? null : messages[messages.length - 1].id;
  let record = loadGateRecord(path);
  if (record.last_message_id !== lastId) record = { blocks: 0, last_message_id: lastId, updated: "" };
  if (!step.owes) {
    if (record.blocks !== 0) saveGateRecord(path, { ...record, blocks: 0, updated: new Date().toISOString() });
    return null;
  }
  if (record.blocks >= GATE_CAP) return null;
  saveGateRecord(path, { blocks: record.blocks + 1, last_message_id: lastId, updated: new Date().toISOString() });
  return { decision: "block", reason: `diarchy goal ${goal.goalId} (${state.phase}): ${step.text}.` };
}
