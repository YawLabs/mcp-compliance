#!/usr/bin/env node
/**
 * Minimal spec-compliant stdio MCP server used by StdioTransport tests.
 * Reads newline-delimited JSON-RPC from stdin, writes responses to stdout.
 * Intentionally tiny — no MCP SDK dep — so tests stay fast and isolated.
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

let initialized = false;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.jsonrpc !== "2.0") return;

  // Handle notifications (no id)
  if (msg.id === undefined) {
    if (msg.method === "notifications/initialized") {
      // no-op, just acknowledge state transition
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      initialized = true;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "echo-fixture", version: "0.0.1" },
        },
      });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo a message",
              inputSchema: { type: "object", properties: { message: { type: "string" } } },
            },
          ],
        },
      });
      break;
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: String(msg.params?.arguments?.message ?? "") }],
        },
      });
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
});

rl.on("close", () => process.exit(0));
