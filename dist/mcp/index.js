/** diarchy-mcp: the MCP server over the vault store (docs/PROTOCOL.md section 10). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
export { SERVER_ERRORS, TOOL_NAMES, createMcpServer, } from "./server.js";
/**
 * Serve one agent over stdio and resolve when the transport closes (the client
 * ends stdin or the connection drops). stdout carries MCP frames only; the
 * server logs to stderr.
 */
export async function runMcpServer(options) {
    const server = createMcpServer(options);
    const transport = new StdioServerTransport();
    const closed = new Promise((resolve) => {
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
//# sourceMappingURL=index.js.map