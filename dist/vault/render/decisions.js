import { GENERATED, SEP, byId, cell, evidenceSummary, hms, sortMessages, tableRow, tableSeparator, utcDate, } from "./shared.js";
const COLUMNS = ["id", "ts", "by", "claim", "basis", "evidence", "supersedes"];
/** decisions.md carries no budget or local-time hint, so it needs neither state nor options. */
export function renderDecisions(messages, _state, kickoff) {
    const ordered = sortMessages(messages);
    const ids = byId(ordered);
    const decides = ordered.filter((message) => message.type === "DECIDE");
    const superseded = new Set(decides.map((message) => message.supersedes).filter((id) => id !== undefined));
    const date = utcDate(decides[0]?.ts ?? kickoff.created);
    const summary = `${date} UTC${SEP}${decides.length} decisions, ${superseded.size} superseded${SEP}[goal](goal.md)${SEP}[chat](chat.md)`;
    const rows = decides.map((message) => {
        const id = message.decision_id ?? "";
        const time = utcDate(message.ts) === date ? hms(message.ts) : `${utcDate(message.ts)} ${hms(message.ts)}`;
        return tableRow([
            superseded.has(id) ? `~~${id}~~` : id,
            `[${time}](chat/${message.id}.md)`,
            message.from,
            cell(message.claim ?? ""),
            message.basis ?? "",
            (message.evidence ?? []).map((item) => evidenceSummary(item, ids)).join("; "),
            message.supersedes ?? "",
        ]);
    });
    const table = [tableRow(COLUMNS), tableSeparator(COLUMNS.length), ...rows].join("\n");
    return `${[`${GENERATED}\n# Decisions: ${kickoff.goal}`, summary, table].join("\n\n")}\n`;
}
//# sourceMappingURL=decisions.js.map