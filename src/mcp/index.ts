/** diarchy-mcp: the MCP server over the vault store (docs/PROTOCOL.md section 10). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { AgentId } from "../protocol/index.js";
import { createMcpServer, type ToolOutcome } from "./server.js";

export {
  SERVER_ERRORS,
  TOOL_NAMES,
  createMcpServer,
  type McpServerOptions,
  type ServerError,
  type ServerErrorCode,
  type ToolError,
  type ToolOutcome,
} from "./server.js";

/**
 * Serve one agent over stdio and resolve when the transport closes (the client
 * ends stdin or the connection drops). stdout carries MCP frames only; the
 * server logs to stderr.
 */
export async function runMcpServer(options: { projectDir: string; agent: AgentId; onResult?: (result: ToolOutcome) => void }): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    const releaseLease = server.server.onclose;
    server.server.onclose = () => {
      releaseLease?.();
      resolve();
    };
  });
  process.stdin.once("end", () => void transport.close());
  await server.connect(transport);
  await closed;
}
