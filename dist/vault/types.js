export class NoGoalError extends Error {
    constructor() {
        super("No goal in this vault. Call kickoff first.");
        this.name = "NoGoalError";
    }
}
//# sourceMappingURL=types.js.map