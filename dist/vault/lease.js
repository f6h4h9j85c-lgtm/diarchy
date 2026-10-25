/**
 * One live MCP server per agent and goal (docs/PROTOCOL.md 10). The inbox
 * cursor has a single reader: two servers posting as the same agent would
 * each take some of the other agent's messages and hide them from the other.
 * The first server to act on a goal holds `inbox/<agent>.lock/` until it
 * exits, refreshing it every LOCK_HEARTBEAT_MS; another live server for that
 * agent is refused. A holder that died, or stopped refreshing for
 * LOCK_STALE_MS, is taken over.
 */
import { mkdirSync } from "node:fs";
import { LOCK_HEARTBEAT_MS, lockOwner, releaseLock, touchLock, tryLock } from "./lock.js";
export class AgentLease {
    agent;
    /** Lease directory -> our owner token. */
    held = new Map();
    heartbeat = null;
    constructor(agent) {
        this.agent = agent;
    }
    /** null when this server may act as its agent on the goal; otherwise the live server that holds it. */
    claim(paths) {
        const dir = paths.lease(this.agent);
        const token = this.held.get(dir);
        if (token !== undefined) {
            if (touchLock(dir, token))
                return null;
            this.held.delete(dir);
        }
        mkdirSync(paths.inboxDir, { recursive: true });
        const taken = tryLock(dir);
        if (taken === null)
            return lockOwner(dir) ?? { pid: 0, host: "unknown", token: "" };
        this.held.set(dir, taken);
        this.startHeartbeat();
        return null;
    }
    /** Give up every lease this server holds (on close). */
    release() {
        for (const [dir, token] of this.held)
            releaseLock(dir, token);
        this.held.clear();
        if (this.heartbeat !== null)
            clearInterval(this.heartbeat);
        this.heartbeat = null;
    }
    startHeartbeat() {
        if (this.heartbeat !== null)
            return;
        this.heartbeat = setInterval(() => {
            for (const [dir, token] of this.held)
                if (!touchLock(dir, token))
                    this.held.delete(dir);
        }, LOCK_HEARTBEAT_MS);
        this.heartbeat.unref();
    }
}
//# sourceMappingURL=lease.js.map