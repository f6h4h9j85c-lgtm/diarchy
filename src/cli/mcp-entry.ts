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

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  let loaded: unknown;
  try {
    loaded = await import("../mcp/index.js");
  } catch (error) {
    throw new Error(`cannot load the diarchy MCP server module (src/mcp): ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const candidate = loaded as Partial<McpModule> | null;
  if (candidate === null || typeof candidate !== "object" || typeof candidate.runMcpServer !== "function") {
    throw new Error("the diarchy MCP server module does not export runMcpServer({ projectDir, agent }); rebuild with the mcp module in place");
  }
  await candidate.runMcpServer(options);
}
