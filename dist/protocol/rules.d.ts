/**
 * One function per ANTI-SLOP.md rule. Each returns a Rejection whose text is
 * the doc's error message with placeholders filled, or null when the rule
 * passes. `RULES_IN_ORDER` is the doc's evaluation order.
 */
import { type FieldProblem } from "./schema.js";
import { type GoalState, type Message, type Rule, type RuleId } from "./types.js";
export declare const RULES_IN_ORDER: RuleId[];
/** Store-level SCHEMA checks: references that must exist in goal state. */
export declare function stateProblem(message: Message, state: GoalState): FieldProblem | null;
/** PROTOCOL.md 9.2 (a) to (d), as a list of what is missing. */
export declare function doneMissing(message: Message, state: GoalState): string[];
export declare const RULES: Record<RuleId, Rule>;
