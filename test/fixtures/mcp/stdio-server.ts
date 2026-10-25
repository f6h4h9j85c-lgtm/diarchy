/**
 * Child process for the stdio smoke test: serves diarchy-mcp as `agent` over
 * stdin/stdout against the project in `projectDir`, exiting when stdin closes.
 *
 *   node --import tsx test/fixtures/mcp/stdio-server.ts <projectDir> <agent>
 */
import { runMcpServer } from "../../../src/mcp/index.js";

const [projectDir, agent] = process.argv.slice(2);
if (projectDir === undefined || agent === undefined) {
  console.error("usage: stdio-server.ts <projectDir> <agent>");
  process.exit(2);
}

await runMcpServer({ projectDir, agent });
