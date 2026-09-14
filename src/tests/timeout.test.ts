import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

let hangingServer: Server;
let hangingUrl: string;

let slowServer: Server;
let slowUrl: string;

/**
 * A 2026-07-28 server whose FIRST reply takes `firstDelayMs` (a cold
 * start); every later reply is immediate. Answers any request with a
 * conformant DiscoverResult so the era probe classifies it as modern.
 */
function startSlowModernServer(firstDelayMs: number): Promise<{ server: Server; url: string; seen: () => number }> {
  let first = true;
  let requests = 0;
  const server = createServer((req: IncomingMessage, res) => {
    requests++;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      let id: unknown = null;
      try {
        id = (JSON.parse(body) as { id?: unknown }).id ?? null;
      } catch {}
      const delay = first ? firstDelayMs : 0;
      first = false;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: {},
              ttlMs: 0,
              cacheScope: "public",
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "slow-modern", version: "1" } },
            },
          }),
        );
      }, delay);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, seen: () => requests });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

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
      startupTimeout: 1000,
      preflightTimeout: 1000,
      only: ["transport-post"],
    });
    const elapsed = Date.now() - start;

    expect(report.tests).toHaveLength(1);
    expect(report.tests[0].passed).toBe(false);
    // Budget, each bounded by 1000ms: preflight, the era re-probe (auto
    // retries a preflight TIMEOUT once within startupTimeout), the one
    // test, then the legacy suite's always-on initialize + initialized.
    expect(elapsed).toBeLessThan(7000);
  }, 10000);

  it("preflight warning triggers for hanging server, worded as a timeout (preflight, then the era re-probe)", async () => {
    const status: string[] = [];
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 1000,
      startupTimeout: 1000,
      preflightTimeout: 500,
      only: ["transport-post"],
      onStatus: (m) => status.push(m),
    });
    const warning = report.warnings.find((w) => w.includes("unreachable"));
    expect(warning, JSON.stringify(report.warnings)).toBe(
      `Server at ${hangingUrl} did not answer the preflight within 500ms or the era probe within 1000ms; treating it as unreachable -- every test that needs the server will fail. A slow cold start needs a higher --preflight-timeout / --startup-timeout.`,
    );
    // Under auto the timeout is re-probed once with the startup budget, and
    // the status hook says so before the wait.
    expect(status).toEqual([
      "Preflight got no reply within 500ms; re-sending the era probe (server/discover, up to 1s) before defaulting to 2025-11-25.",
    ]);
    expect(report.specVersion).toBe("2025-11-25");
    expect(report.warnings.some((w) => w.includes("auto-detected"))).toBe(false);
  }, 10000);

  it("pinned run: a preflight timeout is reported as such and is NOT re-probed", async () => {
    const status: string[] = [];
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 500,
      startupTimeout: 1000,
      preflightTimeout: 300,
      specVersion: "2025-11-25",
      only: ["transport-post"],
      onStatus: (m) => status.push(m),
    });
    const warning = report.warnings.find((w) => w.includes("unreachable"));
    expect(warning, JSON.stringify(report.warnings)).toBe(
      `Server at ${hangingUrl} did not answer the preflight within 300ms; treating it as unreachable -- every test that needs the server will fail. A slow cold start needs a higher --preflight-timeout.`,
    );
    // The era is pinned, so there is no probe to retry and no status line.
    expect(status).toEqual([]);
    expect(report.tests[0].passed).toBe(false);
  }, 10000);

  it("custom preflightTimeout is respected independently of timeout", async () => {
    const start = Date.now();
    let reprobeAnnouncedAt = -1;
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 2000,
      startupTimeout: 2000,
      preflightTimeout: 200,
      only: ["transport-post"],
      // Fires the moment the preflight gives up, before the re-probe waits.
      onStatus: () => {
        reprobeAnnouncedAt = Date.now() - start;
      },
    });
    const elapsed = Date.now() - start;

    // Preflight should fail fast at 200ms, not wait for the full 2s timeout
    const warning = report.warnings.find((w) => w.includes("unreachable"));
    expect(warning).toContain("did not answer the preflight within 200ms");
    expect(reprobeAnnouncedAt).toBeGreaterThanOrEqual(200);
    expect(reprobeAnnouncedAt).toBeLessThan(1500);
    // Total: 200ms preflight + 2000ms x (re-probe, test, initialize, initialized).
    expect(elapsed).toBeLessThan(11000);
  }, 15000);

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
      startupTimeout: 500,
      preflightTimeout: 500,
      only: ["transport-post"],
    });
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0].passed).toBe(false);
  }, 10000);

  it("startupTimeout defaults higher than timeout to absorb slow cold starts", async () => {
    // slowServer responds after 3s. A 500ms per-request timeout would
    // normally fail the handshake, but the default startupTimeout is
    // max(timeout, 60000) — so the handshake gets to wait 60s. The
    // initialize does land successfully and an "initialize took longer
    // than --timeout" warning should be emitted.
    const report = await runComplianceSuite(slowUrl, {
      timeout: 500,
      preflightTimeout: 5000,
      only: ["transport-post", "lifecycle-init"],
    });
    // lifecycle-init saw a valid JSON-RPC response (slowServer returns
    // an error body — enough to advance past the handshake); the
    // warning about the per-request timeout mismatch should fire.
    expect(report.warnings.some((w) => w.includes("longer than --timeout"))).toBe(true);
  }, 15000);

  it("a modern server whose first reply outlasts preflightTimeout but not startupTimeout is still graded 2026-07-28", async () => {
    // The preflight IS the era probe on HTTP. Before the re-probe, a cold
    // modern server that missed the (short) preflight deadline was marked
    // unreachable and silently graded against the 2025-11-25 catalog --
    // while the same slowness on a legacy server was absorbed by
    // startupTimeout on `initialize`. Now the probe gets the same budget.
    const slow = await startSlowModernServer(1500);
    try {
      const status: string[] = [];
      const report = await runComplianceSuite(slow.url, {
        timeout: 5000,
        preflightTimeout: 500,
        startupTimeout: 10000,
        only: ["lifecycle-discover"],
        onStatus: (m) => status.push(m),
      });
      expect(report.specVersion).toBe("2026-07-28");
      expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
      expect(report.warnings).toContain(
        "Spec version auto-detected as 2026-07-28 (server/discover -> supportedVersions [2026-07-28]). Pin with --spec-version to override.",
      );
      expect(status).toEqual([
        "Preflight got no reply within 500ms; re-sending the era probe (server/discover, up to 10s) before defaulting to 2025-11-25.",
      ]);
      expect(report.tests).toHaveLength(1);
      expect(report.tests[0].id).toBe("lifecycle-discover");
      expect(report.tests[0].passed, report.tests[0].details).toBe(true);
      expect(report.serverInfo.name).toBe("slow-modern");
      // Preflight (aborted), the re-probe, then the suite's own discover.
      expect(slow.seen()).toBeGreaterThanOrEqual(2);
    } finally {
      await closeServer(slow.server);
    }
  }, 20000);

  it("the same slow modern server with a preflightTimeout above its cold start needs no re-probe", async () => {
    const slow = await startSlowModernServer(800);
    try {
      const status: string[] = [];
      const report = await runComplianceSuite(slow.url, {
        timeout: 5000,
        preflightTimeout: 3000,
        startupTimeout: 10000,
        only: ["lifecycle-discover"],
        onStatus: (m) => status.push(m),
      });
      expect(report.specVersion).toBe("2026-07-28");
      expect(status).toEqual([]);
      expect(report.tests[0].passed, report.tests[0].details).toBe(true);
    } finally {
      await closeServer(slow.server);
    }
  }, 20000);

  it("startupTimeout can be set shorter than default for fast-fail scenarios", async () => {
    // Explicit low startupTimeout makes the handshake fail fast instead
    // of waiting the default 60s. Regression-guard for the --startup-timeout
    // CLI path.
    const start = Date.now();
    const report = await runComplianceSuite(hangingUrl, {
      timeout: 500,
      startupTimeout: 500,
      preflightTimeout: 500,
      only: ["lifecycle-init"],
    });
    const elapsed = Date.now() - start;
    expect(report.tests[0].passed).toBe(false);
    expect(elapsed).toBeLessThan(5000);
  }, 10000);
});
