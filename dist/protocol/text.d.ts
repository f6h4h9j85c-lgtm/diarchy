/** Word, claim, and acknowledgement helpers (ANTI-SLOP.md ONE_CLAIM, WORD_CAP, NO_ACK). */
/** Whitespace-split token count; empty or blank text counts 0. */
export declare function wordCount(text: string): number;
export declare const CLAIM_MAX_WORDS = 40;
export declare const BODY_MAX_WORDS = 120;
export declare const ACK_MAX_WORDS = 8;
/**
 * PROTOCOL.md section 3: one sentence, 1 to 40 whitespace-split words, last
 * character `.` `!` or `?`, no other `.` `!` `?` followed by whitespace.
 */
export declare function isOneClaim(claim: string): boolean;
/** ANTI-SLOP.md NO_ACK (b) pattern list, matched on whole words after lowercasing. */
export declare const ACK_PATTERNS: readonly ["agreed", "sounds good", "great point", "makes sense", "+1", "thanks", "thank you", "i agree", "good idea", "noted", "will do", "ack", "ok", "okay", "lgtm"];
/**
 * NO_ACK (b): a body of 8 words or fewer that contains an acknowledgement
 * phrase. A body identical to the claim counts as empty.
 */
export declare function isAck(body: string, claim?: string): boolean;
/** First `max` whitespace-split tokens, with an ellipsis when cut. */
export declare function truncateWords(text: string, max: number): string;
