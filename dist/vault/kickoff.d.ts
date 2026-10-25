import type { Kickoff } from "../protocol/index.js";
/**
 * `[a-z0-9-]{1,40}` from free text. Accents are dropped (`Café` gives `cafe`);
 * text with no Latin letters or digits at all gives `fallback`.
 */
export declare function slugify(text: string, fallback?: string): string;
/** `<slug>-<n>`, cutting the slug so the result stays within 40 characters. */
export declare function suffixSlug(slug: string, n: number): string;
/** kickoff.md text: frontmatter in PROTOCOL.md 2.3 order, goal text, then `- AC<n>: <criterion>` lines. */
export declare function serializeKickoff(kickoff: Kickoff): string;
