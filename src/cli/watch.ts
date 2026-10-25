/** `diarchy watch`: print each message's header line as it lands; exit on DONE/BLOCKED unless --follow. */
import { sortMessages } from "../vault/render/shared.js";
import { CliError, EXIT_BLOCKED, EXIT_OK, currentGoal, headerLine, humanStore, noGoalText, sleep } from "./common.js";

export interface WatchOptions {
  follow?: boolean;
}

const POLL_MS = 1000;

export async function runWatch(projectDir: string, options: WatchOptions): Promise<number> {
  const store = humanStore(projectDir, 250);
  const seen = new Set<string>();
  let announced: string | null = null;
  for (;;) {
    const goal = currentGoal(store);
    if (goal === null) {
      if (options.follow !== true) throw new CliError(`${noGoalText(projectDir)}. Run diarchy start or diarchy kickoff first.`);
      await sleep(POLL_MS);
      continue;
    }
    if (announced !== goal.goalId) {
      if (announced !== null) seen.clear();
      announced = goal.goalId;
      console.log(`# ${goal.goalId} · lead ${goal.lead} · challenger ${goal.challenger}`);
    }
    for (const message of sortMessages(store.listMessages())) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      console.log(headerLine(message));
    }
    const state = store.state();
    if (state !== null && (state.phase === "DONE" || state.phase === "BLOCKED") && options.follow !== true) {
      console.log(`# ${state.phase}`);
      return state.phase === "DONE" ? EXIT_OK : EXIT_BLOCKED;
    }
    try {
      await store.waitForReply({ timeoutMs: POLL_MS });
    } catch {
      await sleep(POLL_MS);
    }
  }
}
