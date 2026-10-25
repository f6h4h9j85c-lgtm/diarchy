/**
 * `diarchy mcp --agent <id>`: start the stdio MCP server from `src/mcp`.
 *
 * The server module is loaded dynamically and checked at runtime against the
 * shape below, so the CLI builds and runs even when the module is absent or
 * incomplete, and fails with a clear message instead of a stack trace.
 */
export interface McpServerOptions {
    projectDir: string;
    agent: string;
}
/** What `src/mcp/index.ts` is expected to export. */
export interface McpModule {
    runMcpServer(options: McpServerOptions): Promise<void>;
}
export declare function startMcpServer(options: McpServerOptions): Promise<void>;
