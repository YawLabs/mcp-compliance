#!/usr/bin/env node
/**
 * Legacy (2025-11-25) stdio MCP server that IGNORES every request received
 * before `initialize` -- `server/discover` included -- instead of answering
 * -32601 the way echo-server.mjs does. After `initialize` it behaves like
 * echo-server.mjs (ping, tools/list with `echo`, tools/call echo).
 *
 * Purpose: prove that `--spec-version auto` falls back to legacy on a probe
 * TIMEOUT, not only on a -32601 reply. The spec allows a legacy server to
 * "stay silent" on unknown pre-initialize traffic, so detection must cope.
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
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

  // Notifications (no id): nothing to answer.
  if (msg.id === undefined) return;

  if (msg.method === "initialize") {
    initialized = true;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy-silent-fixture", version: "0.0.1" },
      },
    });
    return;
  }

  // The whole point of this fixture: before the handshake, say nothing.
  if (!initialized) return;

  switch (msg.method) {
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
