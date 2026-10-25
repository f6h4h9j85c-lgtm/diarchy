/** Unique per writer: the pid alone collides across pid namespaces sharing a vault. */
export declare function tempPath(path: string): string;
/**
 * Write `text` to `path` atomically. With `durable`, the data is flushed to
 * disk before the rename and the rename itself is flushed after, so a power
 * loss leaves the old file or the new one, never an empty one (budget.json,
 * kickoff.md, and chat/ files).
 */
export declare function atomicWrite(path: string, text: string, options?: {
    durable?: boolean;
}): void;
export declare function readJson(path: string): unknown;
export declare function sleep(ms: number): Promise<void>;
