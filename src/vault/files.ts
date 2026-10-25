/** The one write path for store-owned files: temp file in the same directory, then rename. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function tempPath(path: string): string {
  return `${path}.tmp-${process.pid}`;
}

export function atomicWrite(path: string, text: string): void {
  const tmp = tempPath(path);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
