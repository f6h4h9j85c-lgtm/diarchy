export declare const LOCK_STALE_MS = 30000;
/** How often a holder refreshes its lock's mtime: well inside LOCK_STALE_MS. */
export declare const LOCK_HEARTBEAT_MS = 10000;
/** Where this process's locks say they come from; the dead-pid check only applies to locks from the same place. */
export declare const LOCK_HOST: string;
export interface LockOwner {
    pid: number;
    host: string;
    token: string;
}
/** What a reaper saw when it judged a lock stale: enough to recognise that same lock later. */
export interface LockSnapshot {
    ino: number;
    mtimeMs: number;
    owner: LockOwner | null;
}
export declare function lockOwner(dir: string): LockOwner | null;
export declare function inspectLock(dir: string): LockSnapshot | null;
/** Staleness is judged on the real clock: the lock's mtime comes from the filesystem. */
export declare function isStale(seen: LockSnapshot, staleMs?: number): boolean;
/**
 * Remove `dir` only if it is still the lock `seen` describes. One reaper at a
 * time holds `<dir>.reap/`; it re-checks staleness and renames the lock aside,
 * and puts back anything that turns out to be a newer lock. Returns whether it
 * removed the stale lock.
 */
export declare function reapIfSame(dir: string, seen: LockSnapshot, staleMs?: number): boolean;
/** One attempt: take `dir` if it is free or stale; the owner token, or null while a live owner holds it. */
export declare function tryLock(dir: string, staleMs?: number): string | null;
/** Wait for `dir`, retrying every `retryMs`; returns the owner token. */
export declare function acquireLock(dir: string, retryMs: number, wait: (ms: number) => Promise<void>): Promise<string>;
/** Refresh the lock's mtime while it is still ours; false once it is not. */
export declare function touchLock(dir: string, token: string): boolean;
/** Remove the lock only while it carries `token`; a dispossessed holder leaves its successor's lock alone. */
export declare function releaseLock(dir: string, token: string): boolean;
/** Run `body` holding `dir`, refreshing it every LOCK_HEARTBEAT_MS so a long transaction never looks stale. */
export declare function withDirLock<T>(dir: string, retryMs: number, wait: (ms: number) => Promise<void>, body: () => Promise<T>): Promise<T>;
