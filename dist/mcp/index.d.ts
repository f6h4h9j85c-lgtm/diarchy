import type { AgentId } from "../protocol/index.js";
import { type ToolOutcome } from "./server.js";
export { SERVER_ERRORS, TOOL_NAMES, createMcpServer, type McpServerOptions, type ServerError, type ServerErrorCode, type ToolError, type ToolOutcome, } from "./server.js";
/**
 * Serve one agent over stdio and resolve when the transport closes (the client
 * ends stdin or the connection drops). stdout carries MCP frames only; the
 * server logs to stderr.
 */
export declare function runMcpServer(options: {
    projectDir: string;
    agent: AgentId;
    onResult?: (result: ToolOutcome) => void;
}): Promise<void>;
