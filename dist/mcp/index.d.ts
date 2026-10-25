import type { AgentId } from "../protocol/index.js";
export { SERVER_ERRORS, TOOL_NAMES, createMcpServer, type McpServerOptions, type ServerError, type ServerErrorCode, type ToolError, } from "./server.js";
/**
 * Serve one agent over stdio and resolve when the transport closes (the client
 * ends stdin or the connection drops). stdout carries MCP frames only; the
 * server logs to stderr.
 */
export declare function runMcpServer(options: {
    projectDir: string;
    agent: AgentId;
}): Promise<void>;
