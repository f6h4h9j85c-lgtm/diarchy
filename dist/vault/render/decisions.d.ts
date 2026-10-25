/** decisions.md: docs/RENDERING.md section 3. Pure and byte-deterministic. */
import type { GoalState, Kickoff, Message } from "../../protocol/index.js";
/** decisions.md carries no budget or local-time hint, so it needs neither state nor options. */
export declare function renderDecisions(messages: Message[], _state: GoalState | null, kickoff: Kickoff): string;
