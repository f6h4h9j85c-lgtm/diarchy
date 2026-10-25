/** diarchy protocol engine: pure rule evaluation for docs/PROTOCOL.md and docs/ANTI-SLOP.md. */
export * from "./types.js";
export * from "./text.js";
export { AC_ID_PATTERN, DECISION_ID_PATTERN, FRONTMATTER_KEY_ORDER, GOAL_ID_PATTERN, ISO_TS_PATTERN, MESSAGE_ID_PATTERN, TASK_ID_PATTERN, SchemaError, budgetLimitsSchema, checkMessageShape, compactTs, configSchema, evidenceItemSchema, goalStateSchema, isMessageType, isoSeconds, kickoffFrontmatterSchema, messageSchema, messageSchemas, parseConfig, parseGoalState, parseKickoffFile, parseMessageFile, parseMessageId, partialBudgetsSchema, serializeMessageFile, splitFrontmatter, } from "./schema.js";
export { RULES, RULES_IN_ORDER, doneMissing, stateProblem } from "./rules.js";
export { allowedTypes, evidenceKey, newEvidenceKeys, openThreads, phaseAllows, roleAllows, roleOf, } from "./state.js";
export { assignId, evaluate, initialState, tick } from "./engine.js";
//# sourceMappingURL=index.js.map