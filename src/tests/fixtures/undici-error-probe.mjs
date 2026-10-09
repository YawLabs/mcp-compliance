/**
 * Prints, as one JSON line, how `request` from the bare "undici" specifier
 * rejects in three no-response cases the security checks have to tell apart:
 *
 *   refused   nothing listens on the port                -> "connect"
 *   dropped   the server accepts, reads, and closes      -> "dropped"
 *   timeout   the server accepts and never answers       -> "timeout"
 *
 * Each entry is `{ code, name, message }` off the rejection -- the three
 * fields classifyTransportError (src/suites/modern/security.ts) reads.
 *
 * Run under BOTH runtimes by oam-runtime.integration.test.ts. On Node the
 * specifier resolves to node_modules/undici; on oam it is oam's built-in shim
 * even when the npm package is installed (oam docs/node-divergences.md), which
 * is exactly why the classification has to be checked on oam itself. The file
 * lives in the repo, not a temp dir, so Node can resolve node_modules/undici.
 */
import { createServer } from "node:net";
import { request } from "undici";

const TIMEOUT_MS = 500;

function listen(onConnection) {
  return new Promise((resolve) => {
    const server = createServer(onConnection);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function attempt(url) {
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body.text();
    return { resolved: res.statusCode };
  } catch (err) {
    return {
      code: typeof err?.code === "string" ? err.code : null,
      name: typeof err?.name === "string" ? err.name : null,
      message: String(err?.message ?? err),
    };
  }
}

const out = {};

// refused: bind a port, close it, then dial it.
const closed = await listen(() => {});
const closedPort = closed.address().port;
await new Promise((resolve) => closed.close(resolve));
out.refused = await attempt(`http://127.0.0.1:${closedPort}/mcp`);

// dropped: accept, wait for the request bytes, then end the connection.
const dropper = await listen((socket) => {
  socket.once("data", () => socket.end());
  socket.on("error", () => {});
});
out.dropped = await attempt(`http://127.0.0.1:${dropper.address().port}/mcp`);
dropper.close();

// timeout: accept and hold the connection open without a byte of response.
const held = [];
const silent = await listen((socket) => {
  held.push(socket);
  socket.on("error", () => {});
});
out.timeout = await attempt(`http://127.0.0.1:${silent.address().port}/mcp`);
for (const socket of held) socket.destroy();
silent.close();

process.stdout.write(`${JSON.stringify(out)}\n`);
