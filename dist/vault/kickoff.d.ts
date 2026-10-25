import type { Kickoff } from "../protocol/index.js";
/** `[a-z0-9-]{1,40}` from free text. */
export declare function slugify(text: string): string;
/** kickoff.md text: frontmatter in PROTOCOL.md 2.3 order, goal text, then `- AC<n>: <criterion>` lines. */
export declare function serializeKickoff(kickoff: Kickoff): string;
