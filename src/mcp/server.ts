import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

/**
 * Create and configure the MCP compliance server instance.
 */
export function createComplianceServer(): McpServer {
  const server = new McpServer({ name: "mcp-compliance", version });
  registerTools(server);
  return server;
}

/**
 * Start the MCP compliance server with stdio transport.
 */
export async function startServer(): Promise<void> {
  const server = createComplianceServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Direct execution support
const isDirectRun = process.argv[1]?.endsWith("mcp/server.js") || process.argv[1]?.endsWith("mcp\\server.js");
if (isDirectRun) {
  startServer().catch((err) => {
    console.error("MCP server error:", err);
    process.exit(1);
  });
}
