import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { dedupAndCapWarnings, isHeaderToken, runComplianceSuite } from "../runner.js";

// Use localhost on a port that's definitely not listening for instant ECONNREFUSED
const DEAD_URL = "http://127.0.0.1:1/mcp";

describe("runComplianceSuite — input validation", () => {
  it("rejects non-HTTP URLs", async () => {
    await expect(runComplianceSuite("ftp://example.com")).rejects.toThrow("Only HTTP and HTTPS");
  });

  it("rejects invalid URLs", async () => {
    await expect(runComplianceSuite("not-a-url")).rejects.toThrow("Invalid URL");
  });

  it("rejects empty string", async () => {
    await expect(runComplianceSuite("")).rejects.toThrow("Invalid URL");
  });

  it("rejects file:// URLs", async () => {
    await expect(runComplianceSuite("file:///etc/passwd")).rejects.toThrow("Only HTTP and HTTPS");
  });

  it("rejects javascript: URLs", async () => {
    await expect(runComplianceSuite("javascript:alert(1)")).rejects.toThrow("Only HTTP and HTTPS");
  });

  it("rejects data: URLs", async () => {
    await expect(runComplianceSuite("data:text/html,test")).rejects.toThrow("Only HTTP and HTTPS");
  });
});

describe("runComplianceSuite — connection failures", () => {
  it("fails gracefully for unreachable host", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      timeout: 2000,
      only: ["transport-post", "transport-content-type", "transport-batch-reject"],
    });
    expect(report.grade).toBeDefined();
    expect(report.overall).toBe("fail");
    expect(report.tests.length).toBeGreaterThan(0);
    for (const t of report.tests) {
      expect(t.passed).toBe(false);
    }
  }, 15000);

  it("includes preflight warning for unreachable host", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      timeout: 2000,
      only: ["transport-post"],
    });
    const warning = report.warnings.find((w) => w.includes("unreachable"));
    expect(warning, JSON.stringify(report.warnings)).toBeDefined();
    // Names the connection error, and promises only what is true: the
    // tests that need the server fail (post-hoc scans over an empty
    // recording and security skips still pass vacuously).
    expect(warning).toMatch(
      /^Server at http:\/\/127\.0\.0\.1:1\/mcp is unreachable \(.*ECONNREFUSED[^)]*\) -- every test that needs the server will fail\./,
    );
    expect(warning).not.toContain("all tests will fail");
  }, 15000);
});

describe("runComplianceSuite — filtering", () => {
  it("only runs specified categories", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport"],
      timeout: 2000,
    });
    // Only transport tests should be present (plus lifecycle always runs for init)
    for (const t of report.tests) {
      expect(t.category).toBe("transport");
    }
  }, 30000);

  it("skips specified categories", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      skip: ["transport", "lifecycle", "tools", "resources", "prompts", "schema"],
      timeout: 2000,
    });
    // No transport or lifecycle tests
    const transportTests = report.tests.filter((t) => t.category === "transport");
    expect(transportTests).toHaveLength(0);
    const lifecycleTests = report.tests.filter((t) => t.category === "lifecycle");
    expect(lifecycleTests).toHaveLength(0);
  }, 30000);

  it("filters by test ID", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0].id).toBe("transport-post");
  }, 15000);
});

describe("runComplianceSuite — report structure", () => {
  it("includes all required report fields", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    expect(report.specVersion).toBe("2025-11-25");
    expect(report.toolVersion).toBeDefined();
    expect(report.url).toBe(DEAD_URL);
    expect(report.timestamp).toBeDefined();
    expect(typeof report.score).toBe("number");
    expect(["A", "B", "C", "D", "F"]).toContain(report.grade);
    expect(["pass", "partial", "fail"]).toContain(report.overall);
    expect(report.summary).toBeDefined();
    expect(report.categories).toBeDefined();
    expect(report.tests).toBeDefined();
    expect(report.warnings).toBeDefined();
    expect(report.serverInfo).toBeDefined();
    expect(report.badge).toBeDefined();
  }, 15000);

  it("each test has required fields", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post", "transport-content-type"],
      timeout: 2000,
    });
    for (const t of report.tests) {
      expect(t.id).toBeDefined();
      expect(t.name).toBeDefined();
      expect(t.category).toBeDefined();
      expect(typeof t.passed).toBe("boolean");
      expect(typeof t.required).toBe("boolean");
      expect(typeof t.details).toBe("string");
      expect(typeof t.durationMs).toBe("number");
      expect(t.specRef).toContain("modelcontextprotocol.io");
    }
  }, 15000);

  it("includes onProgress callbacks", async () => {
    const progressCalls: Array<{ testId: string; passed: boolean }> = [];
    await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
      onProgress: (testId, passed) => {
        progressCalls.push({ testId, passed });
      },
    });
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0].testId).toBe("transport-post");
    expect(typeof progressCalls[0].passed).toBe("boolean");
  }, 15000);

  it("tracks durationMs for each test", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    for (const t of report.tests) {
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 15000);
});

/**
 * A 2025-11-25 HTTP server that answers initialize with `protocolVersion`
 * and a session id, `ping` with {} whatever headers it carries, and 202s
 * notifications; records the method and the session / protocol-version
 * headers of every POST.
 */
async function startVersionStub(protocolVersion: string): Promise<{
  url: string;
  seen: Array<{ method: string; sessionId?: string; protocolVersion?: string }>;
  stop(): Promise<void>;
}> {
  const seen: Array<{ method: string; sessionId?: string; protocolVersion?: string }> = [];
  const server: Server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      text += c;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let msg: { id?: unknown; method?: string } = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      seen.push({
        method: msg.method ?? "?",
        sessionId: req.headers["mcp-session-id"] as string | undefined,
        protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
      });
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const body =
        msg.method === "initialize"
          ? {
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion, capabilities: {}, serverInfo: { name: "version-stub", version: "1" } },
            }
          : msg.method === "ping"
            ? { jsonrpc: "2.0", id: msg.id, result: {} }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "3f6c1a9e0b7d4e2f8a5c6b1d" });
      res.end(JSON.stringify(body));
    });
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    seen,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("runComplianceSuite — the negotiated protocol version on later requests", () => {
  const ONLY = ["lifecycle-init", "lifecycle-proto-version", "lifecycle-ping"];

  it("a version that cannot be a header value is left off the later requests; lifecycle-proto-version still reports it", async () => {
    // Before: the CR/LF value went into MCP-Protocol-Version and undici
    // refused every later request client-side, so lifecycle-ping (and every
    // other post-init test) failed with "Error: invalid mcp-protocol-version
    // header" against a server that answers ping, and the notification
    // never went out.
    const bad = "2025-11-25\r\nX-Injected: 1";
    const stub = await startVersionStub(bad);
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 3000, specVersion: "2025-11-25", only: ONLY });
      const byId = Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]));
      expect(byId["lifecycle-ping"]).toEqual({ passed: true, details: expect.any(String) });
      // Not hidden: the server's value is still what the version test judges.
      expect(byId["lifecycle-proto-version"]).toEqual({ passed: false, details: `Version: ${bad}` });
      expect(report.serverInfo.protocolVersion).toBe(bad);
      const afterInit = stub.seen.slice(stub.seen.findIndex((p) => p.method === "initialize") + 1);
      expect(afterInit.map((p) => p.method)).toEqual(["notifications/initialized", "ping"]);
      for (const p of afterInit) {
        expect(p).toEqual({ method: p.method, sessionId: "3f6c1a9e0b7d4e2f8a5c6b1d", protocolVersion: undefined });
      }
    } finally {
      await stub.stop();
    }
  }, 15000);

  it("a valid negotiated version is still carried on every later request", async () => {
    const stub = await startVersionStub("2025-06-18");
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 3000, specVersion: "2025-11-25", only: ONLY });
      expect(report.tests.find((t) => t.id === "lifecycle-ping")?.passed).toBe(true);
      const afterInit = stub.seen.slice(stub.seen.findIndex((p) => p.method === "initialize") + 1);
      expect(afterInit.map((p) => p.method)).toEqual(["notifications/initialized", "ping"]);
      for (const p of afterInit) {
        expect(p).toEqual({ method: p.method, sessionId: "3f6c1a9e0b7d4e2f8a5c6b1d", protocolVersion: "2025-06-18" });
      }
    } finally {
      await stub.stop();
    }
  }, 15000);
});

describe("isHeaderToken", () => {
  it("accepts a visible-ASCII token such as a date version", () => {
    expect(isHeaderToken("2025-11-25")).toBe(true);
    expect(isHeaderToken("draft/2026-07-28+x")).toBe(true);
  });

  it("rejects what cannot go out verbatim as a header value, and non-strings", () => {
    for (const value of [
      "",
      "2025-11-25\r\nX-Injected: 1",
      "2025-11-25\n",
      "2025 11 25",
      "2025-11-25\t",
      "2025-11-25\u00e9",
      "\u0000",
    ]) {
      expect(isHeaderToken(value), JSON.stringify(value)).toBe(false);
    }
    for (const value of [20251125, null, undefined, {}, ["2025-11-25"]]) {
      expect(isHeaderToken(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("runComplianceSuite — exports", () => {
  it("exports TEST_DEFINITIONS", async () => {
    const { TEST_DEFINITIONS } = await import("../runner.js");
    expect(Array.isArray(TEST_DEFINITIONS)).toBe(true);
    expect(TEST_DEFINITIONS.length).toBe(88);
    for (const def of TEST_DEFINITIONS) {
      expect(def.id).toBeDefined();
      expect(def.name).toBeDefined();
      expect(def.category).toBeDefined();
      expect(typeof def.required).toBe("boolean");
      expect(def.specRef).toBeDefined();
      expect(def.description).toBeDefined();
    }
  });

  it("exports computeGrade", async () => {
    const { computeGrade } = await import("../runner.js");
    expect(computeGrade(95)).toBe("A");
    expect(computeGrade(80)).toBe("B");
    expect(computeGrade(65)).toBe("C");
    expect(computeGrade(50)).toBe("D");
    expect(computeGrade(20)).toBe("F");
  });

  it("exports computeScore", async () => {
    const { computeScore } = await import("../runner.js");
    expect(typeof computeScore).toBe("function");
  });
});

describe("previewTests", () => {
  it("includes every test for HTTP", async () => {
    const { previewTests, TEST_DEFINITIONS } = await import("../runner.js");
    const http = previewTests({ transport: "http" });
    // HTTP excludes the 3 stdio-only tests
    expect(http.length).toBe(TEST_DEFINITIONS.length - 3);
  });

  it("excludes HTTP-specific tests for stdio", async () => {
    const { previewTests } = await import("../runner.js");
    const stdio = previewTests({ transport: "stdio" });
    const ids = stdio.map((t) => t.id);
    // Wire-format transport tests are skipped
    expect(ids).not.toContain("transport-post");
    expect(ids).not.toContain("transport-content-type");
    // The stdio-only tests are included
    expect(ids).toContain("stdio-framing");
    expect(ids).toContain("stdio-unicode");
    expect(ids).toContain("stdio-unknown-method-recovers");
    // HTTP-only error/security tests are skipped
    expect(ids).not.toContain("error-invalid-jsonrpc");
    expect(ids).not.toContain("security-tls-required");
  });

  it("respects --only and --skip filters", async () => {
    const { previewTests } = await import("../runner.js");
    const onlyLifecycle = previewTests({ transport: "http", only: ["lifecycle"] });
    expect(onlyLifecycle.every((t) => t.category === "lifecycle")).toBe(true);

    const skipSecurity = previewTests({ transport: "http", skip: ["security"] });
    expect(skipSecurity.some((t) => t.category === "security")).toBe(false);
  });
});

describe("dedupAndCapWarnings", () => {
  it("preserves order and drops exact duplicates", () => {
    const out = dedupAndCapWarnings(["a", "b", "a", "c", "b"], 50);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("leaves a list below the cap untouched (after dedup)", () => {
    const input = ["w1", "w2", "w3"];
    const out = dedupAndCapWarnings(input, 10);
    expect(out).toEqual(input);
  });

  it("caps and appends a truncation sentinel when over the limit", () => {
    const input = Array.from({ length: 60 }, (_, i) => `warn-${i}`);
    const out = dedupAndCapWarnings(input, 50);
    expect(out).toHaveLength(51);
    expect(out.slice(0, 50)).toEqual(input.slice(0, 50));
    expect(out[50]).toBe("... and 10 more warning(s) suppressed");
  });

  it("counts truncation against the deduped length, not the raw input", () => {
    // 10 uniques repeated 6 times = 60 entries → 10 after dedup → no cap
    const dup = Array.from({ length: 6 }, () => Array.from({ length: 10 }, (_, i) => `w${i}`)).flat();
    expect(dup).toHaveLength(60);
    const out = dedupAndCapWarnings(dup, 50);
    expect(out).toHaveLength(10);
    expect(out.some((w) => w.startsWith("..."))).toBe(false);
  });

  it("handles an empty input", () => {
    expect(dedupAndCapWarnings([], 50)).toEqual([]);
  });
});
