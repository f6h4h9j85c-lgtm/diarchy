import type { ProjectSource } from "./common.js";
/** Relative to the project: the marker that turns the trail on, and the trail itself. */
export declare const DIAG_MARKER: string;
export declare const DIAG_LOG: string;
/** Longest line written, in bytes; a longer one keeps only who and what. */
export declare const DIAG_MAX_LINE = 2048;
export type DiagValue = string | number | boolean | null;
/** Where a process is logging from: the resolved project and, when known, how it was found. */
export interface DiagWhere {
    dir: string;
    source?: ProjectSource;
}
export declare function diagEnabled(projectDir: string): boolean;
/** Append one event to the trail when it is on. Never throws. */
export declare function diag(where: DiagWhere, agent: string | null, event: string, fields?: Record<string, DiagValue>): void;
/** The class of an error, for a line that must not carry its message. */
export declare function errorName(error: unknown): string;
