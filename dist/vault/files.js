/** The one write path for store-owned files: temp file in the same directory, then rename. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
export function tempPath(path) {
    return `${path}.tmp-${process.pid}`;
}
export function atomicWrite(path, text) {
    const tmp = tempPath(path);
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}
export function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=files.js.map