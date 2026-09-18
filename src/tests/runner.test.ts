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
 *   that crashes into the framework's error page); `"http-500-with-token"`
 *   answers that only to a call carrying `_meta.progressToken`, and serves
 *   the same call without it.
 *
 * Records every POST.
 */
async function startLegacyStub(opts: {
  gateway?: { apiKey: string; token: string; queryToken: boolean };
  toolCall?: "executes" | "invalid-params" | "http-500" | "http-500-with-token";
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
      } else if (msg.method === "tools/call" && opts.toolCall === "http-500-with-token") {
        if (text.includes('"progressToken"')) {
          json(500, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: "TypeError: cannot read progressToken" },
          });
        } else {
          reply({ result: { content: [{ type: "text", text: "ran" }] } });
        }
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
      // Served: the server took the token, a measurement, not a skip.
      expect(skippedOf(report, "lifecycle-progress-token")).toBeUndefined();
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
      // The server answered: an observation, not a skip (only a call
      // nothing answered measured nothing).
      expect(skippedOf(report, "lifecycle-progress-token")).toBeUndefined();
      expect(stub.hits.filter((h) => h.method === "tools/call")).toHaveLength(1);
    } finally {
      await stub.stop();
    }
  }, 15000);

  it("a tools/call that fails only when it carries the progressToken: an answer about the token, not a skip", async () => {
    // tools-call sends the same call without _meta and is served, so the
    // 500 is the server's answer to the progressToken. It used to carry
    // skipped: true ("measured nothing").
    const stub = await startLegacyStub({ toolCall: "http-500-with-token" });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 5000,
        specVersion: "2025-11-25",
        only: ["tools-list", "tools-call", "lifecycle-progress-token"],
      });
      expect(verdictOf(report, "tools-call")).toEqual({ passed: true, details: "Returned 1 content item(s)" });
      expect(progressToken(report)).toEqual({
        passed: true,
        details: "HTTP 500 — tools/call with progressToken was not served (no progress events observed — optional)",
      });
      expect(skippedOf(report, "lifecycle-progress-token")).toBeUndefined();
      expect(stub.hits.filter((h) => h.method === "tools/call")).toHaveLength(2);
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
  /**
   * Also: a rate limiter's 429, an edge's 503 with no backend, a 302 to an
   * SSO login page, a 200 HTML login page: answers that are no
   * authentication refusal.
   */
  noAuth?: "bare-403" | "bearer-403" | "401" | "drop" | "hang" | 429 | 503 | 302 | "login-200";
  /** The JSON-RPC error message of every bare 403 the stub sends ("Forbidden" by default). */
  bare403Message?: string;
  /** A gateway method policy that answers server/discover (the preflight) with a bare 403, credential or not. */
  discover403?: boolean;
  /**
   * A gateway that lets server/discover through without the token: the
   * server answers it -32601 on HTTP 200 (a 2025-11-25 server), or with
   * `"served"` a result (a server that also speaks 2026-07-28).
   */
  discoverOpen?: "method-not-found" | "served";
  /**
   * The gate lets `initialize` through without the token (a deployment
   * that exempts the handshake): every other method still draws `noAuth`.
   */
  openInitialize?: boolean;
  /** Whether the initialize response carries an Mcp-Session-Id (the session the session-only probe reuses). */
  session?: boolean;
  /**
   * How a SECOND initialize is answered: like the first by default. Besides
   * a drop and no answer: the server's own rejection (a JSON-RPC -32600 on
   * HTTP 400, the way the SDK answers it), and what an intermediary answers
   * in its place -- a rate limiter's 429 (every time, or once), an edge's
   * 503 or bare HTML 502, a 401 for a credential that expired mid-run, a
   * Host guard's 403 "Invalid Host: ...".
   */
  reinit?: "drop" | "hang" | "rpc-400" | 429 | "429-once" | 503 | "502-html" | 401 | "host-403" | 302;
  /**
   * How a small tools/call carrying the `$(whoami)` injection payload is
   * answered: the connection closed without an answer (the stub then counts
   * as having dropped a request, so `afterDrop` applies), or no answer;
   * `"hang-all"` leaves every small tools/call unanswered.
   */
  injection?: "drop" | "hang" | "hang-all";
  /** Called when that tools/call arrives, before it is answered. */
  onInjection?: () => void;
  /**
   * How a request carrying an Origin header is answered: like any other by
   * default. Besides a drop and no answer: an Origin guard's bare 403 or a
   * 400, a server error (a JSON-RPC 500, or an edge's plain-text 503), a
   * rate limiter's 429 every time, or once before the guard's 403.
   */
  foreignOrigin?: "drop" | "hang" | "bare-403" | 400 | 500 | "503-text" | 429 | "429-then-403";
  /**
   * How a tools/call carrying the `__injected_param__` unknown argument is
   * answered: a result by default. An unhandled throw surfacing as an HTML
   * 500 (or as a JSON-RPC -32603 on HTTP 500), an HTML page on 200, the
   * server's own -32602 on HTTP 400 or 200, the connection closed without
   * an answer (the stub then counts as having dropped a request, so
   * `afterDrop` applies), no answer, or bytes that are not an HTTP response.
   */
  extraCall?: "html-500" | "rpc-500" | "html-200" | "rpc-400" | "rpc-error" | "drop" | "hang" | "not-http";
  /** Called when that tools/call arrives, before it is answered. */
  onExtraCall?: () => void;
  /** Called when a request without the token reaches the `noAuth` gate. */
  onNoAuth?: () => void;
  /** How a ping that carries the token is answered: served by default. */
  authedPing?: "drop" | "bare-403";
  /**
   * The gate also lets through a request whose query string carries
   * `access_token=<token>` (a server that honours a token in the URI) --
   * with `"any"`, any non-empty `access_token` -- and with
   * `malformedServed` one carrying the suite's garbage credential (a server
   * that checks only that some Bearer value is present).
   */
  queryToken?: true | "any";
  malformedServed?: boolean;
  /**
   * How GET /.well-known/oauth-protected-resource is answered, ahead of the
   * gate: a valid Protected Resource Metadata document, or 404 (the
   * authorization-server document then 404s too). By default the gate
   * answers it like any other request.
   */
  wellKnown?: "prm" | 404;
  /** Declare tools, resources and prompts, and list none of them. */
  lists?: "empty";
  /** `sink`'s only argument is a number, so no tool takes a string. */
  numericSink?: boolean;
  /** A small tools/call is answered with an empty content array. */
  emptyContent?: boolean;
  /**
   * A small tools/call is answered, but malformed: a result whose content
   * is a string rather than an array, or a JSON-RPC response carrying
   * neither a result nor an error.
   */
  malformedCall?: "string-content" | "no-result";
  /**
   * How the error-disclosure probes (the invalid JSON body and the
   * nonexistent/___crash___test___, ___trigger_error___ and
   * ___nonexistent___tool___ requests) are answered: closed without an
   * answer, or never answered.
   */
  errorProbes?: "drop" | "hang";
  /** Called when an error-disclosure probe arrives, before it is answered. */
  onErrorProbe?: () => void;
  /** A tools/call carrying _meta.progressToken is never answered. */
  progressCall?: "hang";
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
   * -32601 carrying its id (a live server that does not implement ping),
   * "ping-rpc-error-400" the same on HTTP 400, and "ping-rpc-error-503" a
   * 503 whose -32603 echoes the ping's id (a gateway in front of a backend
   * that is gone); "session-404" answers every request 404 with an id-null
   * -32001 "Session not found" (a server that restarted and lost the
   * session).
   */
  afterDrop?:
    | "die"
    | "401"
    | "bare-403"
    | "429-then-serve"
    | "429-twice"
    | "502"
    | "ping-rpc-error"
    | "ping-rpc-error-400"
    | "ping-rpc-error-503"
    | "session-404";
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
  let originThrottles = opts.foreignOrigin === "429-then-403" ? 1 : 0;
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
      if (opts.wellKnown !== undefined && req.method === "GET" && req.url?.startsWith("/.well-known/")) {
        if (opts.wellKnown === "prm" && req.url === "/.well-known/oauth-protected-resource") {
          return json(200, {
            resource: `http://${req.headers.host}/mcp`,
            authorization_servers: ["https://auth.example"],
          });
        }
        return json(404, { error: "not found" });
      }
      const errorProbe =
        text.startsWith("{this is not valid json") ||
        msg.method === "nonexistent/___crash___test___" ||
        msg.method === "___trigger_error___" ||
        (msg.method === "tools/call" && text.includes("___nonexistent___tool___"));
      if (opts.errorProbes && errorProbe) {
        opts.onErrorProbe?.();
        if (opts.errorProbes === "drop") return req.socket.destroy();
        return;
      }
      if (opts.progressCall === "hang" && msg.method === "tools/call" && text.includes('"progressToken"')) return;
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
          case "ping-rpc-error-400":
            if (msg.method === "ping") return rpcError(400, -32601, "Method not found");
            break;
          case "ping-rpc-error-503":
            if (msg.method === "ping") return rpcError(503, -32603, "Backend unavailable");
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
      if (opts.discoverOpen && msg.method === "server/discover") {
        if (opts.discoverOpen === "served") {
          return json(200, { jsonrpc: "2.0", id: msg.id, result: { supportedVersions: ["2026-07-28"] } });
        }
        return rpcError(200, -32601, "Method not found");
      }
      if (opts.foreignOrigin && req.headers.origin !== undefined) {
        switch (opts.foreignOrigin) {
          case "drop":
            return req.socket.destroy();
          case "hang":
            return;
          case "bare-403":
            return rpcError(403, -32000, "Invalid Origin: https://evil-rebinding-attack.example.com");
          case 400:
            return rpcError(400, -32600, "Bad Request: untrusted Origin");
          case 500:
            return rpcError(500, -32603, "Internal error");
          case "503-text":
            return send(503, "Service Unavailable", { "content-type": "text/plain" });
          case 429:
            return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
          case "429-then-403":
            if (originThrottles > 0) {
              originThrottles--;
              return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
            }
            return rpcError(403, -32000, "Invalid Origin: https://evil-rebinding-attack.example.com");
        }
      }
      const queryTokenValue = new URL(req.url ?? "/", "http://stub").searchParams.get("access_token");
      const queryTokenOk =
        (opts.queryToken === true && queryTokenValue === opts.token) ||
        (opts.queryToken === "any" && !!queryTokenValue);
      const malformedOk = opts.malformedServed === true && /INVALID_GARBAGE/.test(req.headers.authorization ?? "");
      if (
        opts.token &&
        req.headers.authorization !== `Bearer ${opts.token}` &&
        !(opts.openInitialize && msg.method === "initialize") &&
        !queryTokenOk &&
        !malformedOk
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
          case 429:
            return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
          case 503:
            return send(503, "Service Unavailable", { "content-type": "text/plain" });
          case 302:
            return send(302, "", { location: "https://sso.example.com/login" });
          case "login-200":
            return send(200, "<html><body>Sign in</body></html>", { "content-type": "text/html" });
        }
      }
      if (msg.id === undefined) return send(202, "", {});
      const reply = (body: Record<string, unknown>) => json(200, { jsonrpc: "2.0", id: msg.id, ...body });
      switch (msg.method) {
        case "initialize": {
          initializes++;
          if (initializes > 1 && opts.reinit) {
            switch (opts.reinit) {
              case "drop":
                return req.socket.destroy();
              case "hang":
                return;
              case "rpc-400":
                return rpcError(400, -32600, "Invalid Request: Server already initialized");
              case "429-once":
                if (initializes > 2) return rpcError(400, -32600, "Invalid Request: Server already initialized");
                return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
              case 429:
                return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
              case 503:
                return rpcError(503, -32000, "Service Unavailable");
              case "502-html":
                return send(502, "<h1>502 Bad Gateway</h1>", { "content-type": "text/html" });
              case 401:
                return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer error="invalid_token"' });
              case "host-403":
                return rpcError(403, -32000, "Invalid Host: mcp.internal.example");
              case 302:
                return send(302, "", { location: "https://sso.example.com/login" });
            }
          }
          return json(
            200,
            {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: opts.lists === "empty" ? { tools: {}, resources: {}, prompts: {} } : { tools: {} },
                serverInfo: { name: "security-stub", version: "1" },
              },
            },
            opts.session ? { "mcp-session-id": "sess-7c41f2a9b3d6" } : {},
          );
        }
        case "ping": {
          // Only the ping that carries the credential in its header: one the
          // gate let through on a query-string token is served.
          const authed = opts.token && req.headers.authorization === `Bearer ${opts.token}`;
          if (authed && opts.authedPing === "drop") return req.socket.destroy();
          if (authed && opts.authedPing === "bare-403") return rpcError(403, -32000, bare403Message);
          return reply({ result: {} });
        }
        case "tools/list":
          if (opts.lists === "empty") return reply({ result: { tools: [] } });
          return reply({
            result: {
              tools: [
                {
                  name: "sink",
                  description: "Stores a value",
                  inputSchema: {
                    type: "object",
                    properties: { data: { type: opts.numericSink ? "number" : "string" } },
                  },
                },
              ],
            },
          });
        case "resources/list":
          if (opts.lists === "empty") return reply({ result: { resources: [] } });
          return reply({ error: { code: -32601, message: "Method not found" } });
        case "prompts/list":
          if (opts.lists === "empty") return reply({ result: { prompts: [] } });
          return reply({ error: { code: -32601, message: "Method not found" } });
        case "tools/call": {
          if (opts.injection && (opts.injection === "hang-all" || text.includes("$(whoami)"))) {
            opts.onInjection?.();
            if (opts.injection !== "drop") return;
            dropped = true;
            if (opts.afterDrop === "die") {
              server.close();
              server.closeAllConnections();
            }
            return req.socket.destroy();
          }
          if (opts.extraCall && text.includes("__injected_param__")) {
            opts.onExtraCall?.();
            switch (opts.extraCall) {
              case "html-500":
                // An unhandled throw in the handler, mapped by the framework.
                return send(500, "Internal Server Error: Cannot set property admin of #<Object>", {
                  "content-type": "text/html",
                });
              case "html-200":
                return send(200, "<html><body>ok</body></html>", { "content-type": "text/html" });
              case "rpc-400":
                return rpcError(400, -32602, "Invalid params: unknown argument __injected_param__");
              case "rpc-500":
                return rpcError(500, -32603, "Internal error");
              case "rpc-error":
                return reply({
                  error: { code: -32602, message: "Invalid params: unknown argument __injected_param__" },
                });
              case "hang":
                return;
              case "not-http":
                return req.socket.end("NOT-HTTP garbage\r\n\r\n");
              case "drop":
                dropped = true;
                if (opts.afterDrop === "die") {
                  server.close();
                  server.closeAllConnections();
                }
                return req.socket.destroy();
            }
          }
          if (text.length < 500_000) {
            if (opts.malformedCall === "string-content") return reply({ result: { content: "stored" } });
            if (opts.malformedCall === "no-result") return json(200, { jsonrpc: "2.0", id: msg.id });
            return reply({ result: { content: opts.emptyContent ? [] : [{ type: "text", text: "stored" }] } });
          }
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

/** A check's TestResult.skipped: true when the pass measured nothing, undefined otherwise. */
function skippedOf(report: { tests: { id: string; skipped?: boolean }[] }, id: string): boolean | undefined {
  const t = report.tests.find((x) => x.id === id);
  if (!t) throw new Error(`${id} did not run (ran: ${report.tests.map((x) => x.id).join(", ")})`);
  return t.skipped;
}

/**
 * The 2025-11-25 auth siblings' not-evaluable skip. Before: "Skipped: not
 * evaluable (see security-auth-required)", a pointer only; now worded as the
 * 2026-07-28 suite's AUTH_NOT_EVALUABLE, so it says what was seen on its own.
 */
const AUTH_NOT_EVALUABLE =
  "Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)";

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
      expect(verdicts[id], id).toBe(`PASS: ${AUTH_NOT_EVALUABLE}`);
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
// The 2025-11-25 halves of the auth-sibling fixes the 2026-07-28 suite
// already carries, so both eras read one server the same way:
// - security-oauth-metadata skips when the endpoint's unattributable bare 403
//   is what the well-known locations drew too (the guard, not a missing
//   document);
// - security-token-in-uri sends its probe before reading the attribution, so
//   a query-string token accepted behind such a 403 still fails;
// - security-auth-malformed and security-token-in-uri skip a refusal that
//   the configured credential drew too.
// ---------------------------------------------------------------------------
describe("runComplianceSuite — legacy auth siblings read a gate the way the 2026-07-28 suite does", () => {
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const OAUTH = "security-oauth-metadata";
  const TOKEN_IN_URI = "security-token-in-uri";
  const MALFORMED = "security-auth-malformed";
  /** The guard's 403 on the endpoint and on both metadata locations. */
  const GUARD_SKIP =
    "Skipped: HTTP 403 without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)";

  async function run(stubOpts: SecurityStubOptions, only: string[], headers: Record<string, string> = AUTH) {
    const stub = await startSecurityStub({ token: TOKEN, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 3000, specVersion: "2025-11-25", only, headers });
      const verdicts = Object.fromEntries(
        report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]),
      ) as Record<string, string>;
      return { report, verdicts, hits: stub.hits, url: stub.url };
    } finally {
      await stub.stop();
    }
  }
  const pingAuths = (hits: SecurityHit[]) => hits.filter((h) => h.method === "ping").map((h) => h.authorization);

  it("security-oauth-metadata: a bare 403 the credential does not get past either, drawn by both metadata locations too, skips as not evaluable", async () => {
    // Before: FAIL "PRM endpoint returned HTTP 403 and no legacy OAuth
    // metadata found" -- a Host guard's 403 read as a missing document,
    // whose remedy (publish PRM) the guard would never let through.
    const { report, verdicts } = await run({ noAuth: "bare-403", authedPing: "bare-403" }, [OAUTH]);
    expect(verdicts[OAUTH]).toBe(`PASS: ${GUARD_SKIP}`);
    expect(skippedOf(report, OAUTH)).toBe(true);
  }, 20_000);

  it("security-oauth-metadata: a document found, a 404, a 401, or a 403 the credential gets past decide as before", async () => {
    const found = await run({ noAuth: "bare-403", authedPing: "bare-403", wellKnown: "prm" }, [OAUTH]);
    expect(found.verdicts[OAUTH]).toBe(
      `PASS: Protected Resource Metadata found: resource=${found.url}, 1 auth server(s)`,
    );
    const missing = await run({ noAuth: "bare-403", authedPing: "bare-403", wellKnown: 404 }, [OAUTH]);
    expect(missing.verdicts[OAUTH]).toBe("FAIL: PRM endpoint returned HTTP 404 and no legacy OAuth metadata found");
    // A 403 next to a served credentialed ping is the gate refusing the
    // missing credential: a finding about the metadata, not the guard.
    const attributed = await run({ noAuth: "bare-403" }, [OAUTH]);
    expect(attributed.verdicts[OAUTH]).toBe("FAIL: PRM endpoint returned HTTP 403 and no legacy OAuth metadata found");
    const unauthorized = await run({ noAuth: "401" }, [OAUTH]);
    expect(unauthorized.verdicts[OAUTH]).toBe(
      "FAIL: PRM endpoint returned HTTP 401 and no legacy OAuth metadata found",
    );
    // The attribution is asked only when both locations drew a 403: a
    // server answering 401 is sent no ping for it.
    expect(pingAuths(unauthorized.hits)).toEqual([]);
  }, 30_000);

  it("security-token-in-uri: a query-string token accepted behind an unattributable bare 403 FAILS", async () => {
    // Before: PASS "Skipped: not evaluable (see security-auth-required)",
    // returned before the probe was ever sent -- a server that honours
    // ?access_token= behind a Host guard went untested.
    const { verdicts, hits } = await run({ noAuth: "bare-403", authedPing: "bare-403", queryToken: true }, [
      TOKEN_IN_URI,
    ]);
    expect(verdicts[TOKEN_IN_URI]).toBe(
      "FAIL: Server accepted auth token in query string (spec: MUST NOT transmit credentials in URIs)",
    );
    expect(pingAuths(hits)).toEqual([undefined]);
  }, 20_000);

  it("security-token-in-uri: the same guard refusing the query-string token still skips, now after the probe was sent", async () => {
    const { verdicts, hits } = await run({ noAuth: "bare-403", authedPing: "bare-403" }, [TOKEN_IN_URI]);
    expect(verdicts[TOKEN_IN_URI]).toBe(`PASS: ${AUTH_NOT_EVALUABLE}`);
    // The probe (no Authorization, the token in the URI), then the
    // attribution: the unauthenticated ping and its credentialed twin.
    // Before: only the last two, the probe never sent.
    expect(pingAuths(hits)).toEqual([undefined, undefined, AUTH.Authorization]);
  }, 20_000);

  it("a credential the server refuses too: auth-malformed and token-in-uri skip rather than credit a refusal every credential draws", async () => {
    // A stale token: the server answers it 401 like every other credential.
    // Before: PASS "HTTP 401 (malformed auth rejected)" and PASS "HTTP 401
    // (token in query string rejected)" -- a blanket refusal read as token
    // validation.
    const { report, verdicts } = await run({ noAuth: "401" }, [MALFORMED, TOKEN_IN_URI], {
      Authorization: "Bearer stale-7d1",
    });
    expect(verdicts).toEqual({
      [MALFORMED]:
        "PASS: Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so rejecting invalid tokens cannot be told from rejecting everything (check the configured credential)",
      [TOKEN_IN_URI]:
        "PASS: Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so refusing it in the query string proves nothing (check the configured credential)",
    });
    expect([skippedOf(report, MALFORMED), skippedOf(report, TOKEN_IN_URI)]).toEqual([true, true]);
  }, 20_000);

  it("a credential the server refuses too: only a pass becomes the skip -- an acceptance still fails", async () => {
    // The server refuses the stale token in the header but serves the
    // garbage credential and any token in the query string.
    const { verdicts } = await run(
      { noAuth: "401", malformedServed: true, queryToken: "any" },
      [MALFORMED, TOKEN_IN_URI],
      { Authorization: "Bearer stale-7d1" },
    );
    expect(verdicts).toEqual({
      [MALFORMED]: "FAIL: HTTP 200 — server accepted malformed auth token",
      [TOKEN_IN_URI]: "FAIL: Server accepted auth token in query string (spec: MUST NOT transmit credentials in URIs)",
    });
  }, 20_000);

  it("a credential the server serves, or refuses with a 403 only, keeps the measurement", async () => {
    const served = await run({ noAuth: "401" }, [MALFORMED, TOKEN_IN_URI]);
    expect(served.verdicts).toEqual({
      [MALFORMED]: "PASS: HTTP 401 (malformed auth rejected)",
      [TOKEN_IN_URI]: "PASS: HTTP 401 (token in query string rejected)",
    });
    // A 403 on the credentialed ping may be a scope the server did check:
    // not the blanket 401 the skip is for.
    const scoped = await run({ noAuth: "401", authedPing: "bare-403" }, [MALFORMED, TOKEN_IN_URI]);
    expect(scoped.verdicts).toEqual({
      [MALFORMED]: "PASS: HTTP 401 (malformed auth rejected)",
      [TOKEN_IN_URI]: "PASS: HTTP 401 (token in query string rejected)",
    });
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
      // The three probes, then the credentialed twin token-in-uri reads
      // before crediting its 401 (served here, so the 401 stands): it
      // carries the upper-case header's credential.
      expect(stub.hits.filter((h) => h.method === "ping").map((h) => h.authorization)).toEqual([
        undefined,
        undefined,
        undefined,
        `Bearer ${TOKEN}`,
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

  const bodyLimitWarning = (where: string) =>
    `security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (${where}) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.`;
  const oversizedWarnings = (warnings: string[]) => warnings.filter((w) => w.startsWith(ID));

  it("a 413 and another 4xx pass with the details they had, and no warning", async () => {
    const payloadTooLarge = await oversized({ bigCall: 413 });
    expect(payloadTooLarge.verdict).toEqual({ passed: true, details: "HTTP 413 Payload Too Large (good)" });
    expect(oversizedWarnings(payloadTooLarge.warnings)).toEqual([]);
    const badRequest = await oversized({ bigCall: 400 });
    expect(badRequest.verdict).toEqual({ passed: true, details: "HTTP 400 (oversized input rejected)" });
    expect(oversizedWarnings(badRequest.warnings)).toEqual([]);
  }, 30_000);

  it("a JSON-RPC error is a rejection; a completed result survived, and passes with the body-limit warning", async () => {
    // Before: both passed as "HTTP 200 — server handled 1MB payload without
    // crashing", with no warning -- a server that refused the megabyte and
    // one that swallowed it read the same, where the 2026-07-28 twin tells
    // them apart and warns about the second.
    const rejected = await oversized({ bigCall: "rpc-error" });
    expect(rejected.verdict).toEqual({ passed: true, details: "JSON-RPC error -32602 (oversized input rejected)" });
    expect(oversizedWarnings(rejected.warnings)).toEqual([]);
    const accepted = await oversized({});
    expect(accepted.verdict).toEqual({
      passed: true,
      details: "HTTP 200, result -- server processed a 1 MB sink.data without rejecting it (survived)",
    });
    expect(oversizedWarnings(accepted.warnings)).toEqual([bodyLimitWarning("sink.data")]);
    for (const { hits } of [rejected, accepted]) {
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
    expect(once.verdict).toEqual({
      passed: true,
      details: "HTTP 200, result -- server processed a 1 MB sink.data without rejecting it (survived)",
    });
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

  it("after a dropped 1 MB call, a ping answered by its id on a 4xx shows the server is up; on a 5xx it does not", async () => {
    // Before: FAIL "server may have crashed: ...; ping then answered HTTP
    // 400, JSON-RPC error -32601" -- only a 2xx counted, although both eras
    // let a server's JSON-RPC error travel on a 4xx.
    const up = await oversized({ bigCall: "drop", afterDrop: "ping-rpc-error-400" });
    expect(up.verdict).toEqual({
      passed: true,
      details:
        "Connection rejected (acceptable for oversized input): other side closed; a follow-up ping was answered (HTTP 400, JSON-RPC error -32601)",
    });
    expect(up.hits.map((h) => h.method).slice(-2)).toEqual(["tools/call", "ping"]);
    // A gateway in front of a backend that is gone can echo the id on its
    // 5xx: that stays a possible crash.
    expect((await oversized({ bigCall: "drop", afterDrop: "ping-rpc-error-503" })).verdict).toEqual({
      passed: false,
      details:
        "server may have crashed: connection dropped on a 1 MB sink.data: other side closed; ping then answered HTTP 503, JSON-RPC error -32603",
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
 * back after a crash). "exit-on-whoami" exits with code 8 on a tools/call
 * whose data carries the `$(whoami)` injection payload (an unhandled throw in
 * a tool handler), and "exit-on-call" with code 5 on any tools/call;
 * "leak-then-exit" answers "; cat /etc/passwd" with a passwd line first.
 * "exit-on-extra" exits with code 7 on a tools/call whose arguments carry
 * the `__injected_param__` unknown argument (the pollution payload crashing
 * a handler), after answering everything else -- the 1 MB line included.
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
      if (mode === "exit-on-extra" && Object.hasOwn(msg.params?.arguments ?? {}, "__injected_param__")) process.exit(7);
      if ((mode === "exit-on-whoami" || mode === "leak-then-exit") && data.includes("$(whoami)")) process.exit(8);
      if (mode === "leak-then-exit" && data.includes("/etc/passwd")) {
        return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "root:x:0:0:root:/root:/bin/bash" }] } });
      }
      if (mode === "exit-on-call") process.exit(5);
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

  it("the echo fixture is sent the 1 MB value, and passes as having survived it, with the body-limit warning", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [fixture] },
      { timeout: 5000, specVersion: "2025-11-25", only: ["tools-list", ID] },
    );
    // Before: PASS "result -- server handled 1MB payload without crashing",
    // with no warning, where the 2026-07-28 twin warns about the same result.
    expect(verdictOf(report, ID)).toEqual({
      passed: true,
      details: "result -- server processed a 1 MB echo.data without rejecting it (survived)",
    });
    expect(report.warnings.filter((w) => w.startsWith(ID))).toEqual([
      "security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (echo.data) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.",
    ]);
  }, 30_000);

  it("a JSON-RPC error passes as a rejection naming the code, with no warning", async () => {
    // Before: PASS "JSON-RPC error -32602 -- server handled 1MB payload without crashing".
    const { verdict, warnings } = await overStdio("rpc-error");
    expect(verdict).toEqual({ passed: true, details: "JSON-RPC error -32602 (oversized input rejected)" });
    expect(warnings.filter((w) => w.startsWith(ID))).toEqual([]);
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

// ---------------------------------------------------------------------------
// Legacy injection checks: a payload that got no answer. The helper's bare
// catch used to count every transport error as the server rejecting the
// input -- a stdio child that exited on a payload, a connection the server
// dropped, a timeout, and the caller's own abort all read as "rejected", and
// a crash passed as "server defended".
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy injection checks over stdio: a child that exits on a payload died on it", () => {
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-injection-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, OVERSIZED_STDIO_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The checks that run after security-command-injection on stdio. */
  const AFTER = [
    "security-sql-injection",
    "security-path-traversal",
    "security-oversized-input",
    "security-extra-params",
    "security-tool-rug-pull",
    "stdio-framing",
    "stdio-unicode",
    "stdio-unknown-method-recovers",
  ];

  it("FAILS naming the payload, and restarts the child so the checks after it measure the server, not the crash", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, "exit-on-whoami"] },
      {
        timeout: 5000,
        specVersion: "2025-11-25",
        only: ["tools-list", "security-command-injection", ...AFTER],
      },
    );
    // Before: PASS "Tested 5 payloads against echo.data — no command
    // execution detected (4 rejected, 1 returned without it)" -- the exit
    // and the four payloads sent to the dead child counted as rejections.
    const injection = verdictOf(report, "security-command-injection");
    expect(injection.passed).toBe(false);
    expect(injection.details).toMatch(/^server died on payload "\$\(whoami\)" sent to echo\.data: .*exit code 8/);
    // Before: no warning at all, and every check after it measured the dead
    // child -- stdio-framing (required) FAILED "5/5 rapid pings failed —
    // framing likely broken", oversized-input and extra-params FAILED as
    // unreachable, and sql-injection / path-traversal PASSED as "server
    // defended (rejected or sanitized)" about a process that was gone.
    // The restarted child then accepts the 1 MB value, which oversized-input
    // reports as it does for any server that completes the call.
    expect(report.warnings.filter((w) => w.startsWith("security-"))).toEqual([
      "security-command-injection: the server exited on an injection payload sent to echo.data and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
      "security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (echo.data) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.",
    ]);
    expect(Object.fromEntries(AFTER.map((id) => [id, verdictOf(report, id)]))).toEqual({
      "security-sql-injection": {
        passed: true,
        details: "Tested 3 payloads against echo.data — no database error detected (0 rejected, 3 returned without it)",
      },
      "security-path-traversal": {
        passed: true,
        details:
          "Tested 3 payloads against echo.data — no sensitive file content detected (0 rejected, 3 returned without it)",
      },
      "security-oversized-input": {
        passed: true,
        details: "result -- server processed a 1 MB echo.data without rejecting it (survived)",
      },
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
  }, 60_000);

  it("execution evidence found before the crash is reported first, then the crash", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, "leak-then-exit"] },
      { timeout: 5000, specVersion: "2025-11-25", only: ["tools-list", "security-command-injection"] },
    );
    // Before: FAIL naming the first payload only; the crash on the second
    // was one more "rejected".
    const injection = verdictOf(report, "security-command-injection");
    expect(injection.passed).toBe(false);
    expect(injection.details).toMatch(
      /^Payload "; cat \/etc\/passwd" appears to have executed \(output: root:x:0:0:root:\/root:\/bin\/bash\); server died on payload "\$\(whoami\)" sent to echo\.data: .*exit code 8/,
    );
  }, 30_000);

  it("a child an earlier check killed is 'server unreachable' at the first payload, and is not restarted", async () => {
    // The child exits on tools-call's tools/call, before any payload is sent.
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, "exit-on-call"] },
      { timeout: 5000, specVersion: "2025-11-25", only: ["tools-list", "tools-call", "security-command-injection"] },
    );
    // Before: PASS "Tested 5 payloads against echo.data — server defended
    // (rejected or sanitized)" -- five payloads never sent, all "rejected".
    const injection = verdictOf(report, "security-command-injection");
    expect(injection.passed).toBe(false);
    expect(injection.details).toMatch(
      /^server unreachable: tools\/call echo\.data with payload "; cat \/etc\/passwd" got no response \(connection closed: .*exit code 5/,
    );
    // The payload did not kill it, so nothing is restarted on its account.
    expect(report.warnings.filter((w) => w.includes("was restarted"))).toEqual([]);
  }, 30_000);
});

describe("runComplianceSuite — legacy injection checks over HTTP: a payload that got no answer is not a rejection", () => {
  const ID = "security-command-injection";
  const ONLY = ["tools-list", ID];

  async function injection(stubOpts: SecurityStubOptions, timeout = 3000) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, { timeout, specVersion: "2025-11-25", only: ONLY });
      return {
        verdict: verdictOf(report, ID),
        skipped: skippedOf(report, ID),
        warnings: report.warnings,
        hits: stub.hits,
      };
    } finally {
      await stub.stop();
    }
  }

  it("a server that answers every payload keeps its verdict", async () => {
    const { verdict, warnings, skipped } = await injection({});
    // Measured: not a skip.
    expect(skipped).toBeUndefined();
    expect(verdict).toEqual({
      passed: true,
      details:
        "Tested 5 payloads against sink.data — no command execution detected (0 rejected, 5 returned without it)",
    });
    expect(warnings.filter((w) => w.startsWith(ID))).toEqual([]);
  }, 20_000);

  it("a connection closed on a payload by a server that still serves a ping is unanswered, with a warning", async () => {
    // Before: "(1 rejected, 4 returned without it)" -- the drop counted as
    // the server rejecting the payload, though a WAF, a keep-alive close or
    // one crashed worker of several looks the same from here.
    const { verdict, warnings, hits } = await injection({ injection: "drop" });
    expect(verdict).toEqual({
      passed: true,
      details:
        "Tested 5 payloads against sink.data — no command execution detected (0 rejected, 4 returned without it, 1 unanswered)",
    });
    expect(warnings.filter((w) => w.startsWith(ID))).toEqual([
      `${ID}: a tools/call to sink.data carrying a payload had its connection closed without a response, but the server still served a follow-up ping, so the payload is counted as unanswered rather than as a crash or a rejection. The drop may be a WAF or IPS dropping the request, a keep-alive connection closed as it was sent, or one crashed worker of several; refuse a payload with HTTP 4xx or a JSON-RPC error so a client can tell a refusal from a crash.`,
    ]);
    // The follow-up ping came right after the dropped (second) payload.
    const methods = hits.map((h) => h.method);
    const first = methods.indexOf("tools/call");
    expect(methods.slice(first, first + 4)).toEqual(["tools/call", "tools/call", "ping", "tools/call"]);
  }, 20_000);

  it("a connection closed on a payload by a server that is gone after it FAILS as a possible crash", async () => {
    // Before: PASS "(4 rejected, 1 returned without it)" -- the payload that
    // took the server down and the three refused connections after it.
    const { verdict } = await injection({ injection: "drop", afterDrop: "die" });
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server may have crashed: connection dropped on payload "\$\(whoami\)" sent to sink\.data: other side closed; ping then got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
    );
  }, 20_000);

  it("a payload nothing answers is unanswered, not rejected", async () => {
    // Before: "(1 rejected, 4 returned without it)".
    const { verdict, warnings, skipped } = await injection({ injection: "hang" }, 800);
    // Four payloads were answered: a measurement, not a skip.
    expect(skipped).toBeUndefined();
    expect(verdict).toEqual({
      passed: true,
      details:
        "Tested 5 payloads against sink.data — no command execution detected (0 rejected, 4 returned without it, 1 unanswered)",
    });
    expect(warnings.filter((w) => w.startsWith(ID))).toEqual([]);
  }, 20_000);

  it("no payload answered at all: inconclusive, with a warning, not 'server defended'", async () => {
    // Before: PASS "Tested 5 payloads against sink.data — server defended
    // (rejected or sanitized)" for five calls that all timed out.
    const { verdict, warnings, skipped } = await injection({ injection: "hang-all" }, 500);
    expect(verdict).toEqual({
      passed: true,
      details: "Tested 5 payloads against sink.data — inconclusive: no payload got an answer (see warning)",
    });
    // Nothing was measured, so the pass is flagged as a skip (before: a plain pass).
    expect(skipped).toBe(true);
    expect(warnings.filter((w) => w.startsWith(ID))).toEqual([
      `${ID}: no payload sent to sink.data got an answer (every tools/call timed out, was dropped, or got no usable response), so the verdict is inconclusive.`,
    ]);
  }, 20_000);

  it("an abort while a payload waits is rethrown: no injection check is recorded as passing", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled the run");
    const completed: Verdict[] = [];
    const stub = await startSecurityStub({
      injection: "hang",
      onInjection: () => setTimeout(() => controller.abort(reason), 50),
    });
    try {
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 10_000,
          specVersion: "2025-11-25",
          only: ["tools-list", ID, "security-sql-injection", "security-path-traversal"],
          signal: controller.signal,
          onTestComplete: (t) => {
            if (t.id.startsWith("security-")) completed.push({ passed: t.passed, details: t.details });
          },
        }),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(5000);
      // Before: PASS "Tested 5 payloads against sink.data — no command
      // execution detected (4 rejected, 1 returned without it)" -- four of
      // the five calls cancelled client-side and never sent.
      expect(completed.filter((c) => c.passed)).toEqual([]);
    } finally {
      await stub.stop();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Legacy security-extra-params: the answer to unknown tool arguments, and a
// call that got none, read the way the 2026-07-28 twin reads them. The check
// used to pass any answer without an `error` field -- a 500 blown up by the
// `__proto__` payload included -- and every HTTP transport error as "Request
// rejected (acceptable)".
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy security-extra-params over HTTP", () => {
  const ID = "security-extra-params";
  const ONLY = ["tools-list", ID];

  async function extra(stubOpts: SecurityStubOptions, runOpts: { timeout?: number; only?: string[] } = {}) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: runOpts.timeout ?? 3000,
        specVersion: "2025-11-25",
        only: runOpts.only ?? ONLY,
      });
      return {
        verdict: verdictOf(report, ID),
        skipped: skippedOf(report, ID),
        warnings: report.warnings.filter((w) => w.startsWith(ID)),
        hits: stub.hits,
      };
    } finally {
      await stub.stop();
    }
  }

  const REJECTED = "Extra params rejected with error: -32602 — Invalid params: unknown argument __injected_param__";

  it("a server that ignores or rejects the unknown arguments keeps its verdict, with no warning", async () => {
    const ignored = await extra({});
    expect(ignored.verdict).toEqual({
      passed: true,
      details: "Server processed request (extra params likely ignored)",
    });
    expect(ignored.skipped).toBeUndefined();
    expect(ignored.warnings).toEqual([]);
    expect((await extra({ extraCall: "rpc-error" })).verdict).toEqual({ passed: true, details: REJECTED });
    // The server's own -32602 on an HTTP 400 is the same rejection.
    expect((await extra({ extraCall: "rpc-400" })).verdict).toEqual({ passed: true, details: REJECTED });
  }, 30_000);

  it("a 5xx the payload blew up fails as a server error", async () => {
    // Before: PASS "Server processed request (extra params likely ignored)"
    // -- the status was never read, and the HTML body carries no `error`.
    expect((await extra({ extraCall: "html-500" })).verdict).toEqual({
      passed: false,
      details: "HTTP 500 -- server error on unknown tool arguments",
    });
    // Before: PASS "Extra params rejected with error: -32603 — Internal
    // error" -- a JSON-RPC error body on a 5xx is the server failing, not
    // refusing the arguments.
    expect((await extra({ extraCall: "rpc-500" })).verdict).toEqual({
      passed: false,
      details: "HTTP 500 -- server error on unknown tool arguments",
    });
  }, 20_000);

  it("an answer with neither a result nor an error fails as malformed", async () => {
    // Before: PASS "Server processed request (extra params likely ignored)".
    expect((await extra({ extraCall: "html-200" })).verdict).toEqual({
      passed: false,
      details: "malformed response to unknown tool arguments (HTTP 200, no result or error)",
    });
  }, 20_000);

  it("a connection closed on the call by a server that is gone after it FAILS as a possible crash", async () => {
    // Before: PASS "Request rejected (acceptable)" -- the payload took the
    // server down, and the crash was counted by the checks after it.
    const { verdict, hits } = await extra({ extraCall: "drop", afterDrop: "die" });
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server may have crashed: connection dropped on unknown tool arguments \(tools\/call sink\): other side closed; ping then got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
    );
    expect(hits.at(-1)?.method).toBe("tools/call");
  }, 20_000);

  it("a connection closed on the call by a server that still serves a ping is inconclusive, with a warning", async () => {
    // Before: PASS "Request rejected (acceptable)", with no warning.
    const { verdict, warnings, hits, skipped } = await extra({ extraCall: "drop" });
    expect(verdict).toEqual({
      passed: true,
      details:
        "tools/call sink had its connection closed without a response -- extra-params verdict inconclusive (see warning)",
    });
    // No answer to read: flagged as a skip (before: a plain pass).
    expect(skipped).toBe(true);
    expect(warnings).toEqual([
      `${ID}: tools/call sink with unknown arguments had its connection closed without a response, but the server still served a follow-up ping, so the verdict is inconclusive rather than a crash. The drop may be a WAF or IPS dropping the request, a keep-alive connection closed as it was sent, or one crashed worker of several; reject unknown arguments with a JSON-RPC error or ignore them so a client can tell a refusal from a crash.`,
    ]);
    expect(hits.map((h) => h.method).slice(-2)).toEqual(["tools/call", "ping"]);
  }, 20_000);

  it("a call nothing answers is inconclusive, with a warning", async () => {
    // Before: PASS "Request rejected (acceptable)".
    const { verdict, warnings, skipped } = await extra({ extraCall: "hang" }, { timeout: 800 });
    expect(verdict).toEqual({
      passed: true,
      details: "tools/call sink did not answer within 800ms -- extra-params verdict inconclusive (see warning)",
    });
    // No answer to read: flagged as a skip (before: a plain pass).
    expect(skipped).toBe(true);
    expect(warnings).toEqual([
      `${ID}: tools/call sink with unknown arguments did not answer within 800ms, so the verdict is inconclusive (no answer is neither a rejection nor a crash). Re-run with a larger --timeout or a faster first tool.`,
    ]);
  }, 20_000);

  it("a server already gone before the call is 'server unreachable', not a rejection", async () => {
    // security-oversized-input's 1 MB call takes the server down first.
    // Before: PASS "Request rejected (acceptable)" for a call never sent.
    const { verdict } = await extra(
      { bigCall: "drop", afterDrop: "die" },
      { only: ["tools-list", "security-oversized-input", ID] },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server unreachable: tools\/call sink with unknown arguments got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
    );
  }, 20_000);

  it("bytes that are not an HTTP response fail as no usable response", async () => {
    // Before: PASS "Request rejected (acceptable)".
    const { verdict } = await extra({ extraCall: "not-http" });
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(/^no usable response to unknown tool arguments \(tools\/call sink\): \S/);
  }, 20_000);

  it("an abort while the call waits ends the run at once and is rethrown, never graded as inconclusive", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const stub = await startSecurityStub({
      extraCall: "hang",
      onExtraCall: () => setTimeout(() => controller.abort(reason), 50),
    });
    try {
      const completed: string[] = [];
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 15_000,
          specVersion: "2025-11-25",
          only: ONLY,
          signal: controller.signal,
          onTestComplete: (t) => {
            if (t.id === ID) completed.push(t.details);
          },
        }),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(8000);
      // The harness records the rethrown abort itself; the call is not read
      // as a timeout ("inconclusive") or a drop.
      expect(completed).toEqual(["Error: client went away"]);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});

describe("runComplianceSuite — legacy security-extra-params over stdio: a child that exits on the call died on it", () => {
  const ID = "security-extra-params";
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-extra-params-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, OVERSIZED_STDIO_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const target = () => ({ type: "stdio" as const, command: process.execPath, args: [script, "exit-on-extra"] });

  it("FAILS as died, not unreachable, and restarts the child so the checks after it measure the server", async () => {
    const report = await runComplianceSuite(target(), {
      timeout: 5000,
      specVersion: "2025-11-25",
      only: ["tools-list", "security-oversized-input", ID, "security-tool-rug-pull", "stdio-framing"],
    });
    // The child was alive through the 1 MB line, and died on these arguments.
    expect(verdictOf(report, "security-oversized-input").passed).toBe(true);
    // Before: FAIL "server unreachable: tools/call echo with unknown
    // arguments got no response (connection closed: server crashed with
    // exit code 7 ...)" -- the phrase for a probe that measured nothing, on
    // the crash this probe caused -- and the child stayed dead:
    // stdio-framing (required) FAILED "5/5 rapid pings failed — framing
    // likely broken" and rug-pull FAILED "Second tools/list call threw an
    // error".
    const extra = verdictOf(report, ID);
    expect(extra.passed).toBe(false);
    expect(extra.details).toMatch(/^server died on unknown tool arguments \(tools\/call echo\): .*exit code 7/);
    expect(report.warnings.filter((w) => w.startsWith(ID))).toEqual([
      "security-extra-params: the server exited on unknown tool arguments (tools/call echo) and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
    expect(verdictOf(report, "security-tool-rug-pull")).toEqual({
      passed: true,
      details: "1 tool(s) consistent across 2 calls",
    });
    expect(verdictOf(report, "stdio-framing")).toEqual({ passed: true, details: "5/5 rapid pings returned cleanly" });
  }, 60_000);

  it("with security-oversized-input filtered out, the call that killed a live child still reads as died", async () => {
    // tools-list was served one request earlier, so the child was alive.
    // Before: FAIL "server unreachable: ..." here too -- read from an exit
    // flag checked only after the call, as if the child had been gone
    // already.
    const report = await runComplianceSuite(target(), {
      timeout: 5000,
      specVersion: "2025-11-25",
      only: ["tools-list", ID],
    });
    expect(verdictOf(report, ID).details).toMatch(
      /^server died on unknown tool arguments \(tools\/call echo\): .*exit code 7/,
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Legacy security-origin-validation: every status >= 400 used to pass as
// "suspicious Origin rejected" -- a 5xx, a rate limiter's 429, and the auth
// gate or Host guard that refuses every request -- none of which shows the
// Origin was even looked at.
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy security-origin-validation reads the status the way security-auth-required does", () => {
  const ID = "security-origin-validation";
  const TOKEN = "tok-3e9d";

  async function origin(stubOpts: SecurityStubOptions, authorization?: string) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: [ID],
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
      });
      return { verdict: verdictOf(report, ID), pings: stub.hits.filter((h) => h.method === "ping").length };
    } finally {
      await stub.stop();
    }
  }

  it("an Origin guard's 403, or another 4xx, next to the served handshake keeps its PASS", async () => {
    expect((await origin({ foreignOrigin: "bare-403" })).verdict).toEqual({
      passed: true,
      details: "HTTP 403 (suspicious Origin rejected)",
    });
    expect((await origin({ foreignOrigin: 400 })).verdict).toEqual({
      passed: true,
      details: "HTTP 400 (suspicious Origin rejected)",
    });
    // Behind an auth gate the credential gets the handshake through, so the
    // Origin is the one variable.
    expect((await origin({ token: TOKEN, foreignOrigin: "bare-403" }, `Bearer ${TOKEN}`)).verdict).toEqual({
      passed: true,
      details: "HTTP 403 (suspicious Origin rejected)",
    });
  }, 30_000);

  it("a 5xx fails as the server failing on the request, not as Origin validation", async () => {
    // Before: PASS "HTTP 500 (suspicious Origin rejected)" / "HTTP 503
    // (suspicious Origin rejected)" -- a server that never read the Origin.
    expect((await origin({ foreignOrigin: 500 })).verdict).toEqual({
      passed: false,
      details:
        "HTTP 500, JSON-RPC error -32603 -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend); an untrusted Origin MUST draw 403",
    });
    expect((await origin({ foreignOrigin: "503-text" })).verdict).toEqual({
      passed: false,
      details:
        "HTTP 503 -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend); an untrusted Origin MUST draw 403",
    });
  }, 30_000);

  it("a 429 is resent once: a second 429 is not evaluable, and the answer after one decides", async () => {
    // Before: PASS "HTTP 429 (suspicious Origin rejected)" without resending.
    const limited = await origin({ foreignOrigin: 429 });
    expect(limited.verdict).toEqual({
      passed: false,
      details:
        "HTTP 429, then after 0ms HTTP 429 -- not evaluable: a rate limiter answered before the server read the request, so the Origin was never checked",
    });
    expect(limited.pings).toBe(2);
    const once = await origin({ foreignOrigin: "429-then-403" });
    expect(once.verdict).toEqual({
      passed: true,
      details: "HTTP 429, then after 0ms HTTP 403 (suspicious Origin rejected)",
    });
    expect(once.pings).toBe(2);
  }, 30_000);

  it("the 401/403 a gate answers every request with skips: it is not attributable to the Origin", async () => {
    // Before: PASS "HTTP 401 (suspicious Origin rejected)" for an auth gate
    // refusing a run without --auth, and PASS "HTTP 403 (suspicious Origin
    // rejected)" for a Host guard refusing every request, credentialed or
    // not -- the Origin never looked at.
    expect((await origin({ token: TOKEN, noAuth: "401" })).verdict).toEqual({
      passed: true,
      details:
        "Skipped: HTTP 401 to the foreign Origin, but initialize was not served either, so the refusal is not attributable to the Origin (see security-auth-required)",
    });
    const guard = { token: TOKEN, noAuth: "bare-403", bare403Message: "Invalid Host: 127.0.0.1" } as const;
    expect((await origin(guard, "Bearer not-the-configured-token")).verdict).toEqual({
      passed: true,
      details:
        "Skipped: HTTP 403 to the foreign Origin, but initialize was not served either, so the refusal is not attributable to the Origin (see security-auth-required)",
    });
  }, 30_000);

  it("a server that checks the Origin before the credential: a 403 that differs from initialize's 401 counts", async () => {
    // No --auth: initialize drew the gate's 401, the foreign Origin the
    // guard's 403 -- a different answer, so the Origin decided it.
    expect((await origin({ token: TOKEN, noAuth: "401", foreignOrigin: "bare-403" })).verdict).toEqual({
      passed: true,
      details: "HTTP 403 (suspicious Origin rejected)",
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Legacy security-rate-limiting: a burst refused before it reached a handler,
// or never answered at all, used to report "No rate limiting detected" -- a
// claim about a limiter the burst never reached.
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy security-rate-limiting: a burst that never reached a handler measured nothing", () => {
  const ID = "security-rate-limiting";
  const TOKEN = "tok-3e9d";

  async function burst(stubOpts: SecurityStubOptions, authorization?: string) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: [ID],
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
      });
      return verdictOf(report, ID);
    } finally {
      await stub.stop();
    }
  }

  it("a quiet burst still fails, and a limiter's 429 still passes", async () => {
    expect(await burst({})).toEqual({
      passed: false,
      details: "No rate limiting detected (50 rapid requests all returned 200)",
    });
    expect(await burst({ token: TOKEN, noAuth: 429 })).toEqual({
      passed: true,
      details: "Rate limiting detected (429 returned after 50 rapid requests)",
    });
  }, 30_000);

  it("a bare 403 on every ping is read as security-auth-required reads it, not as a missing limiter", async () => {
    // Before: FAIL "No rate limiting detected (50 rapid requests all
    // returned 403)" -- from statuses security-auth-required, in the same
    // report, declares unattributable.
    const guard = { token: TOKEN, noAuth: "bare-403", bare403Message: "Invalid Host: 127.0.0.1" } as const;
    const expected = {
      passed: false,
      details:
        'HTTP 403 ("Invalid Host: 127.0.0.1") on all 50 rapid pings, which does not read as an auth refusal -- not evaluable: it may be Host/Origin validation or a gateway refusing every request before the server reads it, so rate limiting was not measured (see security-auth-required)',
    };
    expect(await burst(guard)).toEqual(expected);
    expect(await burst(guard, "Bearer not-the-configured-token")).toEqual(expected);
  }, 30_000);

  it("an auth gate's 401, or a 403 carrying a Bearer challenge, on every ping names the credential, not a missing limiter", async () => {
    // Before: FAIL "No rate limiting detected (50 rapid requests all returned 401)".
    expect(await burst({ token: TOKEN, noAuth: "401" })).toEqual({
      passed: false,
      details:
        "HTTP 401 on all 50 rapid pings -- not evaluable: an auth gate answered before the server read the requests (pass --auth), so rate limiting was not measured",
    });
    // Before: FAIL "No rate limiting detected (50 rapid requests all returned 403)".
    expect(await burst({ token: TOKEN, noAuth: "bearer-403" })).toEqual({
      passed: false,
      details:
        "HTTP 403 on all 50 rapid pings -- not evaluable: an auth gate answered before the server read the requests (pass --auth), so rate limiting was not measured",
    });
    expect(await burst({ token: TOKEN, noAuth: "401" }, "Bearer not-the-configured-token")).toEqual({
      passed: false,
      details:
        "HTTP 401 on all 50 rapid pings -- not evaluable: an auth gate answered before the server read the requests (credential rejected -- check --auth), so rate limiting was not measured",
    });
  }, 30_000);

  it("a burst nothing answered is 'server unreachable'", async () => {
    // Before: FAIL "No rate limiting detected (50 rapid requests all returned 0)".
    const report = await runComplianceSuite(DEAD_URL, { timeout: 2000, specVersion: "2025-11-25", only: [ID] });
    const verdict = verdictOf(report, ID);
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toMatch(
      /^server unreachable: every one of the 50 rapid pings got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:1\)$/,
    );
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Legacy auth checks: an answer that is neither a 401 nor a 403 was worded
// "server accepted ..." whatever it was -- a rate limiter's 429, an edge's
// 503, a 302 to an SSO login. Every one still fails; only a request that was
// served is "accepted".
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy auth checks word an answer that is no authentication refusal for what it is", () => {
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const IDS = ["security-auth-required", "security-auth-malformed", "security-session-not-auth"];

  async function verdicts(stubOpts: SecurityStubOptions, headers?: Record<string, string>) {
    const stub = await startSecurityStub({ session: true, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: IDS,
        ...(headers ? { headers } : {}),
      });
      return Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    } finally {
      await stub.stop();
    }
  }

  const expected = (answer: string, reading: string) => ({
    "security-auth-required": `FAIL: ${answer} on the unauthenticated ping -- ${reading}; the spec answers a missing credential with 401`,
    "security-auth-malformed": `FAIL: ${answer} on the ping carrying a malformed credential -- ${reading}; the spec answers an invalid token with 401`,
    "security-session-not-auth": `FAIL: ${answer} on the ping carrying only the session ID -- ${reading}; the spec answers a request without a credential with 401, whatever session it names`,
  });

  it("--auth: a rate limiter's 429 in front of the server is a refusal, but not an authentication one", async () => {
    // Before: "HTTP 429 — server accepted unauthenticated request", "HTTP
    // 429 — server accepted malformed auth token" and "HTTP 429 — server
    // accepted session ID without auth" about a gate that refused all three.
    expect(await verdicts({ token: TOKEN, noAuth: 429 }, AUTH)).toEqual(
      expected(
        "HTTP 429",
        "the request was refused, but not as an authentication refusal (a wrong path, a gateway or a rate limiter)",
      ),
    );
  }, 30_000);

  it("--auth: an edge's 503 is the server failing, not accepting", async () => {
    expect(await verdicts({ token: TOKEN, noAuth: 503 }, AUTH)).toEqual(
      expected(
        "HTTP 503",
        "the server failed on the request rather than refusing it (a broken server, or a gateway with no backend)",
      ),
    );
  }, 30_000);

  it("--auth: a 302 to an SSO login redirects instead of answering, and a 200 login page serves no JSON-RPC", async () => {
    expect(await verdicts({ token: TOKEN, noAuth: 302 }, AUTH)).toEqual(
      expected("HTTP 302", "the server redirected the request instead of answering it"),
    );
    expect(await verdicts({ token: TOKEN, noAuth: "login-200" }, AUTH)).toEqual(
      expected("HTTP 200", "a non-JSON-RPC body, neither served nor refused (a login page or an intermediary's page)"),
    );
  }, 30_000);

  it("--auth: a server that serves all three probes keeps the 'accepted' wording", async () => {
    expect(await verdicts({}, AUTH)).toEqual({
      "security-auth-required": "FAIL: HTTP 200 — server accepted unauthenticated request",
      "security-auth-malformed": "FAIL: HTTP 200 — server accepted malformed auth token",
      "security-session-not-auth":
        "FAIL: HTTP 200 — server accepted session ID without auth (spec: MUST NOT use sessions for authentication)",
    });
  }, 30_000);
});

describe("runComplianceSuite — legacy security-auth-required without --auth reads 'accepted' only from a served request", () => {
  const ID = "security-auth-required";
  const TOKEN = "tok-3e9d";

  async function authRequired(stubOpts: SecurityStubOptions) {
    const stub = await startSecurityStub({ token: TOKEN, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 3000, specVersion: "2025-11-25", only: [ID] });
      return { verdict: verdictOf(report, ID), serverName: report.serverInfo.name };
    } finally {
      await stub.stop();
    }
  }

  it("a gateway that lets server/discover through to the server but answers every other unauthenticated request 401 passes on initialize's 401", async () => {
    // Before: FAIL "Server does not require auth (no --auth provided and
    // server accepted unauthenticated requests)" -- from the -32601 the
    // server answered the era probe with, next to a 401 on initialize.
    const { verdict, serverName } = await authRequired({ noAuth: "401", discoverOpen: "method-not-found" });
    expect(serverName).toBeNull();
    expect(verdict).toEqual({
      passed: true,
      details:
        "HTTP 401 on initialize (unauthenticated request rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
    });
  }, 20_000);

  it("an edge that 503s, 302s to an SSO login, or serves a login page to anonymous traffic fails naming that answer, not as accepting", async () => {
    // Before: every one FAILED "Server does not require auth (no --auth
    // provided and server accepted unauthenticated requests)" though nothing
    // was ever served.
    const tail = "the spec answers a missing credential with 401";
    expect((await authRequired({ noAuth: 503 })).verdict).toEqual({
      passed: false,
      details: `HTTP 503 on the unauthenticated preflight -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend); ${tail}`,
    });
    expect((await authRequired({ noAuth: 302 })).verdict).toEqual({
      passed: false,
      details: `HTTP 302 on the unauthenticated preflight -- the server redirected the request instead of answering it; ${tail}`,
    });
    expect((await authRequired({ noAuth: "login-200" })).verdict).toEqual({
      passed: false,
      details: `HTTP 200 on the unauthenticated preflight -- a non-JSON-RPC body, neither served nor refused (a login page or an intermediary's page); ${tail}`,
    });
  }, 30_000);

  it("a preflight the server served is still proof it accepts unauthenticated requests, whatever initialize drew", async () => {
    const { verdict } = await authRequired({ noAuth: "401", discoverOpen: "served" });
    expect(verdict).toEqual({
      passed: false,
      details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
    });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The sibling auth probes' not-evaluable skip used to be a flag that only
// security-auth-required's body set, so --only / --skip leaving it out of
// the run restored the false PASS on a Host guard's 403.
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy auth probes read the not-evaluable 403 without security-auth-required in the run", () => {
  const TOKEN = "tok-3e9d";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const SIBLINGS = [
    "security-www-authenticate",
    "security-auth-malformed",
    "security-session-not-auth",
    "security-token-in-uri",
  ];

  async function probes(stubOpts: SecurityStubOptions, only: string[]) {
    const stub = await startSecurityStub({ token: TOKEN, session: true, ...stubOpts });
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only,
        headers: AUTH,
      });
      const verdicts = Object.fromEntries(
        report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]),
      ) as Record<string, string>;
      return { verdicts, hits: stub.hits };
    } finally {
      await stub.stop();
    }
  }

  it("--only the siblings: a bare 403 the credential does not get past either still skips them", async () => {
    // Before: PASS "HTTP 403 (WWW-Authenticate not applicable for 403)",
    // "HTTP 403 (malformed auth rejected)", "HTTP 403 (session ID alone not
    // sufficient for auth)" and "HTTP 403 (token in query string rejected)"
    // -- while the full run skips all four as not evaluable.
    const { verdicts, hits } = await probes({ noAuth: "bare-403", authedPing: "bare-403" }, SIBLINGS);
    for (const id of SIBLINGS) {
      expect(verdicts[id], id).toBe(`PASS: ${AUTH_NOT_EVALUABLE}`);
    }
    // The comparison is asked once for all four, not once per probe: the
    // unauthenticated ping, then its twin carrying the credential -- and
    // then token-in-uri's own probe (no Authorization, the token in the
    // URI), sent before the attribution is read so a server accepting it
    // would still fail. Before: the probe was never sent.
    expect(hits.filter((h) => h.method === "ping").map((h) => h.authorization)).toEqual([
      undefined,
      AUTH.Authorization,
      undefined,
    ]);
  }, 30_000);

  it("with security-auth-required in the run, the siblings reuse its two pings instead of asking again", async () => {
    const { verdicts, hits } = await probes({ noAuth: "bare-403", authedPing: "bare-403" }, [
      "security-auth-required",
      ...SIBLINGS,
    ]);
    expect(verdicts["security-auth-required"]).toMatch(/^FAIL: HTTP 403 \("Forbidden"\) .* -- not evaluable: /);
    for (const id of SIBLINGS) {
      expect(verdicts[id], id).toBe(`PASS: ${AUTH_NOT_EVALUABLE}`);
    }
    // auth-required's two pings, then token-in-uri's probe (before: never sent).
    expect(hits.filter((h) => h.method === "ping").map((h) => h.authorization)).toEqual([
      undefined,
      AUTH.Authorization,
      undefined,
    ]);
  }, 30_000);

  it("--only the siblings: a bare 403 the credentialed ping gets past, or a 401, is still measured", async () => {
    const attributed = await probes({ noAuth: "bare-403" }, SIBLINGS);
    expect(attributed.verdicts).toEqual({
      "security-www-authenticate": "PASS: HTTP 403 (WWW-Authenticate not applicable for 403)",
      "security-auth-malformed": "PASS: HTTP 403 (malformed auth rejected)",
      "security-session-not-auth": "PASS: HTTP 403 (session ID alone not sufficient for auth)",
      "security-token-in-uri": "PASS: HTTP 403 (token in query string rejected)",
    });
    const unauthorized = await probes({ noAuth: "401" }, SIBLINGS);
    expect(unauthorized.verdicts).toEqual({
      "security-www-authenticate": 'PASS: WWW-Authenticate: Bearer realm="mcp"',
      "security-auth-malformed": "PASS: HTTP 401 (malformed auth rejected)",
      "security-session-not-auth": "PASS: HTTP 401 (session ID alone not sufficient for auth)",
      "security-token-in-uri": "PASS: HTTP 401 (token in query string rejected)",
    });
  }, 30_000);

  it("security-www-authenticate reads the challenge on a 403 carrying one, the way it reads a 401's", async () => {
    // Before: PASS "HTTP 403 (WWW-Authenticate not applicable for 403)" about
    // a response that carried the challenge security-auth-required passed on.
    const { verdicts } = await probes({ noAuth: "bearer-403" }, ["security-auth-required", SIBLINGS[0]]);
    expect(verdicts).toEqual({
      "security-auth-required": "PASS: HTTP 403 (unauthenticated request rejected)",
      "security-www-authenticate": 'PASS: WWW-Authenticate: Bearer realm="mcp" (HTTP 403)',
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// lifecycle-reinit-reject used to credit any JSON-RPC error or any status
// >= 400 on the duplicate as the server rejecting it -- an auth gate, a Host
// guard, a rate limiter or an edge with no backend answering in its place,
// and a "duplicate" of a handshake that was never served.
// ---------------------------------------------------------------------------

describe("runComplianceSuite — legacy lifecycle-reinit-reject credits only the server's own answer to a duplicate", () => {
  const ID = "lifecycle-reinit-reject";

  async function reinit(stubOpts: SecurityStubOptions, headers?: Record<string, string>): Promise<string> {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: [ID],
        ...(headers ? { headers } : {}),
      });
      const v = verdictOf(report, ID);
      return `${v.passed ? "PASS" : "FAIL"}: ${v.details}`;
    } finally {
      await stub.stop();
    }
  }

  it("the handshake was not served: whatever answers the second initialize is not evaluable", async () => {
    const tail = "not evaluable: the first initialize was not served, so this one is no duplicate (see lifecycle-init)";
    // Before: PASS "Re-initialization rejected with error: -32001 — Unauthorized".
    expect(await reinit({ token: "tok-3e9d", noAuth: "401" })).toBe(
      `FAIL: HTTP 401, JSON-RPC error -32001 on the second initialize -- ${tail}`,
    );
    // Before: PASS "Re-initialization rejected with error: -32000 — Invalid Host: 127.0.0.1".
    expect(await reinit({ token: "tok-3e9d", noAuth: "bare-403", bare403Message: "Invalid Host: 127.0.0.1" })).toBe(
      `FAIL: HTTP 403, JSON-RPC error -32000 on the second initialize -- ${tail}`,
    );
    // Before: PASS "HTTP 503 (re-initialization rejected)".
    expect(await reinit({ token: "tok-3e9d", noAuth: 503 })).toBe(`FAIL: HTTP 503 on the second initialize -- ${tail}`);
  }, 30_000);

  it("the handshake was served: an edge's 5xx or a rate limiter's 429 in place of the server's answer is not evaluable", async () => {
    // Before: PASS "Re-initialization rejected with error: -32000 — Service Unavailable".
    expect(await reinit({ reinit: 503 })).toBe(
      "FAIL: HTTP 503, JSON-RPC error -32000 on the second initialize -- not evaluable: a server error (or a gateway with no backend) is a failure, not a rejection of the duplicate",
    );
    // Before: PASS "HTTP 502 (re-initialization rejected)".
    expect(await reinit({ reinit: "502-html" })).toBe(
      "FAIL: HTTP 502 on the second initialize -- not evaluable: a server error (or a gateway with no backend) is a failure, not a rejection of the duplicate",
    );
    // Before: PASS "HTTP 429 (re-initialization rejected)". Resent once after
    // Retry-After; the second 429 decides.
    expect(await reinit({ reinit: 429 })).toBe(
      "FAIL: HTTP 429, then after 0ms HTTP 429 on the second initialize -- not evaluable: a rate limiter answered before the server read the request",
    );
  }, 30_000);

  it("the handshake was served: an auth gate's 401 or a Host guard's 403 on the duplicate is not evaluable", async () => {
    // A credential refused mid-run. Before: PASS "Re-initialization rejected
    // with error: -32001 — Unauthorized".
    expect(await reinit({ reinit: 401 }, { Authorization: "Bearer tok-3e9d" })).toBe(
      "FAIL: HTTP 401, JSON-RPC error -32001 on the second initialize -- not evaluable: an auth gate answered before the server read the request (credential rejected -- check --auth)",
    );
    // Before: PASS "Re-initialization rejected with error: -32000 — Invalid Host: mcp.internal.example".
    expect(await reinit({ reinit: "host-403" })).toBe(
      'FAIL: HTTP 403, JSON-RPC error -32000 on the second initialize ("Invalid Host: mcp.internal.example") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries',
    );
  }, 30_000);

  it("the handshake was served: a redirect answering the duplicate is neither a rejection nor an acceptance", async () => {
    // Before: FAIL "Server accepted second initialize (HTTP 302) — should
    // reject duplicate initialization".
    expect(await reinit({ reinit: 302 })).toBe(
      "FAIL: HTTP 302 on the second initialize -- redirected instead of answered: neither a rejection nor a served duplicate",
    );
  }, 30_000);

  it("the server's own rejection passes, also when a rate limiter throttled the first attempt", async () => {
    expect(await reinit({ reinit: "rpc-400" })).toBe(
      "PASS: Re-initialization rejected with error: -32600 — Invalid Request: Server already initialized",
    );
    // Before: PASS "HTTP 429 (re-initialization rejected)" -- the rate
    // limiter's answer, not the server's.
    expect(await reinit({ reinit: "429-once" })).toBe(
      "PASS: Re-initialization rejected with error: -32600 — Invalid Request: Server already initialized",
    );
  }, 30_000);

  it("an SDK v1 server's own answer to the duplicate passes", async () => {
    const sdk = await startSdkProgressServer(false);
    try {
      const report = await runComplianceSuite(sdk.url, { timeout: 5000, specVersion: "2025-11-25", only: [ID] });
      expect(verdictOf(report, ID)).toEqual({
        passed: true,
        details: "Re-initialization rejected with error: -32600 — Invalid Request: Server already initialized",
      });
    } finally {
      await sdk.stop();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Passes that measured nothing -- the check's subject was absent, or no
// answer came back to read -- carry TestResult.skipped, as the checks worded
// "Skipped ...", "(skipped)" or "not applicable" already did. Before, these
// were plain passes: the harness infers a skip only from those markers.
// Score math does not move (a skip is still passed: true); only the flag,
// and details that claimed an answer that never came, do.
// ---------------------------------------------------------------------------
describe("runComplianceSuite — legacy passes that measured nothing are flagged as skips", () => {
  async function runStub(
    stubOpts: SecurityStubOptions,
    only: string[],
    runOpts: { timeout?: number; headers?: Record<string, string> } = {},
  ) {
    const stub = await startSecurityStub(stubOpts);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: runOpts.timeout ?? 3000,
        specVersion: "2025-11-25",
        only,
        ...(runOpts.headers ? { headers: runOpts.headers } : {}),
      });
      return { report, hits: stub.hits };
    } finally {
      await stub.stop();
    }
  }
  /** passed, details and the skip flag of each id, in one comparable object. */
  const flagged = (report: Awaited<ReturnType<typeof runComplianceSuite>>, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { ...verdictOf(report, id), skipped: skippedOf(report, id) }]));

  it("a server that declares tools, resources and prompts but lists none: each check that validates listed items has nothing to validate", async () => {
    const ids = [
      "tools-schema",
      "tools-annotations",
      "tools-title-field",
      "tools-output-schema",
      "resources-schema",
      "prompts-schema",
      "security-tool-schema-defined",
      "security-tool-description-poisoning",
      "error-capability-gated",
    ];
    const { report } = await runStub({ lists: "empty" }, ["tools-list", "resources-list", "prompts-list", ...ids]);
    const none = (what: string) => ({ passed: true, details: `No ${what} to validate`, skipped: true });
    // Before: "All tools have valid schemas", "All resources valid" and "All
    // prompts valid" about empty lists, and "No tools to validate" / "... no
    // undeclared methods to test" as plain passes.
    expect(flagged(report, ids)).toEqual({
      "tools-schema": none("tools"),
      "tools-annotations": none("tools"),
      "tools-title-field": none("tools"),
      "tools-output-schema": none("tools"),
      "resources-schema": none("resources"),
      "prompts-schema": none("prompts"),
      "security-tool-schema-defined": none("tools"),
      "security-tool-description-poisoning": none("tools"),
      "error-capability-gated": {
        passed: true,
        details: "Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
        skipped: true,
      },
    });
    // The lists themselves were served and read: verdicts, not skips.
    expect(flagged(report, ["tools-list", "resources-list"])).toEqual({
      "tools-list": { passed: true, details: "0 tool(s): ", skipped: undefined },
      "resources-list": { passed: true, details: "0 resource(s)", skipped: undefined },
    });
  }, 20_000);

  it("the same checks against a listed tool validate it: no flag", async () => {
    const ids = ["tools-schema", "security-tool-schema-defined", "security-tool-description-poisoning"];
    const { report } = await runStub({}, ["tools-list", ...ids]);
    expect(flagged(report, ids)).toEqual({
      "tools-schema": { passed: true, details: "All tools have valid schemas", skipped: undefined },
      "security-tool-schema-defined": {
        passed: true,
        details: "All 1 tool(s) have inputSchema defined",
        skipped: undefined,
      },
      "security-tool-description-poisoning": {
        passed: true,
        details: "1 tool(s) scanned — no injection patterns found",
        skipped: undefined,
      },
    });
  }, 20_000);

  it("tools-content-types: a call answered with no content items has nothing to validate", async () => {
    const empty = await runStub({ emptyContent: true }, ["tools-list", "tools-content-types"]);
    expect(flagged(empty.report, ["tools-content-types"])).toEqual({
      "tools-content-types": { passed: true, details: "No content items to validate", skipped: true },
    });
    const text = await runStub({}, ["tools-list", "tools-content-types"]);
    expect(flagged(text.report, ["tools-content-types"])).toEqual({
      "tools-content-types": { passed: true, details: "Content types: text", skipped: undefined },
    });
  }, 20_000);

  it("tools-content-types: a call answered with malformed content was answered, so it is no skip", async () => {
    // A content field that is a string, and a response with neither a
    // result nor an error: the server answered, and tools-call fails the
    // same answer. Before this fix both carried skipped: true ("measured
    // nothing"); the verdict and details are left as they were.
    const ids = ["tools-call", "tools-content-types"];
    const stringContent = await runStub({ malformedCall: "string-content" }, ["tools-list", ...ids]);
    expect(flagged(stringContent.report, ids)).toEqual({
      "tools-call": { passed: false, details: "Response missing content array", skipped: undefined },
      "tools-content-types": { passed: true, details: "No content items to validate", skipped: undefined },
    });
    const noResult = await runStub({ malformedCall: "no-result" }, ["tools-list", ...ids]);
    expect(flagged(noResult.report, ids)).toEqual({
      "tools-call": { passed: false, details: "Response missing content array", skipped: undefined },
      "tools-content-types": { passed: true, details: "No content items to validate", skipped: undefined },
    });
  }, 20_000);

  it("the injection checks: a tool with no string argument leaves nothing to inject into", async () => {
    const ids = ["security-command-injection", "security-sql-injection", "security-path-traversal"];
    const { report, hits } = await runStub({ numericSink: true }, ["tools-list", ...ids]);
    expect(flagged(report, ids)).toEqual(
      Object.fromEntries(
        ids.map((id) => [id, { passed: true, details: "No tools with string parameters to test", skipped: true }]),
      ),
    );
    expect(hits.filter((h) => h.method === "tools/call")).toEqual([]);
  }, 20_000);

  it("security-www-authenticate: no 401 to read a challenge from is a skip; a 401 read is not", async () => {
    const AUTH = { Authorization: "Bearer tok-3e9d" };
    // --auth against a server that needs none: the unauthenticated ping is served.
    const open = await runStub({}, ["security-www-authenticate"], { headers: AUTH });
    expect(flagged(open.report, ["security-www-authenticate"])).toEqual({
      "security-www-authenticate": { passed: true, details: "HTTP 200 — not a 401 response", skipped: true },
    });
    // A gate that drops the unauthenticated ping next to the served
    // credentialed handshake: a refusal, but still no challenge to check.
    const dropped = await runStub({ token: "tok-3e9d", noAuth: "drop" }, ["security-www-authenticate"], {
      headers: AUTH,
    });
    expect(flagged(dropped.report, ["security-www-authenticate"])).toEqual({
      "security-www-authenticate": {
        passed: true,
        details: "Connection closed without a response (other side closed) — not a 401 response, no challenge to check",
        skipped: true,
      },
    });
    const challenged = await runStub({ token: "tok-3e9d", noAuth: "401" }, ["security-www-authenticate"], {
      headers: AUTH,
    });
    expect(flagged(challenged.report, ["security-www-authenticate"])).toEqual({
      "security-www-authenticate": {
        passed: true,
        details: 'WWW-Authenticate: Bearer realm="mcp"',
        skipped: undefined,
      },
    });
  }, 30_000);

  it("lifecycle-progress-token: a call nothing answers observed nothing, and says so instead of 'handled'", async () => {
    // Before: PASS "Request with progressToken handled (no progress events
    // observed — optional)", unflagged, for a tools/call that timed out.
    const { report } = await runStub({ progressCall: "hang" }, ["tools-list", "lifecycle-progress-token"], {
      timeout: 800,
    });
    expect(flagged(report, ["lifecycle-progress-token"])).toEqual({
      "lifecycle-progress-token": {
        passed: true,
        details: "tools/call with progressToken got no response within 800ms (no progress events observed -- optional)",
        skipped: true,
      },
    });
  }, 20_000);

  it("the error-disclosure checks: over HTTP, probes nothing answered are 'server unreachable', not a clean scan", async () => {
    const ids = ["security-error-no-stacktrace", "security-error-no-internal-ip"];
    // Before: PASS "0 error responses checked — no stack traces or sensitive
    // data found" and PASS "No response to check (connection error)".
    const dropped = await runStub({ errorProbes: "drop" }, ids);
    expect(flagged(dropped.report, ids)).toEqual({
      "security-error-no-stacktrace": {
        passed: false,
        details:
          "server unreachable: none of the 3 error probes was answered (the first got no response (connection closed: other side closed)), so there are no error responses to scan",
        skipped: undefined,
      },
      "security-error-no-internal-ip": {
        passed: false,
        details:
          "server unreachable: the error probe (an unknown method) got no response (connection closed: other side closed), so there is no error response to scan",
        skipped: undefined,
      },
    });
    const hung = await runStub({ errorProbes: "hang" }, ids, { timeout: 500 });
    expect(flagged(hung.report, ids)).toEqual({
      "security-error-no-stacktrace": {
        passed: false,
        details:
          "server unreachable: none of the 3 error probes was answered (the first got no response within 500ms), so there are no error responses to scan",
        skipped: undefined,
      },
      "security-error-no-internal-ip": {
        passed: false,
        details:
          "server unreachable: the error probe (an unknown method) got no response within 500ms, so there is no error response to scan",
        skipped: undefined,
      },
    });
  }, 30_000);

  it("the error-disclosure checks: a server that answers its error probes keeps its verdicts", async () => {
    const ids = ["security-error-no-stacktrace", "security-error-no-internal-ip"];
    const { report } = await runStub({}, ids);
    expect(flagged(report, ids)).toEqual({
      "security-error-no-stacktrace": {
        passed: true,
        details: "3 error responses checked — no stack traces or sensitive data found",
        skipped: undefined,
      },
      "security-error-no-internal-ip": {
        passed: true,
        details: "No internal IP addresses found in error responses",
        skipped: undefined,
      },
    });
  }, 20_000);

  it("the error-disclosure checks: an abort while an error probe waits ends the run at once and is rethrown", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled the run");
    const completed: Verdict[] = [];
    const stub = await startSecurityStub({
      errorProbes: "hang",
      onErrorProbe: () => setTimeout(() => controller.abort(reason), 50),
    });
    try {
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 4000,
          specVersion: "2025-11-25",
          only: ["security-error-no-stacktrace", "security-error-no-internal-ip"],
          signal: controller.signal,
          onTestComplete: (t) => completed.push({ passed: t.passed, details: t.details }),
        }),
      ).rejects.toBe(reason);
      // Before: the probes ignored the caller's signal and waited out the
      // timeout, one after another.
      expect(Date.now() - started).toBeLessThan(3000);
      // Nothing graded as a pass on the abort (before: "0 error responses
      // checked", then "No response to check (connection error)").
      expect(completed.filter((c) => c.passed)).toEqual([]);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});
