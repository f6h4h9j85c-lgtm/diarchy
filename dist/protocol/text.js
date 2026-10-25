/** Word, claim, and acknowledgement helpers (ANTI-SLOP.md ONE_CLAIM, WORD_CAP, NO_ACK). */
/** Whitespace-split token count; empty or blank text counts 0. */
export function wordCount(text) {
    const trimmed = text.trim();
    return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}
export const CLAIM_MAX_WORDS = 40;
export const BODY_MAX_WORDS = 120;
export const ACK_MAX_WORDS = 8;
/**
 * PROTOCOL.md section 3: one sentence, 1 to 40 whitespace-split words, last
 * character `.` `!` or `?`, no other `.` `!` `?` followed by whitespace.
 */
export function isOneClaim(claim) {
    const text = claim.trim();
    const words = wordCount(text);
    if (words < 1 || words > CLAIM_MAX_WORDS)
        return false;
    if (!/[.!?]$/.test(text))
        return false;
    return !/[.!?]\s/.test(text);
}
/** ANTI-SLOP.md NO_ACK (b) pattern list, matched on whole words after lowercasing. */
export const ACK_PATTERNS = [
    "agreed",
    "sounds good",
    "great point",
    "makes sense",
    "+1",
    "thanks",
    "thank you",
    "i agree",
    "good idea",
    "noted",
    "will do",
    "ack",
    "ok",
    "okay",
    "lgtm",
];
/** Lowercase tokens with edge punctuation stripped (`+` kept so `+1` survives). */
function ackTokens(text) {
    return text
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/^[^a-z0-9+]+|[^a-z0-9+]+$/g, ""))
        .filter((token) => token !== "");
}
function containsSequence(words, pattern) {
    for (let start = 0; start + pattern.length <= words.length; start += 1) {
        if (pattern.every((word, offset) => words[start + offset] === word))
            return true;
    }
    return false;
}
/**
 * NO_ACK (b): a body of 8 words or fewer that contains an acknowledgement
 * phrase. A body identical to the claim counts as empty.
 */
export function isAck(body, claim) {
    const effective = claim !== undefined && body.trim() === claim.trim() ? "" : body;
    const words = effective.trim() === "" ? [] : effective.trim().split(/\s+/);
    if (words.length === 0 || words.length > ACK_MAX_WORDS)
        return false;
    const tokens = ackTokens(effective);
    return ACK_PATTERNS.some((pattern) => containsSequence(tokens, pattern.split(" ")));
}
/** Longest branch, worktree, or path a message may carry (PROTOCOL.md 3). */
export const FIELD_MAX_CHARS = 200;
/** Longest agent-authored text `oneLine` lets into a brief or hook reason by default. */
export const ONE_LINE_MAX_CHARS = 80;
/** C0 controls (line breaks and tab included), DEL, C1 controls, and U+2028/U+2029. */
function isControl(code) {
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}
/** True when `text` holds a line break or any other control character. */
export function hasControlChars(text) {
    for (let index = 0; index < text.length; index += 1) {
        if (isControl(text.charCodeAt(index)))
            return true;
    }
    return false;
}
/**
 * Agent-authored text made safe for a one-line terminal or hook context:
 * control characters become spaces, whitespace collapses, and text longer
 * than `maxChars` is cut with an ellipsis.
 */
export function oneLine(text, maxChars = ONE_LINE_MAX_CHARS) {
    const chars = Array.from(text, (char) => (isControl(char.codePointAt(0) ?? 0) ? " " : char));
    const flat = Array.from(chars.join("").replace(/\s+/g, " ").trim());
    return flat.length <= maxChars ? flat.join("") : `${flat.slice(0, maxChars - 1).join("").trimEnd()}…`;
}
/** First `max` whitespace-split tokens, with an ellipsis when cut. */
export function truncateWords(text, max) {
    const words = text.trim().split(/\s+/).filter((word) => word !== "");
    if (words.length <= max)
        return words.join(" ");
    return `${words.slice(0, max).join(" ")} ...`;
}
//# sourceMappingURL=text.js.map