/**
 * mkdir-atomic directory locks with an owner token (docs/PROTOCOL.md 2.2).
 *
 * `mkdir` creates the lock; `owner` inside names the pid, host, and a random
 * token. A lock is stale when its mtime is older than LOCK_STALE_MS (holders
 * refresh it while they work) or when its owner is a dead process on this
 * host. Taking over a stale lock is exclusive: a reaper first takes
 * `<lock>.reap/`, re-checks staleness, and renames the very lock it judged
 * stale aside before deleting it. Release removes the lock only while it still
 * carries the releaser's token, so a holder that was dispossessed never
 * deletes its successor's lock.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
export const LOCK_STALE_MS = 30_000;
/** How often a holder refreshes its lock's mtime: well inside LOCK_STALE_MS. */
export const LOCK_HEARTBEAT_MS = 10_000;
const OWNER_FILE = "owner";
/** The hostname plus, on Linux, the pid namespace: a pid is only meaningful inside the namespace that issued it. */
function hostId() {
    let namespace = "";
    try {
        namespace = readlinkSync("/proc/self/ns/pid");
    }
    catch {
        // not Linux, or /proc is not mounted: the hostname alone
    }
    return namespace === "" ? hostname() : `${hostname()} ${namespace}`;
}
/** Where this process's locks say they come from; the dead-pid check only applies to locks from the same place. */
export const LOCK_HOST = hostId();
export function lockOwner(dir) {
    try {
        const raw = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8"));
        if (typeof raw.pid !== "number" || typeof raw.host !== "string" || typeof raw.token !== "string")
            return null;
        return { pid: raw.pid, host: raw.host, token: raw.token };
    }
    catch {
        return null;
    }
}
export function inspectLock(dir) {
    try {
        const stat = statSync(dir);
        return { ino: stat.ino, mtimeMs: stat.mtimeMs, owner: lockOwner(dir) };
    }
    catch {
        return null;
    }
}
/** ESRCH is the only proof of death; EPERM means alive under another user. */
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
/** Staleness is judged on the real clock: the lock's mtime comes from the filesystem. */
export function isStale(seen, staleMs = LOCK_STALE_MS) {
    if (Date.now() - seen.mtimeMs > staleMs)
        return true;
    const owner = seen.owner;
    return owner !== null && owner.host === LOCK_HOST && owner.pid !== process.pid && !processAlive(owner.pid);
}
/** mkdir the lock and sign it; null when it already exists. */
function createLock(dir) {
    try {
        mkdirSync(dir);
    }
    catch (error) {
        if (error.code === "EEXIST")
            return null;
        throw error;
    }
    const token = randomUUID();
    writeFileSync(join(dir, OWNER_FILE), `${JSON.stringify({ pid: process.pid, host: LOCK_HOST, token })}\n`);
    return token;
}
/**
 * Remove `dir` only if it is still the lock `seen` describes. One reaper at a
 * time holds `<dir>.reap/`; it re-checks staleness and renames the lock aside,
 * and puts back anything that turns out to be a newer lock. Returns whether it
 * removed the stale lock.
 */
export function reapIfSame(dir, seen, staleMs = LOCK_STALE_MS) {
    const mutex = `${dir}.reap`;
    try {
        mkdirSync(mutex);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        // A reaper that died mid-reap leaves the mutex; it only ever lives for microseconds.
        const left = inspectLock(mutex);
        if (left !== null && Date.now() - left.mtimeMs > staleMs)
            rmSync(mutex, { recursive: true, force: true });
        return false;
    }
    try {
        const now = inspectLock(dir);
        if (now === null || !sameLock(now, seen) || !isStale(now, staleMs))
            return false;
        const aside = `${dir}.reaped-${randomUUID()}`;
        try {
            renameSync(dir, aside);
        }
        catch {
            return false;
        }
        const moved = inspectLock(aside);
        if (moved !== null && sameLock(moved, seen)) {
            rmSync(aside, { recursive: true, force: true });
            return true;
        }
        // The holder released and someone re-locked between the check and the rename: give it back.
        try {
            renameSync(aside, dir);
        }
        catch {
            rmSync(aside, { recursive: true, force: true });
        }
        return false;
    }
    finally {
        rmSync(mutex, { recursive: true, force: true });
    }
}
function sameLock(a, b) {
    return a.ino === b.ino && a.owner?.token === b.owner?.token;
}
/** One attempt: take `dir` if it is free or stale; the owner token, or null while a live owner holds it. */
export function tryLock(dir, staleMs = LOCK_STALE_MS) {
    const token = createLock(dir);
    if (token !== null)
        return token;
    const seen = inspectLock(dir);
    if (seen === null || (isStale(seen, staleMs) && reapIfSame(dir, seen, staleMs)))
        return createLock(dir);
    return null;
}
/** Wait for `dir`, retrying every `retryMs`; returns the owner token. */
export async function acquireLock(dir, retryMs, wait) {
    for (;;) {
        const token = tryLock(dir);
        if (token !== null)
            return token;
        await wait(retryMs);
    }
}
/** Refresh the lock's mtime while it is still ours; false once it is not. */
export function touchLock(dir, token) {
    if (lockOwner(dir)?.token !== token)
        return false;
    try {
        const now = new Date();
        utimesSync(dir, now, now);
        return true;
    }
    catch {
        return false;
    }
}
/** Remove the lock only while it carries `token`; a dispossessed holder leaves its successor's lock alone. */
export function releaseLock(dir, token) {
    if (lockOwner(dir)?.token !== token)
        return false;
    const aside = `${dir}.released-${token}`;
    try {
        renameSync(dir, aside);
    }
    catch {
        return false;
    }
    rmSync(aside, { recursive: true, force: true });
    return true;
}
/** Run `body` holding `dir`, refreshing it every LOCK_HEARTBEAT_MS so a long transaction never looks stale. */
export async function withDirLock(dir, retryMs, wait, body) {
    const token = await acquireLock(dir, retryMs, wait);
    const heartbeat = setInterval(() => touchLock(dir, token), LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
        return await body();
    }
    finally {
        clearInterval(heartbeat);
        releaseLock(dir, token);
    }
}
//# sourceMappingURL=lock.js.map