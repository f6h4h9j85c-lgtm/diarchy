/** chat.md: docs/RENDERING.md section 2. Pure and byte-deterministic. */
import type { GoalState, Kickoff, Message } from "../../protocol/index.js";
import { type RenderOptions } from "./shared.js";
export declare function renderChat(messages: Message[], state: GoalState | null, kickoff: Kickoff, opts?: RenderOptions): string;
