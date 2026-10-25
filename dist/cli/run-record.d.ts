export interface ProcessIdentity {
    pid: number;
    /** Process start time; null where the OS gives no way to read it. */
    started: string | null;
}
export interface RunRecord extends ProcessIdentity {
    children: Record<string, ProcessIdentity>;
}
export declare function pidPath(projectDir: string): string;
/** When `pid` started, as an opaque string comparable only on this host; null if unknown. */
export declare function processStartTime(pid: number): string | null;
export declare function identify(pid: number): ProcessIdentity;
/** True when `id.pid` is alive, signalable by us, and is still the process that was recorded. */
export declare function isSameProcess(id: ProcessIdentity): boolean;
/** The record on disk; a bare pid (the pre-JSON format) reads as a pid with no start time. */
export declare function readRunRecord(projectDir: string): RunRecord | null;
/** The pid of the `diarchy start` supervising this project, when it is still that process. */
export declare function runningSupervisor(projectDir: string): number | null;
/**
 * Claim the record for this process. The link fails when the file exists, so
 * of two starts racing past the pre-flight check only one gets it.
 */
export declare function claimRunRecord(projectDir: string): RunRecord;
/** Rewrite the record this process claimed (after a child spawns). */
export declare function saveRunRecord(projectDir: string, record: RunRecord): void;
/** Remove the record when it is still the one this process claimed. */
export declare function releaseRunRecord(projectDir: string, record: RunRecord): void;
export interface Leftover extends ProcessIdentity {
    agent: string;
}
/**
 * When the recorded supervisor is gone: stop the PM children it recorded that
 * are still running (SIGTERM, then SIGKILL after `graceMs`), delete the stale
 * record, and return what was stopped. Does nothing while the supervisor lives.
 */
export declare function reapLeftovers(projectDir: string, graceMs?: number): Promise<Leftover[]>;
