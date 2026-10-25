/** `diarchy status [--json]`: phase, roles, budgets, open assignments, last message, and what the human must do. */
import { FIELD_MAX_CHARS, oneLine } from "../protocol/index.js";
import { budgetLine, sortMessages } from "../vault/render/shared.js";
import { blockSummary, openAssignments, replyHint } from "./brief.js";
import { EXIT_OK, currentGoal, headerLine, humanStore, printJson } from "./common.js";

export interface StatusOptions {
  json?: boolean;
}

export function runStatus(projectDir: string, options: StatusOptions): number {
  const store = humanStore(projectDir);
  const goal = currentGoal(store);
  const state = goal === null ? null : store.state();
  if (goal === null || state === null) {
    if (options.json === true) printJson({ goal: null, phase: null, human_needed: false, reply_command: null });
    else console.log("no goal in this vault");
    return EXIT_OK;
  }
  const messages = sortMessages(store.listMessages());
  const last = messages[messages.length - 1];
  const assignments = openAssignments(state);
  const hint = replyHint(state, messages);
  const humanNeeded = state.phase === "BLOCKED";
  if (options.json === true) {
    printJson({
      goal: goal.goalId,
      phase: state.phase,
      blocked_from: state.blocked_from,
      lead: state.lead,
      challenger: state.challenger,
      budgets: { used: state.used, limits: state.limits },
      deadlock_watch: state.deadlock_watch,
      assignments,
      message_count: messages.length,
      last_message: last === undefined ? null : { id: last.id, from: last.from, to: last.to, type: last.type, ts: last.ts, re: last.re },
      human_needed: humanNeeded,
      block: humanNeeded ? blockSummary(state, messages) : null,
      reply_command: hint,
      goal_md: goal.paths.goalMd,
    });
    return EXIT_OK;
  }
  const phase = state.phase === "BLOCKED" && state.blocked_from !== null ? `BLOCKED (from ${state.blocked_from})` : state.phase;
  console.log(`goal ${goal.goalId} · ${phase} · lead ${state.lead} · challenger ${state.challenger}`);
  console.log(`budget: ${budgetLine(state)}`);
  if (assignments.length === 0) console.log("open assignments: none");
  else {
    console.log("open assignments:");
    for (const item of assignments) {
      // Agent-authored strings pass through oneLine before they reach the human's terminal.
      const branch = item.branch === null ? "" : ` on ${oneLine(item.branch, FIELD_MAX_CHARS)}`;
      const where = item.kind === "review" ? `review of ${oneLine(item.pr ?? "?", FIELD_MAX_CHARS)}` : `${item.task} implement${branch}`;
      console.log(`  ${where} · ${item.assignee} · ${item.status}`);
    }
  }
  console.log(last === undefined ? "last: (no messages)" : `last: ${headerLine(last)}`);
  if (humanNeeded) {
    console.log(`human needed: ${blockSummary(state, messages)}`);
    console.log(`  run: ${hint ?? 'diarchy reply "<text>"'}`);
    console.log("  or:  diarchy stop");
  } else {
    console.log(`human: ${state.phase === "DONE" ? "goal is DONE" : "not needed"}`);
  }
  console.log(`goal.md ${goal.paths.goalMd}`);
  return EXIT_OK;
}
