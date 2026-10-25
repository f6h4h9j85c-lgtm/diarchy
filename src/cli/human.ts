/** `diarchy reply` and `diarchy stop`: the two things the human does to a running goal. */
import { NoGoalError, type ReplyOptions } from "../vault/index.js";
import { EXIT_ERROR, EXIT_OK, humanStore, parseBudgets, printJson } from "./common.js";
import { runningSupervisor } from "./start.js";

export interface ReplyCliOptions {
  decision?: string;
  budget: string[];
  body?: string;
  json?: boolean;
}

export async function runReply(projectDir: string, text: string, options: ReplyCliOptions): Promise<number> {
  const store = humanStore(projectDir);
  const reply: ReplyOptions = {};
  if (options.decision !== undefined) reply.decision = options.decision;
  if (options.body !== undefined) reply.body = options.body;
  if (options.budget.length > 0) reply.budgets = parseBudgets(options.budget);
  const result = await store.reply(text, reply);
  if (options.json === true) {
    printJson(result);
    return result.ok ? EXIT_OK : EXIT_ERROR;
  }
  if (!result.ok) {
    console.error(`diarchy: reply rejected ${result.rule}: ${result.message}`);
    return EXIT_ERROR;
  }
  const decision = result.decision_id === undefined ? "" : ` · ${result.decision_id}`;
  console.log(`posted ${result.id}${decision} · phase ${result.phase}`);
  return EXIT_OK;
}

export interface StopCliOptions {
  reason?: string;
  json?: boolean;
}

const DEFAULT_REASON = "Stopped by the human with diarchy stop.";

export async function runStop(projectDir: string, options: StopCliOptions): Promise<number> {
  const store = humanStore(projectDir);
  let stopped: { ok: boolean; detail: string } = { ok: false, detail: "no goal in this vault" };
  try {
    const result = await store.stop(options.reason ?? DEFAULT_REASON);
    stopped = result.ok
      ? { ok: true, detail: `posted ${result.id} · phase ${result.phase}` }
      : { ok: false, detail: `rejected ${result.rule}: ${result.message}` };
  } catch (error) {
    if (!(error instanceof NoGoalError)) throw error;
  }
  const pid = runningSupervisor(projectDir);
  let signalled = false;
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
      signalled = true;
    } catch {
      signalled = false;
    }
  }
  if (options.json === true) {
    printJson({ stopped: stopped.ok, detail: stopped.detail, supervisor_pid: pid, signalled });
  } else {
    console.log(stopped.ok ? `goal BLOCKED: ${stopped.detail}` : `goal not changed: ${stopped.detail}`);
    console.log(pid === null ? "no diarchy start is running" : signalled ? `signalled diarchy start (pid ${pid})` : `could not signal pid ${pid}`);
  }
  return stopped.ok || signalled ? EXIT_OK : EXIT_ERROR;
}
