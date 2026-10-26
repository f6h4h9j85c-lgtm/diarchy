/** goal.md: docs/RENDERING.md section 4. Pure and byte-deterministic. */
import { type GoalState, type Kickoff, type Message } from "../../protocol/index.js";
import { type RenderOptions } from "./shared.js";
export declare function renderGoal(messages: Message[], state: GoalState | null, kickoff: Kickoff, opts?: RenderOptions): string;
