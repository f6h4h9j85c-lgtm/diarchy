/** kickoff.md helpers: goal slugs and the file text (docs/PROTOCOL.md 2 and 2.3). */
import { Document, isMap, isSeq } from "yaml";

import type { Kickoff } from "../protocol/index.js";

/** `[a-z0-9-]{1,40}` from free text. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "goal" : slug;
}

/** kickoff.md text: frontmatter in PROTOCOL.md 2.3 order, goal text, then `- AC<n>: <criterion>` lines. */
export function serializeKickoff(kickoff: Kickoff): string {
  const doc = new Document({
    protocol_version: kickoff.protocol_version,
    goal: kickoff.goal,
    lead: kickoff.lead,
    challenger: kickoff.challenger,
    agents: kickoff.agents,
    budgets: kickoff.budgets,
    project: kickoff.project,
    vault: kickoff.vault,
    created: kickoff.created,
    by: kickoff.by,
  });
  const agents = doc.get("agents", true);
  if (isSeq(agents)) agents.flow = true;
  const budgets = doc.get("budgets", true);
  if (isMap(budgets)) budgets.flow = true;
  const yamlText = doc.toString({ lineWidth: 0, singleQuote: false, flowCollectionPadding: false });
  const acs = kickoff.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`);
  return `---\n${yamlText}---\n${kickoff.goal_text}\n\n${acs.join("\n")}\n`;
}
