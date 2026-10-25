export declare const GATE_CAP = 12;
export declare function runInboxSkim(projectDir: string, agent: string): string[];
export declare function gateRecordPath(projectDir: string, agent: string): string;
export interface GateDecision {
    decision: "block";
    reason: string;
}
/** The block decision, or null to let the turn end. The hook JSON on stdin is drained by the caller and not needed. */
export declare function runGate(projectDir: string, agent: string): GateDecision | null;
