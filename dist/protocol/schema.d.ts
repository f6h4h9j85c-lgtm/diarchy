import { z } from "zod";
import { type DiarchyConfig, type GoalState, type Kickoff, type Message, type MessageType } from "./types.js";
export declare const MESSAGE_ID_PATTERN: RegExp;
export declare const GOAL_ID_PATTERN: RegExp;
export declare const AC_ID_PATTERN: RegExp;
export declare const TASK_ID_PATTERN: RegExp;
export declare const DECISION_ID_PATTERN: RegExp;
export declare const ISO_TS_PATTERN: RegExp;
export interface MessageIdParts {
    ts_compact: string;
    seq: number;
    agent: string;
    type: string;
}
export declare function parseMessageId(id: string): MessageIdParts | null;
/** `2026-10-25T14:30:12Z` -> `20261025T143012Z`. */
export declare function compactTs(ts: string): string;
/** Second-precision UTC ISO string without milliseconds. */
export declare function isoSeconds(date: Date): string;
export declare const evidenceItemSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"commit">;
    sha: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"pr">;
    url: z.ZodURL;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"test">;
    test: z.ZodString;
    result: z.ZodEnum<{
        pass: "pass";
        fail: "fail";
        pending: "pending";
    }>;
    log: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"file">;
    path: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"review">;
    url: z.ZodURL;
    verdict: z.ZodEnum<{
        approve: "approve";
        request_changes: "request_changes";
    }>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"human">;
    id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"external">;
    url: z.ZodURL;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "kind">;
export declare const budgetLimitsSchema: z.ZodObject<{
    plan_messages: z.ZodNumber;
    messages_total: z.ZodNumber;
    challenges_per_decision: z.ZodNumber;
    rounds_per_decision: z.ZodNumber;
    talk_work_ratio: z.ZodNumber;
    wall_clock_minutes: z.ZodNumber;
    spend_usd: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const partialBudgetsSchema: z.ZodObject<{
    plan_messages: z.ZodOptional<z.ZodNumber>;
    messages_total: z.ZodOptional<z.ZodNumber>;
    challenges_per_decision: z.ZodOptional<z.ZodNumber>;
    rounds_per_decision: z.ZodOptional<z.ZodNumber>;
    talk_work_ratio: z.ZodOptional<z.ZodNumber>;
    wall_clock_minutes: z.ZodOptional<z.ZodNumber>;
    spend_usd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.core.$strict>;
export declare const messageSchemas: {
    KICKOFF: z.ZodObject<{
        type: z.ZodLiteral<"KICKOFF">;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    PROPOSE: z.ZodObject<{
        type: z.ZodLiteral<"PROPOSE">;
        claim: z.ZodString;
        decision_id: z.ZodOptional<z.ZodString>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    CHALLENGE: z.ZodObject<{
        type: z.ZodLiteral<"CHALLENGE">;
        reply_to: z.ZodString;
        claim: z.ZodString;
        decision_id: z.ZodString;
        evidence: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"commit">;
            sha: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"pr">;
            url: z.ZodURL;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"test">;
            test: z.ZodString;
            result: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                pending: "pending";
            }>;
            log: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"review">;
            url: z.ZodURL;
            verdict: z.ZodEnum<{
                approve: "approve";
                request_changes: "request_changes";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"human">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"external">;
            url: z.ZodURL;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "kind">>>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    DECIDE: z.ZodObject<{
        type: z.ZodLiteral<"DECIDE">;
        claim: z.ZodString;
        basis: z.ZodEnum<{
            human: "human";
            test: "test";
            authority: "authority";
            "adopted-challenge": "adopted-challenge";
        }>;
        decision_id: z.ZodOptional<z.ZodString>;
        supersedes: z.ZodOptional<z.ZodString>;
        evidence: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"commit">;
            sha: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"pr">;
            url: z.ZodURL;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"test">;
            test: z.ZodString;
            result: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                pending: "pending";
            }>;
            log: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"review">;
            url: z.ZodURL;
            verdict: z.ZodEnum<{
                approve: "approve";
                request_changes: "request_changes";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"human">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"external">;
            url: z.ZodURL;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "kind">>>;
        tasks: z.ZodOptional<z.ZodArray<z.ZodString>>;
        ac_add: z.ZodOptional<z.ZodArray<z.ZodString>>;
        budgets: z.ZodOptional<z.ZodObject<{
            plan_messages: z.ZodOptional<z.ZodNumber>;
            messages_total: z.ZodOptional<z.ZodNumber>;
            challenges_per_decision: z.ZodOptional<z.ZodNumber>;
            rounds_per_decision: z.ZodOptional<z.ZodNumber>;
            talk_work_ratio: z.ZodOptional<z.ZodNumber>;
            wall_clock_minutes: z.ZodOptional<z.ZodNumber>;
            spend_usd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$strict>>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    ASSIGN: z.ZodObject<{
        type: z.ZodLiteral<"ASSIGN">;
        task: z.ZodOptional<z.ZodString>;
        new_task: z.ZodOptional<z.ZodString>;
        kind: z.ZodEnum<{
            implement: "implement";
            review: "review";
        }>;
        worktree: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        pr: z.ZodOptional<z.ZodURL>;
        reason: z.ZodOptional<z.ZodString>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    STATUS: z.ZodObject<{
        type: z.ZodLiteral<"STATUS">;
        task: z.ZodOptional<z.ZodString>;
        task_status: z.ZodOptional<z.ZodEnum<{
            in_progress: "in_progress";
            done: "done";
        }>>;
        evidence: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"commit">;
            sha: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"pr">;
            url: z.ZodURL;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"test">;
            test: z.ZodString;
            result: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                pending: "pending";
            }>;
            log: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"review">;
            url: z.ZodURL;
            verdict: z.ZodEnum<{
                approve: "approve";
                request_changes: "request_changes";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"human">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"external">;
            url: z.ZodURL;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "kind">>>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    DONE: z.ZodObject<{
        type: z.ZodLiteral<"DONE">;
        evidence: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"commit">;
            sha: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"pr">;
            url: z.ZodURL;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"test">;
            test: z.ZodString;
            result: z.ZodEnum<{
                pass: "pass";
                fail: "fail";
                pending: "pending";
            }>;
            log: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"review">;
            url: z.ZodURL;
            verdict: z.ZodEnum<{
                approve: "approve";
                request_changes: "request_changes";
            }>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"human">;
            id: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"external">;
            url: z.ZodURL;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>], "kind">>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    BLOCKED: z.ZodObject<{
        type: z.ZodLiteral<"BLOCKED">;
        kind: z.ZodEnum<{
            external: "external";
            internal: "internal";
        }>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
    ASK_HUMAN: z.ZodObject<{
        type: z.ZodLiteral<"ASK_HUMAN">;
        decision_id: z.ZodOptional<z.ZodString>;
        protocol_version: z.ZodLiteral<1>;
        id: z.ZodString;
        goal: z.ZodString;
        from: z.ZodString;
        to: z.ZodString;
        re: z.ZodDefault<z.ZodArray<z.ZodString>>;
        reply_to: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            PLAN: "PLAN";
            EXECUTE: "EXECUTE";
        }>;
        ts: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
};
export declare const messageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"KICKOFF">;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"PROPOSE">;
    claim: z.ZodString;
    decision_id: z.ZodOptional<z.ZodString>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"CHALLENGE">;
    reply_to: z.ZodString;
    claim: z.ZodString;
    decision_id: z.ZodString;
    evidence: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"pr">;
        url: z.ZodURL;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"test">;
        test: z.ZodString;
        result: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            pending: "pending";
        }>;
        log: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"review">;
        url: z.ZodURL;
        verdict: z.ZodEnum<{
            approve: "approve";
            request_changes: "request_changes";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"human">;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"external">;
        url: z.ZodURL;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "kind">>>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"DECIDE">;
    claim: z.ZodString;
    basis: z.ZodEnum<{
        human: "human";
        test: "test";
        authority: "authority";
        "adopted-challenge": "adopted-challenge";
    }>;
    decision_id: z.ZodOptional<z.ZodString>;
    supersedes: z.ZodOptional<z.ZodString>;
    evidence: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"pr">;
        url: z.ZodURL;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"test">;
        test: z.ZodString;
        result: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            pending: "pending";
        }>;
        log: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"review">;
        url: z.ZodURL;
        verdict: z.ZodEnum<{
            approve: "approve";
            request_changes: "request_changes";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"human">;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"external">;
        url: z.ZodURL;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "kind">>>;
    tasks: z.ZodOptional<z.ZodArray<z.ZodString>>;
    ac_add: z.ZodOptional<z.ZodArray<z.ZodString>>;
    budgets: z.ZodOptional<z.ZodObject<{
        plan_messages: z.ZodOptional<z.ZodNumber>;
        messages_total: z.ZodOptional<z.ZodNumber>;
        challenges_per_decision: z.ZodOptional<z.ZodNumber>;
        rounds_per_decision: z.ZodOptional<z.ZodNumber>;
        talk_work_ratio: z.ZodOptional<z.ZodNumber>;
        wall_clock_minutes: z.ZodOptional<z.ZodNumber>;
        spend_usd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, z.core.$strict>>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"ASSIGN">;
    task: z.ZodOptional<z.ZodString>;
    new_task: z.ZodOptional<z.ZodString>;
    kind: z.ZodEnum<{
        implement: "implement";
        review: "review";
    }>;
    worktree: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    pr: z.ZodOptional<z.ZodURL>;
    reason: z.ZodOptional<z.ZodString>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"STATUS">;
    task: z.ZodOptional<z.ZodString>;
    task_status: z.ZodOptional<z.ZodEnum<{
        in_progress: "in_progress";
        done: "done";
    }>>;
    evidence: z.ZodOptional<z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"pr">;
        url: z.ZodURL;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"test">;
        test: z.ZodString;
        result: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            pending: "pending";
        }>;
        log: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"review">;
        url: z.ZodURL;
        verdict: z.ZodEnum<{
            approve: "approve";
            request_changes: "request_changes";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"human">;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"external">;
        url: z.ZodURL;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "kind">>>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"DONE">;
    evidence: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"commit">;
        sha: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"pr">;
        url: z.ZodURL;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"test">;
        test: z.ZodString;
        result: z.ZodEnum<{
            pass: "pass";
            fail: "fail";
            pending: "pending";
        }>;
        log: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"review">;
        url: z.ZodURL;
        verdict: z.ZodEnum<{
            approve: "approve";
            request_changes: "request_changes";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"human">;
        id: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"external">;
        url: z.ZodURL;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>], "kind">>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"BLOCKED">;
    kind: z.ZodEnum<{
        external: "external";
        internal: "internal";
    }>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"ASK_HUMAN">;
    decision_id: z.ZodOptional<z.ZodString>;
    protocol_version: z.ZodLiteral<1>;
    id: z.ZodString;
    goal: z.ZodString;
    from: z.ZodString;
    to: z.ZodString;
    re: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reply_to: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    ts: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>], "type">;
export type ShapeRule = "SCHEMA" | "TYPED_ONLY";
export type ShapeResult = {
    ok: true;
    message: Message;
} | {
    ok: false;
    rule: ShapeRule;
    message: string;
    field: string | null;
};
export interface FieldProblem {
    field: string;
    problem: string;
}
export declare function schemaMessage(field: string, problem: string): string;
export declare function typedOnlyMessage(type: unknown): string;
export declare function isMessageType(type: unknown): type is MessageType;
/** Cross-field requirements PROTOCOL.md section 3 states in prose. */
export declare function conditionalProblem(message: Message): FieldProblem | null;
/**
 * Stateless validation of a message object. Runs the common fields first
 * (SCHEMA), then the type name (TYPED_ONLY), then the type-specific shape
 * (SCHEMA), matching the ANTI-SLOP.md evaluation order.
 */
export declare function checkMessageShape(input: unknown): ShapeResult;
export declare class SchemaError extends Error {
    readonly rule: ShapeRule;
    readonly field: string | null;
    constructor(rule: ShapeRule, message: string, field?: string | null);
}
export interface SplitFile {
    frontmatter: Record<string, unknown>;
    body: string;
}
/** Split a markdown file into its YAML frontmatter mapping and body. */
export declare function splitFrontmatter(text: string): SplitFile;
/** Parse a `chat/<id>.md` file; throws `SchemaError` (SCHEMA or TYPED_ONLY). */
export declare function parseMessageFile(text: string): Message;
/** Canonical key order, taken from the PROTOCOL.md 3.2 examples. */
export declare const FRONTMATTER_KEY_ORDER: readonly ["protocol_version", "id", "goal", "from", "to", "type", "re", "reply_to", "decision_id", "task", "new_task", "kind", "worktree", "branch", "pr", "reason", "task_status", "phase", "claim", "basis", "supersedes", "evidence", "tasks", "ac_add", "budgets", "ts"];
/** Serialize to the canonical file text; round-trips the PROTOCOL.md examples byte for byte. */
export declare function serializeMessageFile(message: Message): string;
export declare const kickoffFrontmatterSchema: z.ZodObject<{
    protocol_version: z.ZodLiteral<1>;
    goal: z.ZodString;
    lead: z.ZodString;
    challenger: z.ZodString;
    agents: z.ZodArray<z.ZodString>;
    budgets: z.ZodDefault<z.ZodObject<{
        plan_messages: z.ZodOptional<z.ZodNumber>;
        messages_total: z.ZodOptional<z.ZodNumber>;
        challenges_per_decision: z.ZodOptional<z.ZodNumber>;
        rounds_per_decision: z.ZodOptional<z.ZodNumber>;
        talk_work_ratio: z.ZodOptional<z.ZodNumber>;
        wall_clock_minutes: z.ZodOptional<z.ZodNumber>;
        spend_usd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, z.core.$strict>>;
    project: z.ZodString;
    vault: z.ZodString;
    created: z.ZodString;
    by: z.ZodString;
}, z.core.$strict>;
/** Parse kickoff.md: frontmatter, goal text, and the `- AC<n>: <criterion>` lines. */
export declare function parseKickoffFile(text: string): Kickoff;
export declare const configSchema: z.ZodObject<{
    protocol_version: z.ZodLiteral<1>;
    vault: z.ZodString;
    agents: z.ZodRecord<z.ZodString, z.ZodObject<{
        command: z.ZodString;
    }, z.core.$strip>>;
    budgets: z.ZodDefault<z.ZodObject<{
        plan_messages: z.ZodOptional<z.ZodNumber>;
        messages_total: z.ZodOptional<z.ZodNumber>;
        challenges_per_decision: z.ZodOptional<z.ZodNumber>;
        rounds_per_decision: z.ZodOptional<z.ZodNumber>;
        talk_work_ratio: z.ZodOptional<z.ZodNumber>;
        wall_clock_minutes: z.ZodOptional<z.ZodNumber>;
        spend_usd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, z.core.$strict>>;
    worktrees: z.ZodDefault<z.ZodObject<{
        root: z.ZodString;
        branch_prefix: z.ZodString;
    }, z.core.$strip>>;
    review: z.ZodDefault<z.ZodObject<{
        required: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare function parseConfig(input: unknown): DiarchyConfig;
export declare const goalStateSchema: z.ZodObject<{
    protocol_version: z.ZodLiteral<1>;
    goal: z.ZodString;
    created: z.ZodString;
    lead: z.ZodString;
    challenger: z.ZodString;
    agents: z.ZodArray<z.ZodString>;
    kickoff_id: z.ZodNullable<z.ZodString>;
    phase: z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>;
    blocked_from: z.ZodNullable<z.ZodEnum<{
        DONE: "DONE";
        BLOCKED: "BLOCKED";
        PLAN: "PLAN";
        EXECUTE: "EXECUTE";
    }>>;
    limits: z.ZodObject<{
        plan_messages: z.ZodNumber;
        messages_total: z.ZodNumber;
        challenges_per_decision: z.ZodNumber;
        rounds_per_decision: z.ZodNumber;
        talk_work_ratio: z.ZodNumber;
        wall_clock_minutes: z.ZodNumber;
        spend_usd: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    used: z.ZodObject<{
        plan_messages: z.ZodNumber;
        messages_total: z.ZodNumber;
        talk_since_work: z.ZodNumber;
        wall_clock_minutes: z.ZodNumber;
        spend_usd: z.ZodNumber;
    }, z.core.$strict>;
    seq: z.ZodRecord<z.ZodString, z.ZodNumber>;
    last_ts: z.ZodNullable<z.ZodString>;
    decisions: z.ZodRecord<z.ZodString, z.ZodObject<{
        status: z.ZodEnum<{
            open: "open";
            decided: "decided";
            superseded: "superseded";
        }>;
        proposer: z.ZodNullable<z.ZodString>;
        messages: z.ZodNumber;
        challenges: z.ZodNumber;
        supersedes: z.ZodNullable<z.ZodString>;
        superseded_by: z.ZodNullable<z.ZodString>;
        evidence: z.ZodArray<z.ZodString>;
        challenge: z.ZodNullable<z.ZodObject<{
            id: z.ZodString;
            from: z.ZodString;
            new_evidence: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    prs: z.ZodRecord<z.ZodURL, z.ZodObject<{
        author: z.ZodString;
        reviews: z.ZodArray<z.ZodObject<{
            by: z.ZodString;
            verdict: z.ZodEnum<{
                approve: "approve";
                request_changes: "request_changes";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    deadlock_watch: z.ZodNullable<z.ZodObject<{
        decision_id: z.ZodString;
        challenge_id: z.ZodString;
        remaining: z.ZodNumber;
        deadline: z.ZodString;
    }, z.core.$strict>>;
    acs: z.ZodRecord<z.ZodString, z.ZodObject<{
        criterion: z.ZodString;
        status: z.ZodEnum<{
            open: "open";
            passing: "passing";
            failing: "failing";
        }>;
    }, z.core.$strict>>;
    tasks: z.ZodRecord<z.ZodString, z.ZodObject<{
        id: z.ZodString;
        task: z.ZodString;
        kind: z.ZodNullable<z.ZodEnum<{
            implement: "implement";
            review: "review";
        }>>;
        assignee: z.ZodNullable<z.ZodString>;
        branch: z.ZodNullable<z.ZodString>;
        worktree: z.ZodNullable<z.ZodString>;
        pr: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            todo: "todo";
            assigned: "assigned";
            in_progress: "in_progress";
            done: "done";
        }>;
    }, z.core.$strict>>;
    messages: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodString;
        type: z.ZodEnum<{
            KICKOFF: "KICKOFF";
            PROPOSE: "PROPOSE";
            CHALLENGE: "CHALLENGE";
            DECIDE: "DECIDE";
            ASSIGN: "ASSIGN";
            STATUS: "STATUS";
            DONE: "DONE";
            BLOCKED: "BLOCKED";
            ASK_HUMAN: "ASK_HUMAN";
        }>;
        decision_id: z.ZodNullable<z.ZodString>;
        re: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    review_required: z.ZodBoolean;
    updated: z.ZodString;
}, z.core.$strict>;
/** Validate a budget.json snapshot loaded from disk. */
export declare function parseGoalState(input: unknown): GoalState;
