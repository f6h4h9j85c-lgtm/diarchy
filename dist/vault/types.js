/** Public types of the vault store (docs/PROTOCOL.md sections 2 and 10). */
import { SchemaError } from "../protocol/index.js";
export class NoGoalError extends Error {
    constructor() {
        super("No goal in this vault. Call kickoff first.");
        this.name = "NoGoalError";
    }
}
/**
 * A stored vault file (kickoff.md or a chat/ message) that will not parse.
 * The vault is corrupt, not the caller's draft: `message` names the file and
 * the problem without the advice to fix and post again; `rule` stays SCHEMA,
 * or TYPED_ONLY for a message file whose type is unknown.
 */
export class CorruptVaultFileError extends SchemaError {
    file;
    constructor(file, cause) {
        super(cause.rule, `Vault file ${file} is corrupt: ${cause.problem}.`, cause.field, cause.problem);
        this.name = "CorruptVaultFileError";
        this.file = file;
    }
}
//# sourceMappingURL=types.js.map