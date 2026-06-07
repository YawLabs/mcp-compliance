import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readPackageVersion } from "../pkg-version.js";
import { registerTools } from "./tools.js";

const version = readPackageVersion(import.meta.url);

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

// Direct execution support: when `node .../mcp/server.js` is invoked
// (or tsx during dev), boot the stdio server. We compare realpaths so
// symlinked node_modules layouts still match. We ALSO check the file's
// own basename — when tsup bundles this module into `dist/index.js`,
// `import.meta.url` is rewritten to point at the bundle, which would
// otherwise make this block fire a second time on top of the CLI's own
// bare-invocation path (src/index.ts), double-starting the server and
// corrupting stdio. Gating on `mcp/server.{js,ts}` scopes this boot to
// the standalone `dist/mcp/server.js` entry (used by the dogfood
// integration test) and `tsx src/mcp/server.ts` during dev.
function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    if (realpathSync(argv1) !== selfPath) return false;
    const file = basename(selfPath);
    const parent = basename(dirname(selfPath));
    return parent === "mcp" && (file === "server.js" || file === "server.ts");
  } catch {
    return false;
  }
}
if (isInvokedDirectly()) {
  startServer().catch((err) => {
    console.error("MCP server error:", err);
    process.exit(1);
  });
}
