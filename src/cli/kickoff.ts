/** `diarchy kickoff`: the human starts a goal through the store. `start` reuses the option parsing. */
import type { KickoffInput } from "../vault/index.js";
import { CliError, EXIT_ERROR, EXIT_OK, humanStore, parseBudgets, printJson, requireConfig } from "./common.js";

export interface KickoffCliOptions {
  ac: string[];
  lead?: string;
  budget: string[];
  slug?: string;
  json?: boolean;
}

/** Validate the positional goal plus flags into the store's KickoffInput. */
export function kickoffInput(goal: string | undefined, options: KickoffCliOptions): KickoffInput {
  if (goal === undefined || goal.trim() === "") throw new CliError('a goal is required: diarchy kickoff "<goal>" --ac "<criterion>"');
  if (options.ac.length === 0) throw new CliError("at least one --ac <criterion> is required");
  const input: KickoffInput = { goal: goal.trim(), acceptance_criteria: options.ac.map((criterion) => criterion.trim()) };
  if (options.lead !== undefined) input.lead = options.lead;
  if (options.slug !== undefined) input.slug = options.slug;
  if (options.budget.length > 0) input.budgets = parseBudgets(options.budget);
  return input;
}

export async function runKickoff(projectDir: string, goal: string | undefined, options: KickoffCliOptions): Promise<number> {
  requireConfig(projectDir);
  const input = kickoffInput(goal, options);
  const store = humanStore(projectDir);
  const result = await store.kickoff(input);
  if (!result.ok) {
    if (options.json === true) printJson(result);
    else console.error(`diarchy: kickoff rejected ${result.rule}: ${result.message}`);
    return EXIT_ERROR;
  }
  const ref = store.activeGoal();
  const goalMd = ref?.paths.goalMd ?? "";
  if (options.json === true) {
    printJson({ ...result, goal_md: goalMd });
  } else {
    console.log(`goal ${result.goal_id} · lead ${result.lead} · challenger ${result.challenger}`);
    console.log(`goal.md ${goalMd}`);
  }
  return EXIT_OK;
}
