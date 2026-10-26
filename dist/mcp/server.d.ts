import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AgentId, type Rejection } from "../protocol/index.js";
import { VaultStore } from "../vault/index.js";
export interface McpServerOptions {
    projectDir: string;
    agent: AgentId;
    /** Defaults to a VaultStore on `projectDir` for `agent`; tests inject one with a fake clock. */
    store?: VaultStore;
    now?: () => Date;
    /** Called after every tool call with the outcome; the CLI logs it to the diagnostics trail. A throw here is ignored. */
    onResult?: (result: ToolOutcome) => void;
}
/** What onResult reports about one tool call: never its arguments or its answer. */
export interface ToolOutcome {
    tool: (typeof TOOL_NAMES)[number];
    ok: boolean;
    /** The rejection's rule when ok is false. */
    rule?: string;
}
/** Error codes the server adds to the protocol's RuleId set (PROTOCOL.md section 10). */
export declare const SERVER_ERRORS: readonly ["NO_GOAL", "WRONG_TOOL", "AGENT_BUSY", "INTERNAL"];
export type ServerErrorCode = (typeof SERVER_ERRORS)[number];
export interface ServerError {
    ok: false;
    rule: ServerErrorCode;
    message: string;
}
export type ToolError = Rejection | ServerError;
export declare const TOOL_NAMES: readonly ["kickoff", "post", "read", "wait_for_reply", "decide", "assign", "status"];
export declare function createMcpServer(options: McpServerOptions): McpServer;
