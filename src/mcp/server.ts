import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// Walk up from the current file to find the package.json that owns us.
// This works whether we're running from src/ (via tsx), dist/mcp/server.js
// (standalone build), or bundled into dist/index.js.
function findPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(dir, "..", "..", "..");
  while (dir !== root) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
      } catch {
        return "0.0.0";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
const version = findPackageVersion();

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
