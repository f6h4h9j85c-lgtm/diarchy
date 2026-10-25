/** kickoff.md helpers: goal slugs and the file text (docs/PROTOCOL.md 2 and 2.3). */
import { Document, isMap, isSeq } from "yaml";
const SLUG_MAX = 40;
/**
 * `[a-z0-9-]{1,40}` from free text. Accents are dropped (`Café` gives `cafe`);
 * text with no Latin letters or digits at all gives `fallback`.
 */
export function slugify(text, fallback = "goal") {
    const slug = text
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SLUG_MAX)
        .replace(/-+$/, "");
    return slug === "" ? fallback : slug;
}
/** `<slug>-<n>`, cutting the slug so the result stays within 40 characters. */
export function suffixSlug(slug, n) {
    const suffix = `-${n}`;
    return `${slug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
}
/** kickoff.md text: frontmatter in PROTOCOL.md 2.3 order, goal text, then `- AC<n>: <criterion>` lines. */
export function serializeKickoff(kickoff) {
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
    if (isSeq(agents))
        agents.flow = true;
    const budgets = doc.get("budgets", true);
    if (isMap(budgets))
        budgets.flow = true;
    const yamlText = doc.toString({ lineWidth: 0, singleQuote: false, flowCollectionPadding: false });
    const acs = kickoff.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`);
    return `---\n${yamlText}---\n${kickoff.goal_text}\n\n${acs.join("\n")}\n`;
}
//# sourceMappingURL=kickoff.js.map