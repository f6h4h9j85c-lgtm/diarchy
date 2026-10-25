/** The one write path for store-owned files: temp file in the same directory, then rename. */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Unique per writer: the pid alone collides across pid namespaces sharing a vault. */
export function tempPath(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/**
 * Write `text` to `path` atomically. With `durable`, the data is flushed to
 * disk before the rename and the rename itself is flushed after, so a power
 * loss leaves the old file or the new one, never an empty one (budget.json,
 * kickoff.md, and chat/ files).
 */
export function atomicWrite(path: string, text: string, options: { durable?: boolean } = {}): void {
  const tmp = tempPath(path);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text);
    if (options.durable === true) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (options.durable === true) syncDirectory(dirname(path));
}

/** Flush a directory entry change; some platforms cannot open a directory, which is fine. */
function syncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // best effort
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
