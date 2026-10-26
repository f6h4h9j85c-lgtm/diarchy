/**
 * `.diarchy/start.pid`: which `diarchy start` supervises this project and which
 * PM processes it spawned, as JSON
 * `{ "pid": n, "started": "...", "children": { "<agent>": { "pid": n, "started": "..." } } }`.
 *
 * `started` is the process start time (`/proc/<pid>/stat` on Linux, `ps -o
 * lstart=` in the C locale and UTC elsewhere). A recorded pid counts as the
 * same process only while the process holding that pid has the same start
 * time, so after the kernel recycles a stale pid nothing here refuses to start
 * on it or signals it.
 * The children are recorded so `diarchy stop` and the next `diarchy start`
 * can reach PMs a supervisor left behind when it died without cleaning up
 * (SIGKILL, OOM, a crash).
 */
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { releaseLock, tryLock } from "../vault/index.js";
import { CliError, sleep } from "./common.js";
export function pidPath(projectDir) {
    return join(projectDir, ".diarchy", "start.pid");
}
/** When `pid` started, as an opaque string comparable only on this host; null if unknown. */
export function processStartTime(pid) {
    if (existsSync("/proc/self/stat")) {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            // Fields after "(comm)": state is field 3, starttime field 22. A zombie has exited.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (fields[0] === "Z" || fields[0] === "X")
                return null;
            return fields[19] ?? null;
        }
        catch {
            return null;
        }
    }
    if (process.platform === "win32")
        return null;
    return psStartTime(pid);
}
/**
 * `ps -o lstart=` for `pid` (macOS and other systems without /proc). BSD ps
 * prints lstart in local time and the caller's locale, so it runs with a fixed
 * locale and zone: a `diarchy stop` from a shell with another TZ or LC_TIME
 * must read the same start time as the `diarchy start` that recorded it.
 */
export function psStartTime(pid) {
    const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
    const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env });
    const out = ps.status === 0 ? (ps.stdout ?? "").trim() : "";
    return out === "" ? null : out;
}
export function identify(pid) {
    return { pid, started: processStartTime(pid) };
}
/** True when `id.pid` is alive, signalable by us, and is still the process that was recorded. */
export function isSameProcess(id) {
    try {
        process.kill(id.pid, 0);
    }
    catch {
        return false;
    }
    return processStartTime(id.pid) === id.started;
}
function parseIdentity(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const { pid, started } = value;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return null;
    return { pid, started: typeof started === "string" ? started : null };
}
/** The record on disk; a bare pid (the pre-JSON format) reads as a pid with no start time. */
export function readRunRecord(projectDir) {
    let text;
    try {
        text = readFileSync(pidPath(projectDir), "utf8").trim();
    }
    catch {
        return null;
    }
    if (/^\d+$/.test(text))
        return { pid: Number(text), started: null, children: {} };
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    const self = parseIdentity(raw);
    if (self === null)
        return null;
    const children = {};
    const rawChildren = raw.children;
    if (typeof rawChildren === "object" && rawChildren !== null) {
        for (const [agent, value] of Object.entries(rawChildren)) {
            const child = parseIdentity(value);
            if (child !== null)
                children[agent] = child;
        }
    }
    return { ...self, children };
}
function serialize(record) {
    return `${JSON.stringify(record)}\n`;
}
/** A complete copy of the record beside the real path, so readers never see a half-written file. */
function writeTemp(projectDir, record) {
    const temp = `${pidPath(projectDir)}.${process.pid}.tmp`;
    writeFileSync(temp, serialize(record));
    return temp;
}
/** The pid of the `diarchy start` supervising this project, when it is still that process. */
export function runningSupervisor(projectDir) {
    const record = readRunRecord(projectDir);
    return record !== null && isSameProcess(record) ? record.pid : null;
}
/**
 * Claim the record for this process. The link fails when the file exists, so
 * of two starts racing past the pre-flight check only one gets it, and a
 * reader sees either no record or a whole one. On a filesystem without hard
 * links (exFAT, some network or 9p mounts) the claim is the mkdir lock
 * `.diarchy/start.pid.claim/` instead: its holder renames the complete
 * record into place only while none exists. An exclusive create would show
 * a concurrent `diarchy start` or `diarchy stop` an empty file, which they
 * delete as stale.
 */
export function claimRunRecord(projectDir) {
    const record = { ...identify(process.pid), children: {} };
    const path = pidPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    const temp = writeTemp(projectDir, record);
    try {
        try {
            linkSync(temp, path);
        }
        catch (error) {
            const code = error.code;
            if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP")
                throw error;
            publishExclusively(temp, path);
        }
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        throw new CliError(`another diarchy start claimed ${path} first; run diarchy stop first`);
    }
    finally {
        rmSync(temp, { force: true });
    }
    return record;
}
/** Rename `temp` to `path` unless `path` exists, holding the claim lock; EEXIST when another claim holds the lock or the record. */
function publishExclusively(temp, path) {
    const lock = `${path}.claim`;
    const token = tryLock(lock);
    const taken = () => Object.assign(new Error(`${path} is claimed`), { code: "EEXIST" });
    if (token === null)
        throw taken();
    try {
        if (existsSync(path))
            throw taken();
        renameSync(temp, path);
    }
    finally {
        releaseLock(lock, token);
    }
}
/** Rewrite the record this process claimed (after a child spawns). */
export function saveRunRecord(projectDir, record) {
    const current = readRunRecord(projectDir);
    if (current === null || current.pid !== record.pid)
        return;
    renameSync(writeTemp(projectDir, record), pidPath(projectDir));
}
/** Remove the record when it is still the one this process claimed. */
export function releaseRunRecord(projectDir, record) {
    const current = readRunRecord(projectDir);
    if (current === null || current.pid === record.pid)
        rmSync(pidPath(projectDir), { force: true });
}
/**
 * When the recorded supervisor is gone: stop the PM children it recorded that
 * are still running (SIGTERM, then SIGKILL after `graceMs`), delete the stale
 * record, and return what was stopped. Does nothing while the supervisor lives.
 */
export async function reapLeftovers(projectDir, graceMs = 5_000) {
    const record = readRunRecord(projectDir);
    if (record === null) {
        if (existsSync(pidPath(projectDir)))
            rmSync(pidPath(projectDir), { force: true });
        return [];
    }
    if (isSameProcess(record))
        return [];
    const leftovers = Object.entries(record.children)
        .filter(([, id]) => isSameProcess(id))
        .map(([agent, id]) => ({ agent, ...id }));
    const signal = (targets, name) => {
        for (const target of targets) {
            try {
                process.kill(target.pid, name);
            }
            catch {
                // already gone
            }
        }
    };
    signal(leftovers, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (leftovers.some(isSameProcess) && Date.now() < deadline)
        await sleep(100);
    signal(leftovers.filter(isSameProcess), "SIGKILL");
    rmSync(pidPath(projectDir), { force: true });
    return leftovers;
}
//# sourceMappingURL=run-record.js.map