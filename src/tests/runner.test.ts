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
 *   answers every tools/call with a JSON-RPC -32602 error.
 *
 * Records every POST.
 */
async function startLegacyStub(opts: {
  gateway?: { apiKey: string; token: string; queryToken: boolean };
  toolCall?: "executes" | "invalid-params";
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
