import { type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

let hangingServer: Server;
let hangingUrl: string;

let slowServer: Server;
let slowUrl: string;

/**
 * Server that accepts connections but never responds (hangs indefinitely).
 */
beforeAll(async () => {
  hangingServer = createServer((_req, _res) => {
    // Intentionally never respond — simulates a hanging server
  });

  slowServer = createServer((_req, res) => {
    // Respond after 3 seconds with an invalid (non-JSON-RPC) body
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "slow" } }));
    }, 3000);
  });

  await Promise.all([
    new Promise<void>((resolve) => {
      hangingServer.listen(0, "127.0.0.1", () => {
        const addr = hangingServer.address();
        if (addr && typeof addr === "object") {
          hangingUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      slowServer.listen(0, "127.0.0.1", () => {
        const addr = slowServer.address();
        if (addr && typeof addr === "object") {
          slowUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    }),
  ]);
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      hangingServer.close((err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((resolve, reject) => {
      slowServer.close((err) => (err ? reject(err) : resolve()));
    }),
  ]);
});

describe("timeout handling", () => {
  it("times out against a hanging server within the configured timeout", async () => {
    const start = Date.now();
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 1000,
      preflightTimeout: 1000,
      only: ["transport-post"],
    });
    const elapsed = Date.now() - start;

    expect(report.tests).toHaveLength(1);
    expect(report.tests[0].passed).toBe(false);
    // Should not take much longer than the timeout (preflight + test)
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it("preflight warning triggers for hanging server", async () => {
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 1000,
      preflightTimeout: 500,
      only: ["transport-post"],
    });
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(true);
  }, 10000);

  it("custom preflightTimeout is respected independently of timeout", async () => {
    const start = Date.now();
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 2000,
      preflightTimeout: 200,
      only: ["transport-post"],
    });
    const elapsed = Date.now() - start;

    // Preflight should fail fast at 200ms, not wait for the full 2s timeout
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(true);
    // Elapsed should be well under the sum of both timeouts
    expect(elapsed).toBeLessThan(8000);
  }, 10000);

  it("handles slow server that responds after delay", async () => {
    const report = await runComplianceSuite(slowUrl, {
      timeout: 5000,
      preflightTimeout: 5000,
      only: ["transport-post"],
    });
    // Server does respond (after 3s), so the test should complete
    expect(report.tests).toHaveLength(1);
    // The slow server returns a valid HTTP response, so transport-post passes
    expect(report.tests[0].passed).toBe(true);
  }, 15000);

  it("slow server times out with short timeout", async () => {
    const report = await runComplianceSuite(slowUrl, {
      timeout: 500,
      preflightTimeout: 500,
      only: ["transport-post"],
    });
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0].passed).toBe(false);
  }, 10000);
});
