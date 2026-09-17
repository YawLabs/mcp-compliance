import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dedupAndCapWarnings, filterWarnings, isHeaderToken, previewTests, runComplianceSuite } from "../runner.js";

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

  it("a mistyped --skip value is named in the report's warnings", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      specVersion: "2025-11-25",
      only: ["transport-post"],
      skip: ["lifecycle-inti"],
      timeout: 2000,
    });
    expect(report.warnings).toContain(
      'Filter value(s) "lifecycle-inti" match no test id or category in the 2025-11-25 catalog; run --list --spec-version 2025-11-25 to see valid ids.',
    );
  }, 15000);
});

describe("filterWarnings", () => {
  it("names a --skip value that matches no test id or category", () => {
    expect(filterWarnings("2025-11-25", "http", undefined, ["lifecycle-inti"])).toEqual([
      'Filter value(s) "lifecycle-inti" match no test id or category in the 2025-11-25 catalog; run --list --spec-version 2025-11-25 to see valid ids.',
    ]);
  });

  it("valid --skip ids and categories draw no warning", () => {
    expect(filterWarnings("2026-07-28", "stdio", undefined, ["security", "lifecycle-discover"])).toEqual([]);
    expect(filterWarnings("2025-11-25", "http", undefined, ["transport", "lifecycle-init"])).toEqual([]);
  });

  it("names the --only and --skip misses together, --only first, against the resolved catalog", () => {
    // lifecycle-init exists only in 2025-11-25.
    expect(filterWarnings("2026-07-28", "http", ["tools", "tool-list"], ["lifecycle-init"])).toEqual([
      'Filter value(s) "tool-list", "lifecycle-init" match no test id or category in the 2026-07-28 catalog; run --list --spec-version 2026-07-28 to see valid ids.',
    ]);
  });

  it("2026-07-28 on stdio: an --only id every definition gates to HTTP is named as http-only", () => {
    // "security" also matches tests that run on stdio, so only the id is named.
    expect(filterWarnings("2026-07-28", "stdio", ["transport-header-version-required", "security"], undefined)).toEqual(
      [
        'Filter value(s) "transport-header-version-required" match only tests that do not apply to a stdio target (http-only), so they select nothing here; run --list --transport stdio --spec-version 2026-07-28 to see the ids that apply.',
      ],
    );
  });

  it("2026-07-28 on HTTP: a stdio-only --only id is named as stdio-only", () => {
    expect(filterWarnings("2026-07-28", "http", ["stdio-framing"], undefined)).toEqual([
      'Filter value(s) "stdio-framing" match only tests that do not apply to a http target (stdio-only), so they select nothing here; run --list --transport http --spec-version 2026-07-28 to see the ids that apply.',
    ]);
  });

  it("2026-07-28 gates by the definitions alone: ids the 2025-11-25 suite keeps off stdio in code are not flagged there", () => {
    // In 2025-11-25 the transport category and STDIO_INCOMPATIBLE_IDS are
    // HTTP-only on stdio; in 2026-07-28 only `transports` decides, and these
    // three carry none, so they run (and --list lists them) on stdio.
    const ids = ["transport-no-server-requests", "lifecycle-progress-token", "lifecycle-string-id"];
    expect(filterWarnings("2026-07-28", "stdio", ids, undefined)).toEqual([]);
    expect(
      previewTests({ transport: "stdio", specVersion: "2026-07-28", only: ids })
        .map((d) => d.id)
        .sort(),
    ).toEqual([...ids].sort());
    expect(filterWarnings("2025-11-25", "stdio", ["lifecycle-progress-token"], undefined)).toEqual([
      'Filter value(s) "lifecycle-progress-token" match only tests that do not apply to a stdio target (http-only), so they select nothing here; run --list --transport stdio --spec-version 2025-11-25 to see the ids that apply.',
    ]);
  });
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

/** One POST a {@link startLegacyStub} server received. */
interface StubHit {
  method: string;
  url: string;
  authorization?: string;
  apiKey?: string;
  sessionId?: string;
}

const STUB_SESSION = "9b2e4c7a1f3d4e8b";

/**
 * A 2025-11-25 HTTP server with one string-param tool, `shell(cmd)`, for the
 * legacy security checks that need a server to misbehave:
 *
 * - `gateway`: a gateway in front of it that 403s any request without
 *   `X-Api-Key: <apiKey>` and 401s one without the bearer `token`, taken
 *   from the Authorization header or, when `queryToken`, the `access_token`
 *   query parameter as well; ping and tools/* also need the session id.
 * - `toolCall`: `"executes"` answers like a tool that hands `cmd` to a
 *   shell (the command's output, not the payload); `"invalid-params"`
 *   answers every tools/call with a JSON-RPC -32602 error; `"http-500"`
 *   answers it with HTTP 500 and a JSON-RPC -32603 error (a tool handler
 *   that crashes into the framework's error page).
 *
 * Records every POST.
 */
async function startLegacyStub(opts: {
  gateway?: { apiKey: string; token: string; queryToken: boolean };
  toolCall?: "executes" | "invalid-params" | "http-500";
}): Promise<{ url: string; hits: StubHit[]; stop(): Promise<void> }> {
  const SHELL_OUTPUT: Record<string, string> = {
    "; cat /etc/passwd": "root:x:0:0:root:/root:/bin/bash",
    "$(whoami)": "root",
    "| ls -la": "total 8 drwxr-xr-x 2 root root 4096 Sep 14 09:00 .",
    "`id`": "uid=0(root) gid=0(root) groups=0(root)",
    "&& echo pwned": "pwned",
  };
  const hits: StubHit[] = [];
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
      let msg: { id?: unknown; method?: string; params?: { arguments?: { cmd?: string } } } = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      const hit: StubHit = {
        method: msg.method ?? "?",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        sessionId: req.headers["mcp-session-id"] as string | undefined,
      };
      hits.push(hit);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const gw = opts.gateway;
      if (gw) {
        if (hit.apiKey !== gw.apiKey) {
          json(403, { error: "missing or unknown API key" });
          return;
        }
        const queryToken = new URL(hit.url, "http://stub").searchParams.get("access_token");
        const authorized = hit.authorization === `Bearer ${gw.token}` || (gw.queryToken && queryToken === gw.token);
        if (!authorized) {
          json(
            401,
            { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
            { "www-authenticate": 'Bearer error="invalid_token"' },
          );
          return;
        }
      }
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const reply = (body: Record<string, unknown>) =>
        json(200, { jsonrpc: "2.0", id: msg.id, ...body }, { "mcp-session-id": STUB_SESSION });
      if (msg.method === "initialize") {
        reply({
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "legacy-stub", version: "1" },
          },
        });
        return;
      }
      const needsSession = msg.method === "ping" || msg.method?.startsWith("tools/");
      if (gw && needsSession && hit.sessionId !== STUB_SESSION) {
        json(400, { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Bad Request: no valid session" } });
        return;
      }
      if (msg.method === "ping") {
        reply({ result: {} });
      } else if (msg.method === "tools/list") {
        reply({
          result: {
            tools: [
              {
                name: "shell",
                description: "Runs a command",
                inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
              },
            ],
          },
        });
      } else if (msg.method === "tools/call" && opts.toolCall === "executes") {
        const cmd = msg.params?.arguments?.cmd ?? "";
        reply({ result: { content: [{ type: "text", text: SHELL_OUTPUT[cmd] ?? "" }] } });
      } else if (msg.method === "tools/call" && opts.toolCall === "invalid-params") {
        reply({ error: { code: -32602, message: "Invalid params: cmd must match ^[a-z]+$" } });
      } else if (msg.method === "tools/call" && opts.toolCall === "http-500") {
        json(500, { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
      } else {
        reply({ error: { code: -32601, message: "Method not found" } });
      }
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
    hits,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("runComplianceSuite — legacy injection checks judge the tool's output", () => {
  // tools-list discovers the tool the injection tests target.
  const ONLY = ["tools-list", "security-command-injection"];

  it("a tool whose output is the executed command's (not the payload echoed) FAILS, naming each payload and its output", async () => {
    const stub = await startLegacyStub({ toolCall: "executes" });
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 3000, specVersion: "2025-11-25", only: ONLY });
      const t = report.tests.find((x) => x.id === "security-command-injection");
      expect(t?.passed).toBe(false);
      // "$(whoami)" -> "root" is no execution evidence the detector knows.
      expect(t?.details).toBe(
        [
          'Payload "; cat /etc/passwd" appears to have executed (output: root:x:0:0:root:/root:/bin/bash)',
          'Payload "| ls -la" appears to have executed (output: total 8 drwxr-xr-x 2 root root 4096 Sep 14 09:00 .)',
          'Payload "`id`" appears to have executed (output: uid=0(root) gid=0(root) groups=0(root))',
          'Payload "&& echo pwned" appears to have executed (output: pwned)',
        ].join("; "),
      );
      expect(stub.hits.filter((h) => h.method === "tools/call")).toHaveLength(5);
    } finally {
      await stub.stop();
    }
  }, 15000);

  it("a tool that answers every payload with a JSON-RPC invalid-params error defended itself: PASS", async () => {
    const stub = await startLegacyStub({ toolCall: "invalid-params" });
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 3000, specVersion: "2025-11-25", only: ONLY });
      const t = report.tests.find((x) => x.id === "security-command-injection");
      expect({ passed: t?.passed, details: t?.details }).toEqual({
        passed: true,
        details: "Tested 5 payloads against shell.cmd — server defended (rejected or sanitized)",
      });
      expect(stub.hits.filter((h) => h.method === "tools/call")).toHaveLength(5);
    } finally {
      await stub.stop();
    }
  }, 15000);
});

describe("runComplianceSuite — legacy security-token-in-uri", () => {
  const gateway = { apiKey: "gw-7c1e", token: "tok-9f2a", queryToken: true };
  const headers = { Authorization: `Bearer ${gateway.token}`, "X-Api-Key": gateway.apiKey };

  it("FAILS a server that accepts the token from ?access_token=; the probe carries the -H headers and the session, not Authorization", async () => {
    const stub = await startLegacyStub({ gateway });
    try {
      const report = await runComplianceSuite(stub.url, {
        headers,
        timeout: 3000,
        specVersion: "2025-11-25",
        only: ["security-token-in-uri"],
      });
      const t = report.tests.find((x) => x.id === "security-token-in-uri");
      expect({ passed: t?.passed, details: t?.details }).toEqual({
        passed: false,
        details: "Server accepted auth token in query string (spec: MUST NOT transmit credentials in URIs)",
      });
      // The gateway key and the session are what get the probe to the token
      // check; without either, the 403/400 would read as "not accepted" and
      // this server would wrongly PASS.
      expect(stub.hits.filter((h) => h.url.includes("access_token="))).toEqual([
        {
          method: "ping",
          url: `/mcp?access_token=${gateway.token}`,
          authorization: undefined,
          apiKey: gateway.apiKey,
          sessionId: STUB_SESSION,
        },
      ]);
    } finally {
      await stub.stop();
    }
  }, 15000);

  it("the same gateway ignoring the query parameter answers 401, which PASSES", async () => {
    const stub = await startLegacyStub({ gateway: { ...gateway, queryToken: false } });
    try {
      const report = await runComplianceSuite(stub.url, {
        headers,
        timeout: 3000,
        specVersion: "2025-11-25",
        only: ["security-token-in-uri"],
      });
      const t = report.tests.find((x) => x.id === "security-token-in-uri");
      expect({ passed: t?.passed, details: t?.details }).toEqual({
        passed: true,
        details: "HTTP 401 (token in query string rejected)",
      });
    } finally {
      await stub.stop();
    }
  }, 15000);
});

/**
 * An SDK v1 sessionful Streamable HTTP server (the shape integration.test.ts
 * runs) whose one tool, `count`, takes no arguments and records the
 * `_meta.progressToken` each call carried. With `progress`, a call that
 * carried a token first sends two notifications/progress for it, which the
 * SDK streams on that request's SSE response ahead of the result.
 */
async function startSdkProgressServer(progress: boolean): Promise<{
  url: string;
  tokens: unknown[];
  stop(): Promise<void>;
}> {
  const tokens: unknown[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server: Server = createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const known = sessionId ? transports.get(sessionId) : undefined;
    if (known) {
      await known.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(sessionId ? 404 : 405);
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcp = new McpServer({ name: "sdk-progress", version: "1.0.0" });
    mcp.tool("count", "Counts to two", async (extra) => {
      const token = extra._meta?.progressToken;
      tokens.push(token);
      if (progress && token !== undefined) {
        for (const n of [1, 2]) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: n, total: 2 },
          });
        }
      }
      return { content: [{ type: "text", text: "2" }] };
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    tokens,
    stop: async () => {
      for (const t of transports.values()) await t.close().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe("runComplianceSuite — legacy lifecycle-progress-token", () => {
  // tools-list discovers the tool the progress-token test calls.
  const ONLY = ["tools-list", "lifecycle-progress-token"];
  const run = (url: string) => runComplianceSuite(url, { timeout: 5000, specVersion: "2025-11-25", only: ONLY });
  const progressToken = (report: Awaited<ReturnType<typeof run>>) => {
    const t = report.tests.find((x) => x.id === "lifecycle-progress-token");
    return { passed: t?.passed, details: t?.details };
  };

  it("an SDK v1 server's tool is called with the token, and the progress it streams is seen", async () => {
    // The probe used to send Accept: text/event-stream alone. The SDK
    // answers that with 406 before the tool runs, and the test reported
    // "HTTP 406 — request with progressToken accepted".
    const sdk = await startSdkProgressServer(true);
    try {
      const report = await run(sdk.url);
      expect(progressToken(report)).toEqual({
        passed: true,
        details: "Server sent progress notifications via SSE with progressToken",
      });
      expect(sdk.tokens).toEqual(["compliance-progress-test"]);
    } finally {
      await sdk.stop();
    }
  }, 15000);

  it("an SDK v1 tool that reports no progress: served, and the details say none was observed", async () => {
    const sdk = await startSdkProgressServer(false);
    try {
      const report = await run(sdk.url);
      expect(progressToken(report)).toEqual({
        passed: true,
        details: "Server accepted request with progressToken (no progress events observed — optional)",
      });
      expect(sdk.tokens).toEqual(["compliance-progress-test"]);
    } finally {
      await sdk.stop();
    }
  }, 15000);

  it("an HTTP error on the tools/call is not reported as accepted", async () => {
    const stub = await startLegacyStub({ toolCall: "http-500" });
    try {
      const report = await run(stub.url);
      // Optional and informational: still a pass, but the details say the
      // call was not served instead of claiming it was accepted.
      expect(progressToken(report)).toEqual({
        passed: true,
        details: "HTTP 500 — tools/call with progressToken was not served (no progress events observed — optional)",
      });
      expect(stub.hits.filter((h) => h.method === "tools/call")).toHaveLength(1);
    } finally {
      await stub.stop();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// Legacy security-auth-required and security-oversized-input: what a bare
// 403, a request that got no HTTP answer, a 5xx and a stdio child's exit
// say -- and what they do not.
// ---------------------------------------------------------------------------

/** One POST a {@link startSecurityStub} server received. */
interface SecurityHit {
  method: string;
  authorization?: string;
  bytes: number;
}

interface SecurityStubOptions {
  /**
   * When set, a request that does not carry `Authorization: Bearer <token>`
   * is answered by `noAuth` instead of the server: a bare 403 (a JSON-RPC
   * -32000 body, no WWW-Authenticate -- a gateway, or Host/Origin
   * validation), a 403 or 401 carrying a Bearer challenge, a connection
   * closed without an answer, or no answer at all.
   */
  token?: string;
  noAuth?: "bare-403" | "bearer-403" | "401" | "drop" | "hang";
  /** The JSON-RPC error message of every bare 403 the stub sends ("Forbidden" by default). */
  bare403Message?: string;
  /** A gateway method policy that answers server/discover (the preflight) with a bare 403, credential or not. */
  discover403?: boolean;
  /**
   * The gate lets `initialize` through without the token (a deployment
   * that exempts the handshake): every other method still draws `noAuth`.
   */
  openInitialize?: boolean;
  /** Whether the initialize response carries an Mcp-Session-Id (the session the session-only probe reuses). */
  session?: boolean;
  /** How a SECOND initialize is answered: like the first by default. */
  reinit?: "drop" | "hang";
  /** How a request carrying an Origin header is answered: like any other by default. */
  foreignOrigin?: "drop" | "hang";
  /** Called when a request without the token reaches the `noAuth` gate. */
  onNoAuth?: () => void;
  /** How a ping that carries the token is answered: served by default. */
  authedPing?: "drop" | "bare-403";
  /** How the ~1 MB tools/call is answered: a result by default. */
  bigCall?:
    | 413
    | 400
    | 500
    | "rpc-error"
    | "html"
    | "hang"
    | "drop"
    | "not-http"
    /** A rate limiter answering every ~1 MB call 429 (Retry-After: 0), or only the first one. */
    | 429
    | "429-once"
    /** A 401 with a Bearer invalid_token challenge: a credential that expired mid-run. */
    | 401
    /** A bare 403 (no challenge): a WAF rule blocking the body. */
    | "bare-403";
  /** Called when the ~1 MB tools/call arrives, before it is answered. */
  onBigCall?: () => void;
  /**
   * Once the big call was dropped, how every later request is answered:
   * served by default; "die" stops listening; "401" / "bare-403" is a gate
   * now refusing; "429-then-serve" / "429-twice" throttles one or two
   * requests (Retry-After: 0) and then serves; "502" is a proxy whose
   * backend went away; "ping-rpc-error" answers a ping 200 with a JSON-RPC
   * -32601 carrying its id (a live server that does not implement ping);
   * "session-404" answers every request 404 with an id-null -32001 "Session
   * not found" (a server that restarted and lost the session).
   */
  afterDrop?: "die" | "401" | "bare-403" | "429-then-serve" | "429-twice" | "502" | "ping-rpc-error" | "session-404";
}

/**
 * A 2025-11-25 HTTP server with one tool, `sink(data)`, for the auth and
 * oversized-input checks: a gate in front of it (`token` / `noAuth` /
 * `authedPing`) and knobs for how the ~1 MB tools/call and what follows it
 * are answered. Records every POST.
 */
async function startSecurityStub(
  opts: SecurityStubOptions,
): Promise<{ url: string; hits: SecurityHit[]; stop(): Promise<void> }> {
  const hits: SecurityHit[] = [];
  let dropped = false;
  let initializes = 0;
  let throttles = opts.afterDrop === "429-twice" ? 2 : opts.afterDrop === "429-then-serve" ? 1 : 0;
  let bigThrottles = opts.bigCall === "429-once" ? 1 : opts.bigCall === 429 ? Number.POSITIVE_INFINITY : 0;
  const bare403Message = opts.bare403Message ?? "Forbidden";
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let msg: { id?: unknown; method?: string } = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      hits.push({ method: msg.method ?? "?", authorization: req.headers.authorization, bytes: text.length });
      const send = (status: number, body: string, headers: Record<string, string>) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        send(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
      const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
        json(status, { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } }, headers);
      if (dropped) {
        switch (opts.afterDrop) {
          case "401":
            return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer error="invalid_token"' });
          case "bare-403":
            return rpcError(403, -32000, "Blocked");
          case "session-404":
            return json(404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
          case "ping-rpc-error":
            if (msg.method === "ping") return rpcError(200, -32601, "Method not found");
            break;
          case "502":
            return send(502, "<h1>502 Bad Gateway</h1>", { "content-type": "text/html" });
          case "429-then-serve":
          case "429-twice":
            if (throttles > 0) {
              throttles--;
              return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
            }
        }
      }
      if (opts.discover403 && msg.method === "server/discover") {
        return rpcError(403, -32000, "Method not allowed by gateway policy");
      }
      if (opts.foreignOrigin && req.headers.origin !== undefined) {
        if (opts.foreignOrigin === "drop") return req.socket.destroy();
        return;
      }
      if (
        opts.token &&
        req.headers.authorization !== `Bearer ${opts.token}` &&
        !(opts.openInitialize && msg.method === "initialize")
      ) {
        opts.onNoAuth?.();
        switch (opts.noAuth) {
          case "bare-403":
            return rpcError(403, -32000, bare403Message);
          case "bearer-403":
            return json(403, { error: "forbidden" }, { "www-authenticate": 'Bearer realm="mcp"' });
          case "401":
            return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="mcp"' });
          case "drop":
            return req.socket.destroy();
          case "hang":
            return;
        }
      }
      if (msg.id === undefined) return send(202, "", {});
      const reply = (body: Record<string, unknown>) => json(200, { jsonrpc: "2.0", id: msg.id, ...body });
      switch (msg.method) {
        case "initialize": {
          initializes++;
          if (initializes > 1 && opts.reinit) {
            if (opts.reinit === "drop") return req.socket.destroy();
            return;
          }
          return json(
            200,
            {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "security-stub", version: "1" },
              },
            },
            opts.session ? { "mcp-session-id": "sess-7c41f2a9b3d6" } : {},
          );
        }
        case "ping":
          if (opts.token && opts.authedPing === "drop") return req.socket.destroy();
          if (opts.token && opts.authedPing === "bare-403") return rpcError(403, -32000, bare403Message);
          return reply({ result: {} });
        case "tools/list":
          return reply({
            result: {
              tools: [
                {
                  name: "sink",
                  description: "Stores a value",
                  inputSchema: { type: "object", properties: { data: { type: "string" } } },
                },
              ],
            },
          });
        case "tools/call": {
          if (text.length < 500_000) return reply({ result: { content: [{ type: "text", text: "stored" }] } });
          opts.onBigCall?.();
          if (bigThrottles > 0) {
            bigThrottles--;
            return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
          }
          switch (opts.bigCall) {
            case 401:
              return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer error="invalid_token"' });
            case "bare-403":
              return rpcError(403, -32000, "Request blocked");
            case 413:
              return rpcError(413, -32600, "Payload Too Large");
            case 400:
              return rpcError(400, -32600, "Bad Request");
            case 500:
              return rpcError(500, -32603, "Internal error");
            case "rpc-error":
              return reply({ error: { code: -32602, message: "data is too long" } });
            case "html":
              return send(200, "<html><body>ok</body></html>", { "content-type": "text/html" });
            case "hang":
              return;
            case "not-http":
              // A broken proxy or a handler writing to the raw socket.
              return req.socket.end("NOT-HTTP garbage\r\n\r\n");
            case "drop":
              dropped = true;
              if (opts.afterDrop === "die") {
                server.close();
                server.closeAllConnections();
              }
              return req.socket.destroy();
          }
          return reply({ result: { content: [{ type: "text", text: "stored" }] } });
        }
        default:
          return reply({ error: { code: -32601, message: "Method not found" } });
      }
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
    hits,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        // A "die" stub has already stopped listening; close() then reports that, which is fine.
        server.close(() => resolve());
      }),
  };
}

type Verdict = { passed: boolean | undefined; details: string | undefined };

function verdictOf(report: { tests: { id: string; passed: boolean; details: string }[] }, id: string): Verdict {
  const t = report.tests.find((x) => x.id === id);
  return { passed: t?.passed, details: t?.details };
}

describe("runComplianceSuite — legacy security-auth-required reads a bare 403 and an unanswered probe", () => {
  const ID = "security-auth-required";
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  async function authRequired(stubOpts: SecurityStubOptions, runOpts: { auth: boolean; timeout?: number }) {
    const stub = await startSecurityStub({ token: TOKEN, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: runOpts.timeout ?? 3000,
        specVersion: "2025-11-25",
        only: [ID],
        ...(runOpts.auth ? { headers: AUTH } : {}),
      });
      return { verdict: verdictOf(report, ID), hits: stub.hits, report };
    } finally {
      await stub.stop();
    }
  }

  it("--auth: a 401, or a 403 carrying a Bearer challenge, on the unauthenticated ping passes as today", async () => {
    const unauthorized = await authRequired({ noAuth: "401" }, { auth: true });
    expect(unauthorized.verdict).toEqual({ passed: true, details: "HTTP 401 (unauthenticated request rejected)" });
    const challenged = await authRequired({ noAuth: "bearer-403" }, { auth: true });
    expect(challenged.verdict).toEqual({ passed: true, details: "HTTP 403 (unauthenticated request rejected)" });
    // No comparison ping is needed when the refusal reads as an auth rejection.
    expect(challenged.hits.filter((h) => h.method === "ping").map((h) => h.authorization)).toEqual([undefined]);
  }, 20_000);

  it("--auth: a bare 403 that the same ping with the credential gets past passes, with the 401 the spec expects", async () => {
    // Before: "HTTP 403 (unauthenticated request rejected)" without looking
    // at whether the credential was what made the difference.
    const { verdict, hits } = await authRequired({ noAuth: "bare-403" }, { auth: true });
    expect(verdict).toEqual({
      passed: true,
      details:
        "HTTP 403 (unauthenticated request rejected; the same ping with the credential was served) -- basic/authorization expects 401 with a WWW-Authenticate challenge for a missing token",
    });
    // The unauthenticated ping, then its twin carrying the credential.
    expect(hits.filter((h) => h.method === "ping").map((h) => h.authorization)).toEqual([
      undefined,
      AUTH.Authorization,
    ]);
  }, 20_000);

  it("--auth: a bare 403 the credential does not get past either is not evaluable, not a rejection", async () => {
    // Before: PASS "HTTP 403 (unauthenticated request rejected)" for a 403
    // that refuses the request whether or not it carries the credential --
    // Host/Origin validation or a gateway, not authentication.
    const { verdict } = await authRequired({ noAuth: "bare-403", authedPing: "bare-403" }, { auth: true });
    expect(verdict).toEqual({
      passed: false,
      details:
        'HTTP 403 ("Forbidden") on the unauthenticated ping with no WWW-Authenticate: Bearer challenge, and the same ping with the credential was refused (HTTP 403, JSON-RPC error -32000) -- not evaluable: the 403 may be Host/Origin validation or a gateway rather than authentication; allow the hostname you tested through or fix the gateway (--auth compares only when the request carrying the credential is served)',
    });
  }, 20_000);

  it("without --auth: a bare 403 on the preflight is not evaluable, naming Host/Origin validation, a gateway and --auth", async () => {
    // Before: PASS "HTTP 403 (unauthenticated preflight rejected; pass --auth ...)".
    const { verdict } = await authRequired({ noAuth: "bare-403" }, { auth: false });
    expect(verdict).toEqual({
      passed: false,
      details:
        'HTTP 403 ("Forbidden") on the unauthenticated preflight with no WWW-Authenticate: Bearer challenge -- not evaluable: it may be Host/Origin validation or a gateway rather than authentication (a server that requires a token answers 401); re-run with --auth to compare the same request with and without the credential',
    });
  }, 20_000);

  it("without --auth: a bare 403 on the preflight next to a handshake served without any credential fails as accepting unauthenticated requests", async () => {
    // Before: PASS "HTTP 403 (unauthenticated preflight rejected; ...)" for a
    // gateway that refuses server/discover by method policy and serves the
    // unauthenticated initialize.
    const { verdict, report } = await authRequired({ token: undefined, discover403: true }, { auth: false });
    expect(report.serverInfo.name).toBe("security-stub");
    expect(verdict).toEqual({
      passed: false,
      details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
    });
  }, 20_000);

  it("without --auth: a 401, or a 403 carrying a Bearer challenge, on the preflight passes as today", async () => {
    for (const noAuth of ["401", "bearer-403"] as const) {
      const { verdict } = await authRequired({ noAuth }, { auth: false });
      expect(verdict).toEqual({
        passed: true,
        details: `HTTP ${noAuth === "401" ? 401 : 403} (unauthenticated preflight rejected; pass --auth to run the authenticated suite and the remaining auth tests)`,
      });
    }
  }, 20_000);

  it("--auth: a connection closed on the unauthenticated ping passes only when the same ping with the credential is served", async () => {
    // Before: PASS "Connection rejected (acceptable)" either way.
    const pinned = await authRequired({ noAuth: "drop" }, { auth: true });
    expect(pinned.verdict).toEqual({
      passed: true,
      details:
        "Connection closed without a response (other side closed); the same request with the credential was served (unauthenticated request rejected)",
    });
    const dropsEverything = await authRequired({ noAuth: "drop", authedPing: "drop" }, { auth: true });
    expect(dropsEverything.verdict).toEqual({
      passed: false,
      details:
        "server unreachable: unauthenticated ping got no response (connection closed: other side closed); the same ping with the credential got no response (connection closed: other side closed)",
    });
  }, 20_000);

  it("--auth: an unauthenticated ping that times out is 'server unreachable', not a rejection", async () => {
    // Before: PASS "Connection rejected (acceptable)" for a request nothing answered.
    const { verdict, hits } = await authRequired({ noAuth: "hang" }, { auth: true, timeout: 800 });
    expect(verdict).toEqual({
      passed: false,
      details: "server unreachable: unauthenticated ping got no response within 800ms",
    });
    // A timeout measured nothing, so no comparison ping follows it.
    expect(hits.filter((h) => h.method === "ping")).toHaveLength(1);
  }, 20_000);

  it("without --auth: a server that drops every unauthenticated request is 'server unreachable', not one that accepted them", async () => {
    // Before: FAIL "Server does not require auth (... server accepted
    // unauthenticated requests)" for a preflight nothing answered.
    const { verdict } = await authRequired({ noAuth: "drop" }, { auth: false });
    expect(verdict).toEqual({
      passed: false,
      details: "server unreachable: unauthenticated ping got no response (connection closed: other side closed)",
    });
  }, 20_000);

  it("an abort while the unauthenticated ping waits is rethrown, not graded as a rejection", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const completed: Verdict[] = [];
    const stub = await startSecurityStub({
      token: TOKEN,
      noAuth: "hang",
      onNoAuth: () => setTimeout(() => controller.abort(reason), 50),
    });
    try {
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 10_000,
          headers: AUTH,
          specVersion: "2025-11-25",
          only: [ID, "security-www-authenticate"],
          signal: controller.signal,
          onTestComplete: (t) => {
            if (t.id === ID) completed.push({ passed: t.passed, details: t.details });
          },
        }),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(5000);
      // Before: the abort was caught and recorded as PASS "Connection rejected (acceptable)".
      expect(completed.filter((c) => c.passed)).toEqual([]);
    } finally {
      await stub.stop();
    }
  }, 20_000);

  it("without --auth: a bare 403 on the preflight next to a 401 on the unauthenticated initialize passes on that 401", async () => {
    // A gateway whose method policy refuses server/discover with a bare 403
    // and answers every method it allows, without a token, with 401 and a
    // Bearer challenge. Before: FAIL "... not evaluable ...; re-run with
    // --auth ..." -- claiming a token-requiring server answers 401 next to
    // a server that did.
    const { verdict, hits } = await authRequired({ discover403: true, noAuth: "401" }, { auth: false });
    expect(verdict).toEqual({
      passed: true,
      details:
        "HTTP 401 on initialize (unauthenticated request rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
    });
    expect(hits.map((h) => h.method).slice(0, 2)).toEqual(["server/discover", "initialize"]);
  }, 20_000);

  it("a bare 403 whose message names Host validation advises allowing the hostname, not --auth", async () => {
    const tunnel = "Invalid Host: gentle-river-4821.trycloudflare.com";
    // Before: "... re-run with --auth to compare the same request with and
    // without the credential" -- a Host guard refuses the credentialed
    // request the same way.
    const noAuth = await authRequired({ noAuth: "bare-403", bare403Message: tunnel }, { auth: false });
    expect(noAuth.verdict).toEqual({
      passed: false,
      details: `HTTP 403 (${JSON.stringify(tunnel)}) on the unauthenticated preflight with no WWW-Authenticate: Bearer challenge -- not evaluable: the message names Host/Origin validation, which refuses the request with or without a credential (--auth does not get past it); allow the hostname you tested through in the server's allowed hosts/origins, or test an address it allows`,
    });
    const withAuth = await authRequired(
      { noAuth: "bare-403", authedPing: "bare-403", bare403Message: tunnel },
      { auth: true },
    );
    expect(withAuth.verdict).toEqual({
      passed: false,
      details: `HTTP 403 (${JSON.stringify(tunnel)}) on the unauthenticated ping with no WWW-Authenticate: Bearer challenge, and the same ping with the credential was refused (HTTP 403, JSON-RPC error -32000) -- not evaluable: the message names Host/Origin validation rather than authentication; allow the hostname you tested through in the server's allowed hosts/origins, or test an address it allows`,
    });
  }, 20_000);
});

describe("runComplianceSuite — legacy auth probes next to security-auth-required", () => {
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const SIBLINGS = [
    "security-www-authenticate",
    "security-auth-malformed",
    "security-session-not-auth",
    "security-token-in-uri",
  ];

  async function authProbes(stubOpts: SecurityStubOptions, auth: boolean) {
    const stub = await startSecurityStub({ token: TOKEN, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: ["security-auth-required", ...SIBLINGS, "security-oauth-metadata"],
        ...(auth ? { headers: AUTH } : {}),
      });
      return Object.fromEntries(
        report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]),
      ) as Record<string, string>;
    } finally {
      await stub.stop();
    }
  }

  it("--auth: when auth-required cannot attribute a bare 403, the probes that would credit the same 403 skip instead", async () => {
    // Before: PASS "HTTP 403 (WWW-Authenticate not applicable for 403)",
    // "HTTP 403 (malformed auth rejected)", "HTTP 403 (session ID alone not
    // sufficient for auth)" and "HTTP 403 (token in query string rejected)"
    // -- a Host guard's 403 credited next to auth-required calling the
    // same 403 not evaluable.
    const verdicts = await authProbes({ noAuth: "bare-403", authedPing: "bare-403" }, true);
    expect(verdicts["security-auth-required"]).toMatch(/^FAIL: HTTP 403 \("Forbidden"\) .* -- not evaluable: /);
    for (const id of SIBLINGS) {
      expect(verdicts[id], id).toBe("PASS: Skipped: not evaluable (see security-auth-required)");
    }
  }, 30_000);

  it("--auth against a server that answers a missing token with 401: the probes still measure it", async () => {
    const verdicts = await authProbes({ noAuth: "401" }, true);
    expect(verdicts).toMatchObject({
      "security-auth-required": "PASS: HTTP 401 (unauthenticated request rejected)",
      "security-www-authenticate": 'PASS: WWW-Authenticate: Bearer realm="mcp"',
      "security-auth-malformed": "PASS: HTTP 401 (malformed auth rejected)",
      "security-token-in-uri": "PASS: HTTP 401 (token in query string rejected)",
    });
  }, 30_000);

  it("without --auth the skipped probes say no --auth was provided, not that the server does not require auth", async () => {
    // Before: "Skipped: server does not require auth" next to auth-required
    // passing on the server's 401.
    const verdicts = await authProbes({ noAuth: "401" }, false);
    expect(verdicts["security-auth-required"]).toBe(
      "PASS: HTTP 401 (unauthenticated preflight rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
    );
    for (const id of [...SIBLINGS, "security-oauth-metadata"]) {
      expect(verdicts[id], id).toBe("PASS: Skipped: no --auth provided");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The legacy checks whose catch swallowed every transport error into
// PASS "Connection rejected (acceptable)": a timeout, a connection that was
// never established, an unparseable answer and a caller's abort all read as
// the server refusing the probe. Each now reads the error the way the
// 2026-07-28 suite does, and a drop counts as a refusal only next to the
// comparison request the check relies on having been served.
// ---------------------------------------------------------------------------
describe("runComplianceSuite — legacy probes that got no answer are read, not credited", () => {
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const SIBLINGS = [
    "security-www-authenticate",
    "security-auth-malformed",
    "security-session-not-auth",
    "security-token-in-uri",
  ];

  async function probes(
    stubOpts: SecurityStubOptions,
    runOpts: { only: string[]; headers?: Record<string, string>; timeout?: number },
  ): Promise<Record<string, string>> {
    const stub = await startSecurityStub({ token: TOKEN, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: runOpts.timeout ?? 800,
        specVersion: "2025-11-25",
        only: runOpts.only,
        ...(runOpts.headers ? { headers: runOpts.headers } : {}),
      });
      return Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    } finally {
      await stub.stop();
    }
  }

  const REINIT = "lifecycle-reinit-reject";

  it("lifecycle-reinit-reject: a second initialize nothing answers is 'server unreachable', not a rejection", async () => {
    // Before: PASS "Connection rejected (acceptable)" for a request that
    // sat unanswered until the deadline.
    const hung = await probes({ reinit: "hang" }, { only: [REINIT] });
    expect(hung[REINIT]).toBe("FAIL: server unreachable: the second initialize got no response within 800ms");
  }, 30_000);

  it("lifecycle-reinit-reject: a connection dropped on the duplicate, next to the served handshake, is a rejection", async () => {
    const dropped = await probes({ reinit: "drop" }, { only: [REINIT] });
    expect(dropped[REINIT]).toBe(
      "PASS: Connection closed without a response (other side closed) (re-initialization rejected)",
    );
  }, 30_000);

  it("lifecycle-reinit-reject: a server that dropped the handshake too pins nothing on the duplicate", async () => {
    // Every request is dropped (no credential is configured, so the gate
    // drops the handshake as well): there is no served comparison, and a
    // server that drops everything must not read as one that rejects a
    // second initialize.
    const dropped = await probes({ noAuth: "drop" }, { only: [REINIT] });
    expect(dropped[REINIT]).toBe(
      "FAIL: server unreachable: the second initialize got no response (connection closed: other side closed)",
    );
  }, 30_000);

  it("lifecycle-reinit-reject: a server that answers the duplicate keeps its verdict", async () => {
    const served = await probes({}, { only: [REINIT] });
    expect(served[REINIT]).toBe(
      "FAIL: Server accepted second initialize (HTTP 200) — should reject duplicate initialization",
    );
  }, 30_000);

  it("the auth probes: a connection dropped on each, next to the served credentialed handshake, is a rejection", async () => {
    // Before: PASS "Connection rejected (acceptable)" -- the same verdict a
    // server that drops every request got.
    const verdicts = await probes({ noAuth: "drop", session: true }, { only: SIBLINGS, headers: AUTH });
    expect(verdicts).toEqual({
      "security-www-authenticate":
        "PASS: Connection closed without a response (other side closed) — not a 401 response, no challenge to check",
      "security-auth-malformed":
        "PASS: Connection closed without a response (other side closed) (malformed auth rejected)",
      "security-session-not-auth":
        "PASS: Connection closed without a response (other side closed) (session ID alone not sufficient for auth)",
      "security-token-in-uri":
        "PASS: Connection closed without a response (other side closed) (token in query string not accepted)",
    });
  }, 30_000);

  it("the auth probes: a timeout measured nothing, so each fails as 'server unreachable'", async () => {
    const verdicts = await probes({ noAuth: "hang", session: true }, { only: SIBLINGS, headers: AUTH });
    expect(verdicts).toEqual({
      "security-www-authenticate": "FAIL: server unreachable: unauthenticated ping got no response within 800ms",
      "security-auth-malformed":
        "FAIL: server unreachable: the ping carrying a malformed credential got no response within 800ms",
      "security-session-not-auth":
        "FAIL: server unreachable: the ping carrying only the session ID got no response within 800ms",
      "security-token-in-uri":
        "FAIL: server unreachable: the ping with the token in the query string got no response within 800ms",
    });
  }, 30_000);

  it("the auth probes: a server that drops the credentialed handshake too pins nothing on the missing credential", async () => {
    // The credential does not match, so the gate drops every request, the
    // handshake included: there is no served comparison, and a server that
    // drops everything must not read as one that rejects unauthenticated
    // requests.
    const verdicts = await probes(
      { noAuth: "drop", session: true },
      { only: SIBLINGS, headers: { Authorization: "Bearer not-the-configured-token" } },
    );
    expect(verdicts["security-www-authenticate"]).toBe(
      "FAIL: server unreachable: unauthenticated ping got no response (connection closed: other side closed)",
    );
    // session-not-auth needs a session id the dropped handshake never issued.
    expect(verdicts["security-session-not-auth"]).toBe("PASS: Skipped: server does not issue session IDs");
    for (const id of ["security-auth-malformed", "security-token-in-uri"]) {
      expect(verdicts[id], id).toMatch(/^FAIL: server unreachable: /);
    }
  }, 30_000);

  const ORIGIN = "security-origin-validation";

  it("security-origin-validation: a connection dropped on the foreign Origin, next to the served handshake, is a rejection", async () => {
    // Before: PASS "Connection rejected (acceptable)" whatever happened.
    const dropped = await probes({ token: undefined, foreignOrigin: "drop" }, { only: [ORIGIN] });
    expect(dropped[ORIGIN]).toBe(
      "PASS: Connection closed without a response (other side closed) (suspicious Origin rejected)",
    );
  }, 30_000);

  it("security-origin-validation: a probe nothing answers is 'server unreachable', not Origin validation", async () => {
    const hung = await probes({ token: undefined, foreignOrigin: "hang" }, { only: [ORIGIN] });
    expect(hung[ORIGIN]).toMatch(/^FAIL: server unreachable: the ping carrying a foreign Origin got no response/);
  }, 30_000);

  it("security-origin-validation: a server that drops the handshake too pins nothing on the Origin", async () => {
    const verdicts = await probes({ noAuth: "drop" }, { only: [ORIGIN] });
    expect(verdicts[ORIGIN]).toBe(
      "FAIL: server unreachable: the ping carrying a foreign Origin got no response (connection closed: other side closed)",
    );
  }, 30_000);

  it("security-origin-validation: a server that answers the foreign Origin keeps its verdict", async () => {
    const served = await probes({ token: undefined }, { only: [ORIGIN] });
    expect(served[ORIGIN]).toBe(
      "FAIL: HTTP 200 — server accepted request with untrusted Origin header (spec: MUST validate Origin for DNS rebinding protection)",
    );
  }, 30_000);

  it("nothing listening at the address: every one of these probes fails as unreachable", async () => {
    // The other branch of the reading: a connection that was never
    // established (ECONNREFUSED) means the server never saw the probe, so
    // nothing about the defect it carried was decided -- and no served
    // comparison exists either, since the handshake could not connect.
    // Before: PASS "Connection rejected (acceptable)" on all five, so a
    // dead address collected five free passes.
    const stub = await startSecurityStub({ token: TOKEN, session: true });
    const dead = stub.url;
    await stub.stop();
    const report = await runComplianceSuite(dead, {
      timeout: 800,
      specVersion: "2025-11-25",
      headers: AUTH,
      only: [REINIT, ...SIBLINGS, ORIGIN],
    });
    const verdicts = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    const refused = String.raw`got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$`;
    expect(verdicts[REINIT]).toMatch(new RegExp(`^FAIL: server unreachable: the second initialize ${refused}`));
    expect(verdicts["security-www-authenticate"]).toMatch(
      new RegExp(`^FAIL: server unreachable: unauthenticated ping ${refused}`),
    );
    expect(verdicts["security-auth-malformed"]).toMatch(
      new RegExp(`^FAIL: server unreachable: the ping carrying a malformed credential ${refused}`),
    );
    expect(verdicts["security-token-in-uri"]).toMatch(
      new RegExp(`^FAIL: server unreachable: the ping with the token in the query string ${refused}`),
    );
    expect(verdicts[ORIGIN]).toMatch(
      new RegExp(`^FAIL: server unreachable: the ping carrying a foreign Origin ${refused}`),
    );
    // No session ID was ever issued, so the session probe has nothing to send.
    expect(verdicts["security-session-not-auth"]).toBe("PASS: Skipped: server does not issue session IDs");
  }, 30_000);
});

describe("runComplianceSuite — legacy auth checks read the configured Authorization header case-insensitively", () => {
  const TOKEN = "tok-3e9d";

  it("-H 'AUTHORIZATION: ...' configures a credential, so the auth checks run instead of reading the server as open", async () => {
    // Before: `hasAuth` read only the `Authorization` / `authorization`
    // keys, so an upper-case header (HTTP header names are
    // case-insensitive, and the transport's own merge treats them so) made
    // every auth check behave as if none had been passed: auth-required
    // graded the served preflight as "does not require auth" and its
    // siblings skipped.
    const stub = await startSecurityStub({ token: TOKEN, noAuth: "401", session: true });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: { AUTHORIZATION: `Bearer ${TOKEN}` },
        only: [
          "security-auth-required",
          "security-www-authenticate",
          "security-token-in-uri",
          "security-oauth-metadata",
        ],
      });
      const verdicts = Object.fromEntries(
        report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]),
      );
      expect(verdicts).toEqual({
        "security-auth-required": "PASS: HTTP 401 (unauthenticated request rejected)",
        "security-www-authenticate": 'PASS: WWW-Authenticate: Bearer realm="mcp"',
        // The token really was extracted from the upper-case header and
        // placed in the query string (before: "Skipped: no --auth provided").
        "security-token-in-uri": "PASS: HTTP 401 (token in query string rejected)",
        // The whole --auth-gated set is measured, this one included: the
        // stub has no Protected Resource Metadata to find.
        "security-oauth-metadata": "FAIL: PRM endpoint returned HTTP 401 and no legacy OAuth metadata found",
      });
      // The probes reached the server carrying no Authorization header,
      // while the handshake carried the configured one.
      expect(stub.hits.filter((h) => h.method === "initialize").map((h) => h.authorization)).toEqual([
        `Bearer ${TOKEN}`,
      ]);
      expect(stub.hits.filter((h) => h.method === "ping").map((h) => h.authorization)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});

describe("runComplianceSuite — legacy security-auth-required without --auth, next to a served handshake", () => {
  const ID = "security-auth-required";
  const TOKEN = "tok-3e9d";

  async function authRequired(stubOpts: SecurityStubOptions): Promise<Verdict> {
    const stub = await startSecurityStub({ token: TOKEN, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: [ID],
      });
      return verdictOf(report, ID);
    } finally {
      await stub.stop();
    }
  }

  it("a 401 on the preflight does not make a server that served initialize unauthenticated one that requires auth", async () => {
    // A gate that exempts the handshake: every other method without a token
    // draws 401 with a Bearer challenge, and initialize is served. Before:
    // PASS "HTTP 401 (unauthenticated preflight rejected; pass --auth ...)"
    // -- crediting the 401 while the same run holds proof the server served
    // an unauthenticated request.
    expect(await authRequired({ noAuth: "401", openInitialize: true })).toEqual({
      passed: false,
      details:
        "Server does not require auth: initialize was served with no credential, although the unauthenticated preflight got HTTP 401 (a server that requires authorization rejects every unauthenticated request, initialize included)",
    });
  }, 30_000);

  it("the same holds for a 403 carrying a Bearer challenge", async () => {
    expect(await authRequired({ noAuth: "bearer-403", openInitialize: true })).toEqual({
      passed: false,
      details:
        "Server does not require auth: initialize was served with no credential, although the unauthenticated preflight got HTTP 403 (a server that requires authorization rejects every unauthenticated request, initialize included)",
    });
  }, 30_000);

  it("a gate that refuses the handshake too still passes on its 401, with the wording it had", async () => {
    expect(await authRequired({ noAuth: "401" })).toEqual({
      passed: true,
      details:
        "HTTP 401 (unauthenticated preflight rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
    });
  }, 30_000);

  it("a bare 403 next to a served handshake keeps the plain 'does not require auth' wording", async () => {
    // A bare 403 says nothing about authentication on its own, so there is
    // no refusal to reconcile with the served handshake.
    expect(await authRequired({ noAuth: "bare-403", openInitialize: true })).toEqual({
      passed: false,
      details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
    });
  }, 30_000);
});

describe("runComplianceSuite — legacy security-oversized-input over HTTP", () => {
  const ID = "security-oversized-input";
  const ONLY = ["tools-list", ID];

  async function oversized(stubOpts: SecurityStubOptions, timeout = 3000) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, { timeout, specVersion: "2025-11-25", only: ONLY });
      return { verdict: verdictOf(report, ID), hits: stub.hits, warnings: report.warnings };
    } finally {
      await stub.stop();
    }
  }

  it("a 413, another 4xx, a JSON-RPC error and a completed result pass with the details they had", async () => {
    expect((await oversized({ bigCall: 413 })).verdict).toEqual({
      passed: true,
      details: "HTTP 413 Payload Too Large (good)",
    });
    expect((await oversized({ bigCall: 400 })).verdict).toEqual({
      passed: true,
      details: "HTTP 400 (oversized input rejected)",
    });
    for (const bigCall of ["rpc-error", undefined] as const) {
      const { verdict, hits } = await oversized({ bigCall });
      expect(verdict).toEqual({ passed: true, details: "HTTP 200 — server handled 1MB payload without crashing" });
      // The 1 MB value went to the listed tool, and nothing followed it.
      const calls = hits.filter((h) => h.method === "tools/call");
      expect(calls).toHaveLength(1);
      expect(calls[0].bytes).toBeGreaterThan(1_048_576);
      expect(hits.at(-1)?.method).toBe("tools/call");
    }
  }, 30_000);

  it("a 5xx on the 1 MB call fails as a server error", async () => {
    // Before: PASS "HTTP 500 (oversized input rejected)" -- any status >= 400 passed.
    expect((await oversized({ bigCall: 500 })).verdict).toEqual({
      passed: false,
      details: "HTTP 500 -- server error on a 1 MB sink.data (should answer 413/4xx or a JSON-RPC error)",
    });
  }, 20_000);

  it("a 2xx that is not a JSON-RPC response fails: no result or error came back", async () => {
    // Before: PASS "HTTP 200 — server handled 1MB payload without crashing" for an HTML page.
    expect((await oversized({ bigCall: "html" })).verdict).toEqual({
      passed: false,
      details: "HTTP 200, non-JSON-RPC body -- no result or error for a 1 MB sink.data",
    });
  }, 20_000);

  it("a timeout still fails as struggling", async () => {
    expect((await oversized({ bigCall: "hang" }, 800)).verdict).toEqual({
      passed: false,
      details: "Request timed out — server may be struggling with oversized input",
    });
  }, 20_000);

  it("a connection closed on the 1 MB body passes when a follow-up ping is served, or refused by a gate", async () => {
    // Before: PASS "Connection rejected (acceptable for oversized input)" without looking.
    const served = await oversized({ bigCall: "drop" });
    expect(served.verdict).toEqual({
      passed: true,
      details:
        "Connection rejected (acceptable for oversized input): other side closed; the server still served a follow-up ping",
    });
    expect(served.hits.map((h) => h.method).slice(-2)).toEqual(["tools/call", "ping"]);
    expect((await oversized({ bigCall: "drop", afterDrop: "401" })).verdict).toEqual({
      passed: true,
      details:
        "Connection rejected (acceptable for oversized input): other side closed; a follow-up ping was still answered (HTTP 401, an auth gate)",
    });
    expect((await oversized({ bigCall: "drop", afterDrop: "bare-403" })).verdict).toEqual({
      passed: true,
      details:
        "Connection rejected (acceptable for oversized input): other side closed; a follow-up ping was still answered (HTTP 403, a gate in front of the server such as a WAF or IPS now blocking this client)",
    });
    const throttled = await oversized({ bigCall: "drop", afterDrop: "429-then-serve" });
    expect(throttled.verdict).toEqual({
      passed: true,
      details:
        "Connection rejected (acceptable for oversized input): other side closed; a follow-up ping answered HTTP 429, then after 0ms was served",
    });
    expect(throttled.hits.map((h) => h.method).slice(-3)).toEqual(["tools/call", "ping", "ping"]);
  }, 40_000);

  it("a connection closed on the 1 MB body fails as a possible crash when the follow-up ping is not served", async () => {
    // Before: every one of these PASSED "Connection rejected (acceptable for oversized input)".
    const died = await oversized({ bigCall: "drop", afterDrop: "die" });
    expect(died.verdict.passed).toBe(false);
    expect(died.verdict.details).toMatch(
      /^server may have crashed: connection dropped on a 1 MB sink\.data: other side closed; ping then got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
    );
    expect((await oversized({ bigCall: "drop", afterDrop: "502" })).verdict).toEqual({
      passed: false,
      details:
        "server may have crashed: connection dropped on a 1 MB sink.data: other side closed; ping then answered HTTP 502",
    });
    const throttled = await oversized({ bigCall: "drop", afterDrop: "429-twice" });
    expect(throttled.verdict).toEqual({
      passed: false,
      details:
        "server may have crashed: connection dropped on a 1 MB sink.data: other side closed; ping then answered HTTP 429, then after 0ms answered HTTP 429",
    });
    // One retry, not a loop.
    expect(throttled.hits.map((h) => h.method).slice(-3)).toEqual(["tools/call", "ping", "ping"]);
  }, 40_000);

  it("bytes that are not an HTTP response fail as no usable response", async () => {
    // Before: PASS "Connection rejected (acceptable for oversized input)".
    const { verdict } = await oversized({ bigCall: "not-http" });
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(/^no usable response to a 1 MB sink\.data: \S/);
  }, 20_000);

  it("a server already unreachable is 'server unreachable', not a connection rejected", async () => {
    // Before: PASS "Connection rejected (acceptable for oversized input)" though nothing was sent.
    const report = await runComplianceSuite(DEAD_URL, { timeout: 2000, specVersion: "2025-11-25", only: [ID] });
    const verdict = verdictOf(report, ID);
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server unreachable: tools\/call test\.data with a 1 MB value got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:1\)$/,
    );
  }, 15_000);

  it("an abort while the 1 MB call waits ends the run at once instead of after the timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const stub = await startSecurityStub({
      bigCall: "hang",
      onBigCall: () => setTimeout(() => controller.abort(reason), 50),
    });
    try {
      const completed: string[] = [];
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 15_000,
          specVersion: "2025-11-25",
          only: [...ONLY, "security-extra-params"],
          signal: controller.signal,
          onTestComplete: (t) => {
            if (t.id === ID) completed.push(t.details);
          },
        }),
      ).rejects.toBe(reason);
      // Before: the raw POST ignored the caller's signal and ran to its 15 s
      // timeout, then recorded "Request timed out".
      expect(Date.now() - started).toBeLessThan(8000);
      expect(completed.filter((d) => d.includes("timed out"))).toEqual([]);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});

describe("runComplianceSuite — legacy security-oversized-input: gates in front of the server measure nothing", () => {
  const ID = "security-oversized-input";
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  async function oversized(stubOpts: SecurityStubOptions, auth = false) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: ["tools-list", ID],
        ...(auth ? { headers: AUTH } : {}),
      });
      return { verdict: verdictOf(report, ID), hits: stub.hits };
    } finally {
      await stub.stop();
    }
  }

  const bigCalls = (hits: SecurityHit[]) => hits.filter((h) => h.method === "tools/call" && h.bytes > 1_048_576);

  it("a 429 on the 1 MB call is resent once; a second 429 is not evaluable", async () => {
    // Before: PASS "HTTP 429 (oversized input rejected)" -- a rate limiter's answer.
    const limited = await oversized({ bigCall: 429 });
    expect(limited.verdict).toEqual({
      passed: false,
      details:
        "HTTP 429, then after 0ms HTTP 429 on a 1 MB sink.data -- not evaluable: a rate limiter answered before the server read the request",
    });
    expect(bigCalls(limited.hits)).toHaveLength(2);
    // Before: PASS "HTTP 429 (oversized input rejected)" without resending.
    const once = await oversized({ bigCall: "429-once" });
    expect(once.verdict).toEqual({ passed: true, details: "HTTP 200 — server handled 1MB payload without crashing" });
    expect(bigCalls(once.hits)).toHaveLength(2);
  }, 30_000);

  it("an auth gate's 401 or Bearer 403 on the 1 MB call is not evaluable", async () => {
    // Before: PASS "HTTP 401 (oversized input rejected)" for a credential
    // refused mid-run, and PASS "HTTP 403 (oversized input rejected)" for a
    // gateway asking for a token the run never sent.
    expect((await oversized({ token: TOKEN, bigCall: 401 }, true)).verdict).toEqual({
      passed: false,
      details:
        "HTTP 401 on a 1 MB sink.data -- not evaluable: an auth gate answered before the server read the request (credential rejected -- check --auth)",
    });
    expect((await oversized({ token: TOKEN, noAuth: "bearer-403" })).verdict).toEqual({
      passed: false,
      details:
        "HTTP 403 on a 1 MB test.data -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
    });
  }, 30_000);

  it("a bare 403 on the 1 MB call passes next to a served initialize, and is not evaluable when nothing was served", async () => {
    // A WAF rule blocking the body: initialize went through with the same headers.
    expect((await oversized({ bigCall: "bare-403" })).verdict).toEqual({
      passed: true,
      details: "HTTP 403 (oversized input rejected)",
    });
    // Before: PASS "HTTP 403 (oversized input rejected)" for a gate that
    // refuses every request (a Host guard, a gateway) and never let the
    // handshake through.
    expect((await oversized({ token: TOKEN, noAuth: "bare-403" })).verdict).toEqual({
      passed: false,
      details:
        'HTTP 403 ("Forbidden") on a 1 MB test.data -- not evaluable: initialize was not served either, so the 403 may be Host/Origin validation or a gateway refusing every request rather than a size limit',
    });
  }, 30_000);

  it("--auth against a gate whose credentialed requests are served: the 1 MB call is measured as usual", async () => {
    expect((await oversized({ token: TOKEN, noAuth: "401", bigCall: 413 }, true)).verdict).toEqual({
      passed: true,
      details: "HTTP 413 Payload Too Large (good)",
    });
  }, 30_000);

  it("after a dropped 1 MB call, a ping answered with a JSON-RPC error by its id shows the server is up", async () => {
    // Before: FAIL "server may have crashed: ...; ping then answered HTTP
    // 200, JSON-RPC error -32601" -- then said the server answered.
    expect((await oversized({ bigCall: "drop", afterDrop: "ping-rpc-error" })).verdict).toEqual({
      passed: true,
      details:
        "Connection rejected (acceptable for oversized input): other side closed; a follow-up ping was answered (HTTP 200, JSON-RPC error -32601)",
    });
    // An id-null "Session not found" is a server that restarted, not one that answered the ping.
    expect((await oversized({ bigCall: "drop", afterDrop: "session-404" })).verdict).toEqual({
      passed: false,
      details:
        "server may have crashed: connection dropped on a 1 MB sink.data: other side closed; ping then answered HTTP 404, JSON-RPC error -32001",
    });
  }, 30_000);

  it("a server that answered nothing in this run is 'server unreachable', not one that crashed on the 1 MB value", async () => {
    // A gateway that drops every request without the credential; no --auth.
    // Before: FAIL "server may have crashed: connection dropped on a 1 MB test.data: ...".
    const { verdict } = await oversized({ token: TOKEN, noAuth: "drop" });
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server unreachable: tools\/call test\.data with a 1 MB value got no response \(connection closed: [^)]+\); ping then got no response \(connection closed: [^)]+\) \(the preflight and initialize got no answer either\)$/,
    );
  }, 30_000);
});

/**
 * A 2025-11-25 stdio server with one tool, `echo(data)`, whose answer to a
 * tools/call carrying more than 500 KB depends on its mode: "exit" exits
 * with code 3 once it has read the line, "hang" never answers, "rpc-error"
 * answers -32602, "echo" writes the value back twice (a line well past the
 * runner's 1 MiB stdio buffer); "exit-on-list" exits on tools/list instead.
 * "exit-then-gone" exits on the 1 MB line like "exit" after writing the
 * marker file named by the third argument, and an instance started while
 * that marker exists exits at once with code 4 (a server that does not come
 * back after a crash).
 */
const OVERSIZED_STDIO_SERVER = `
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.argv[2];
const marker = process.argv[3];
if (mode === "exit-then-gone" && existsSync(marker)) process.exit(4);
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stdio-oversized", version: "1" } } });
    case "ping":
      return send({ jsonrpc: "2.0", id: msg.id, result: {} });
    case "tools/list":
      if (mode === "exit-on-list") process.exit(3);
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: { data: { type: "string" } } } }] } });
    case "tools/call": {
      const data = String(msg.params?.arguments?.data ?? "");
      if (data.length > 500000) {
        if (mode === "exit") process.exit(3);
        if (mode === "exit-then-gone") {
          writeFileSync(marker, "crashed");
          process.exit(3);
        }
        if (mode === "hang") return;
        if (mode === "rpc-error") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "data is too long" } });
        if (mode === "echo") return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: data + data }] } });
      }
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
rl.on("close", () => process.exit(0));
`;

describe("runComplianceSuite — legacy security-oversized-input over stdio", () => {
  // It used to POST to backendUrl, which is empty for a stdio target: undici
  // rejected the URL client-side and every stdio server PASSED "Connection
  // rejected (acceptable for oversized input)" without being sent anything.
  const ID = "security-oversized-input";
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-oversized-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, OVERSIZED_STDIO_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function overStdio(mode: string, timeout = 5000) {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, mode] },
      { timeout, specVersion: "2025-11-25", only: ["tools-list", ID] },
    );
    return { verdict: verdictOf(report, ID), warnings: report.warnings };
  }

  it("the echo fixture is sent the 1 MB value and passes as having handled it", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [fixture] },
      { timeout: 5000, specVersion: "2025-11-25", only: ["tools-list", ID] },
    );
    expect(verdictOf(report, ID)).toEqual({
      passed: true,
      details: "result -- server handled 1MB payload without crashing",
    });
  }, 30_000);

  it("a JSON-RPC error passes naming the code", async () => {
    expect((await overStdio("rpc-error")).verdict).toEqual({
      passed: true,
      details: "JSON-RPC error -32602 -- server handled 1MB payload without crashing",
    });
  }, 30_000);

  it("a child that exits on the 1 MB line fails as died", async () => {
    const { verdict } = await overStdio("exit");
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(/^server died on a 1 MB echo\.data: .*exit code 3/);
  }, 30_000);

  /** The checks that run after security-oversized-input on stdio. */
  const AFTER = [
    "security-extra-params",
    "security-tool-rug-pull",
    "stdio-framing",
    "stdio-unicode",
    "stdio-unknown-method-recovers",
  ];

  it("a child that exits on the 1 MB line is restarted, so the checks after it measure the server, not the crash", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, "exit"] },
      { timeout: 5000, specVersion: "2025-11-25", only: ["tools-list", ID, ...AFTER] },
    );
    expect(verdictOf(report, ID).passed).toBe(false);
    expect(verdictOf(report, ID).details).toMatch(/^server died on a 1 MB echo\.data: .*exit code 3/);
    // Before: every check after it ran against the dead child --
    // stdio-framing (required) FAILED "5/5 rapid pings failed — framing likely
    // broken", security-extra-params PASSED "Request rejected (acceptable)",
    // and rug-pull, unicode and unknown-method-recovers FAILED on the crash.
    expect(Object.fromEntries(AFTER.map((id) => [id, verdictOf(report, id)]))).toEqual({
      "security-extra-params": { passed: true, details: "Server processed request (extra params likely ignored)" },
      "security-tool-rug-pull": { passed: true, details: "1 tool(s) consistent across 2 calls" },
      "stdio-framing": { passed: true, details: "5/5 rapid pings returned cleanly" },
      "stdio-unicode": {
        passed: true,
        details: "Tool echoed something, but not the exact probe — likely still UTF-8-safe",
      },
      "stdio-unknown-method-recovers": {
        passed: true,
        details: "Unknown method returned JSON-RPC error; subsequent ping succeeded",
      },
    });
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([
      "security-oversized-input: the server exited on a 1 MB echo.data and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
  }, 60_000);

  it("a server that survives the 1 MB line is not restarted", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, "rpc-error"] },
      { timeout: 5000, specVersion: "2025-11-25", only: ["tools-list", ID, ...AFTER] },
    );
    expect(report.tests.filter((t) => !t.passed)).toEqual([]);
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([]);
  }, 60_000);

  it("a child that does not come back after the restart: the warning says so, and extra-params reports it unreachable", async () => {
    const marker = join(dir, `crashed-${randomUUID()}`);
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, "exit-then-gone", marker] },
      { timeout: 5000, startupTimeout: 5000, specVersion: "2025-11-25", only: ["tools-list", ID, ...AFTER] },
    );
    expect(verdictOf(report, ID).details).toMatch(/^server died on a 1 MB echo\.data: .*exit code 3/);
    const restart = report.warnings.filter((w) => w.startsWith("security-oversized-input"));
    expect(restart).toHaveLength(1);
    expect(restart[0]).toMatch(
      /^security-oversized-input: the server exited on a 1 MB echo\.data and was restarted, but the new instance's initialize got no response \(connection closed: .*exit code 4.*; the tests after it ran against the new instance and may fail for that reason\.$/,
    );
    // Before: PASS "Request rejected (acceptable)" from a child that was gone.
    const extra = verdictOf(report, "security-extra-params");
    expect(extra.passed).toBe(false);
    expect(extra.details).toMatch(
      /^server unreachable: tools\/call echo with unknown arguments got no response \(connection closed: .*exit code 4/,
    );
  }, 60_000);

  it("a child that never answers the 1 MB line fails as timed out", async () => {
    expect((await overStdio("hang", 1500)).verdict).toEqual({
      passed: false,
      details: "Request timed out — server may be struggling with oversized input",
    });
  }, 30_000);

  it("a reply longer than the runner's stdio buffer passes as survived, with a warning", async () => {
    const { verdict, warnings } = await overStdio("echo", 1500);
    expect(verdict).toEqual({
      passed: true,
      details: "response to a 1 MB echo.data exceeded the runner's stdio line buffer (server survived)",
    });
    expect(warnings).toContain(
      "security-oversized-input: the server's reply to a 1 MB echo.data exceeded the runner's 1 MiB stdio line buffer and was dropped; treated as survived. Prefer rejecting oversized arguments with a JSON-RPC error.",
    );
  }, 30_000);

  it("a child that already exited before the call is 'server unreachable', not a crash on the 1 MB value", async () => {
    const { verdict } = await overStdio("exit-on-list");
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server unreachable: tools\/call test\.data with a 1 MB value got no response \(connection closed: .*exit code 3/,
    );
  }, 30_000);
});
