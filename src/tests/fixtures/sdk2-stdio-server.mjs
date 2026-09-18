#!/usr/bin/env node
/**
 * Reference stdio server built on the official SDK v2
 * (`@modelcontextprotocol/server@2.0.0`), served through `serveStdio` so the
 * SDK -- not this file -- owns the era decision: a `server/discover` opening
 * pins the connection modern (2026-07-28), an `initialize` opening pins it
 * legacy (2025-11-25) unless SDK2_LEGACY=reject, in which case the legacy
 * opening is answered with the unsupported-protocol-version error.
 *
 * The surface (echo tool, hello resource, greeting prompt) mirrors the
 * factory in src/tests/integration-sdk2.test.ts; keep the two in sync.
 * This is a test fixture only -- it is never shipped.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

function factory() {
  const mcp = new McpServer({ name: "sdk2-stdio-server", version: "2.0.0" });

  mcp.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes back the input",
      inputSchema: z.object({ message: z.string().optional().describe("Message to echo") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: String(message ?? "no message") }],
    }),
  );

  mcp.registerResource(
    "hello",
    "file:///test/hello.txt",
    { title: "Hello", description: "A static greeting", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: "Hello, world!" }],
    }),
  );

  mcp.registerPrompt("greeting", { title: "Greeting", description: "A simple greeting prompt" }, async () => ({
    messages: [{ role: "user", content: { type: "text", text: "Hello!" } }],
  }));

  return mcp;
}

const legacy = process.env.SDK2_LEGACY === "reject" ? "reject" : "serve";

serveStdio(factory, {
  legacy,
  onerror: (err) => {
    process.stderr.write(`[sdk2-stdio-server] ${err.message}\n`);
  },
});
