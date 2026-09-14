import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BenchmarkResult, describeProbeFailure, formatBenchmark, runBenchmark } from "../benchmark.js";
import type { TransportTarget } from "../types.js";
import {
  type HttpFixture,
  LEGACY_ECHO_FIXTURE,
  LEGACY_SILENT_FIXTURE,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * A legacy stdio server whose unguarded dispatcher THROWS on an unknown
 * pre-initialize method, so the era probe kills it (the same shape
 * detect.test.ts uses). Answers initialize / ping once up.
 */
const CRASH_ON_PROBE_SERVER = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "crash-on-probe", version: "1" } } });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    default:
      throw new Error("unhandled method " + msg.method);
  }
});
rl.on("close", () => process.exit(0));
`;

/**
 * A dual-era counting stub: answers `server/discover` with a
 * DiscoverResult, `initialize` with an InitializeResult, `ping` with {},
 * and tallies every method it sees -- so a test can assert exactly which
 * requests a benchmark sent around its timed loop.
 */
async function startCountingServer(): Promise<{ url: string; counts: Record<string, number>; stop(): Promise<void> }> {
  const counts: Record<string, number> = {};
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      let msg: { id?: unknown; method?: string } = {};
      try {
        msg = JSON.parse(body);
      } catch {}
      const method = msg.method ?? "?";
      counts[method] = (counts[method] ?? 0) + 1;
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown;
      if (method === "server/discover") {
        result = {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: {},
          ttlMs: 0,
          cacheScope: "public",
        };
      } else if (method === "initialize") {
        result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "counting", version: "1" } };
      } else {
        result = {};
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
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
    counts,
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/**
 * `benchmark` is spec-aware: it resolves the era the way the runner does
 * (one modern `server/discover` probe) and measures the request that era
 * guarantees — `ping` after the initialize handshake on 2025-11-25,
 * `server/discover` with the conformant envelope on 2026-07-28.
 *
 * Fixtures: the modern fixture (stdio and HTTP) answers `server/discover`
 * and rejects a legacy-shaped `ping` with a JSON-RPC error (-32020 for the
 * missing MCP-Protocol-Version header on HTTP, -32602 for the missing
 * `_meta` on stdio -- envelope validation runs before dispatch); the
 * legacy echo fixture (stdio) answers `initialize` + `ping` and rejects
 * `server/discover` with -32601. Each cross-era run is the mutation for
 * the error-body fix: before it, an error reply was recorded as a
 * successful probe.
 */

const REQUESTS = 8;
const OPTS = { requests: REQUESTS, timeout: 5000 };

const legacyEchoTarget: TransportTarget = { type: "stdio", command: process.execPath, args: [LEGACY_ECHO_FIXTURE] };

function expectAllSucceeded(result: BenchmarkResult) {
  expect(result.failed, result.firstError ?? "").toBe(0);
  expect(result.succeeded).toBe(REQUESTS);
  expect(result.requests).toBe(REQUESTS);
  expect(result.firstError).toBeUndefined();
  expect(result.latencyMs.max).toBeGreaterThan(0);
}

function expectAllFailed(result: BenchmarkResult, reason: RegExp) {
  expect(result.succeeded).toBe(0);
  expect(result.failed).toBe(REQUESTS);
  expect(result.firstError).toMatch(reason);
  // Failed probes are still timed — the latency block must not be empty.
  expect(result.latencyMs.max).toBeGreaterThan(0);
}

describe("runBenchmark against the modern fixture over HTTP", () => {
  let http: HttpFixture;

  beforeAll(async () => {
    http = await startHttpFixture();
  });

  afterAll(async () => {
    await http.stop();
  });

  it("auto resolves to 2026-07-28 and measures server/discover with every probe succeeding", async () => {
    const result = await runBenchmark({ type: "http", url: http.url }, OPTS);
    expect(result.specVersion).toBe("2026-07-28");
    expect(result.method).toBe("server/discover");
    expectAllSucceeded(result);
    expect(result.target).toBe(http.url);
  });

  it("a pinned 2026-07-28 skips detection and still succeeds (headers + _meta on every probe)", async () => {
    const result = await runBenchmark({ type: "http", url: http.url }, { ...OPTS, specVersion: "2026-07-28" });
    expect(result.specVersion).toBe("2026-07-28");
    expect(result.method).toBe("server/discover");
    expectAllSucceeded(result);
  });

  it("--spec-version 2025-11-25 against a modern-only server counts every ping as FAILED", async () => {
    const result = await runBenchmark({ type: "http", url: http.url }, { ...OPTS, specVersion: "2025-11-25" });
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.method).toBe("ping");
    // A legacy-shaped ping carries no MCP-Protocol-Version header, so the
    // fixture rejects it with 400 + -32020 before dispatch. Whatever the
    // code, a JSON-RPC error body is a failed probe, not a fast success,
    // and the reason names the code and the HTTP status.
    expectAllFailed(result, /^JSON-RPC error -32\d{3} .*\(HTTP 4\d{2}\)$/);
  });

  it("concurrency > 1 keeps the accounting exact", async () => {
    const result = await runBenchmark({ type: "http", url: http.url }, { ...OPTS, concurrency: 4 });
    expect(result.method).toBe("server/discover");
    expectAllSucceeded(result);
  });

  it("reports progress once per completed probe", async () => {
    const seen: number[] = [];
    await runBenchmark({ type: "http", url: http.url }, { ...OPTS, onProgress: (done) => seen.push(done) });
    expect(seen).toHaveLength(REQUESTS);
    expect(seen[seen.length - 1]).toBe(REQUESTS);
  });
});

describe("runBenchmark against the modern fixture over stdio", () => {
  it("auto resolves to 2026-07-28 and measures server/discover (no HTTP headers involved)", async () => {
    const result = await runBenchmark(stdioFixture().target, OPTS);
    expect(result.specVersion).toBe("2026-07-28");
    expect(result.method).toBe("server/discover");
    expectAllSucceeded(result);
    expect(result.target.startsWith("stdio:")).toBe(true);
  });

  it("--spec-version 2025-11-25 against a modern-only server counts every ping as FAILED", async () => {
    const result = await runBenchmark(stdioFixture().target, { ...OPTS, specVersion: "2025-11-25" });
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.method).toBe("ping");
    // Over stdio there is no status code; the JSON-RPC error alone decides
    // (the fixture rejects the envelope-less ping with -32602 before dispatch).
    expectAllFailed(result, /^JSON-RPC error -32\d{3} /);
    expect(result.firstError).not.toContain("HTTP");
  });
});

describe("runBenchmark against the legacy echo fixture over stdio", () => {
  it("auto resolves to 2025-11-25 and measures ping after the initialize warm-up", async () => {
    const result = await runBenchmark(legacyEchoTarget, OPTS);
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.method).toBe("ping");
    expectAllSucceeded(result);
  });

  it("--spec-version 2026-07-28 against a legacy-only server counts every server/discover as FAILED", async () => {
    const result = await runBenchmark(legacyEchoTarget, { ...OPTS, specVersion: "2026-07-28" });
    expect(result.specVersion).toBe("2026-07-28");
    expect(result.method).toBe("server/discover");
    expectAllFailed(result, /^JSON-RPC error -32601 /);
  });
});

describe("runBenchmark warm-up (what is sent around the timed loop)", () => {
  // A pinned 2026-07-28 run used to send NO unmeasured request, so on
  // stdio the first timed server/discover absorbed the child's boot and
  // inflated mean/max by orders of magnitude relative to an auto run
  // (where the detection probe doubled as the warm-up). The counting stub
  // pins the contract transport-independently: exactly one server/discover
  // more than `requests`, whether the probe or the warm-up sent it.
  it("pinned 2026-07-28: one unmeasured server/discover precedes the N measured ones", async () => {
    const stub = await startCountingServer();
    try {
      const result = await runBenchmark(
        { type: "http", url: stub.url },
        { requests: 3, timeout: 5000, specVersion: "2026-07-28" },
      );
      expect(result.method).toBe("server/discover");
      expect(result.succeeded).toBe(3);
      expect(stub.counts).toEqual({ "server/discover": 4 });
    } finally {
      await stub.stop();
    }
  });

  it("auto: the detection probe IS the warm-up -- still N + 1, not N + 2", async () => {
    const stub = await startCountingServer();
    try {
      const result = await runBenchmark({ type: "http", url: stub.url }, { requests: 3, timeout: 5000 });
      expect(result.specVersion).toBe("2026-07-28");
      expect(result.succeeded).toBe(3);
      expect(stub.counts).toEqual({ "server/discover": 4 });
    } finally {
      await stub.stop();
    }
  });

  it("pinned 2025-11-25: the initialize handshake warms up and no server/discover is sent", async () => {
    const stub = await startCountingServer();
    try {
      const result = await runBenchmark(
        { type: "http", url: stub.url },
        { requests: 3, timeout: 5000, specVersion: "2025-11-25" },
      );
      expect(result.method).toBe("ping");
      expect(result.succeeded).toBe(3);
      expect(stub.counts).toEqual({ initialize: 1, "notifications/initialized": 1, ping: 3 });
    } finally {
      await stub.stop();
    }
  });

  it("pinned 2026-07-28 on stdio: the first measured sample no longer carries the child's boot", async () => {
    // Boot (Node + module load) is 150ms and up; a served server/discover
    // is a few ms. With the warm-up in place the slowest of 8 timed
    // samples stays well below boot time. (The counting cases above pin
    // the contract exactly; this one shows the effect it exists for.)
    const result = await runBenchmark(stdioFixture().target, { ...OPTS, specVersion: "2026-07-28" });
    expectAllSucceeded(result);
    expect(result.latencyMs.max, `max ${result.latencyMs.max}ms`).toBeLessThan(100);
  });
});

describe("runBenchmark auto on stdio: the era probe and the child it can kill", () => {
  let dir: string;
  let crashOnProbe: string;
  let exitAtStartup: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-compliance-bench-crash-"));
    crashOnProbe = join(dir, "crash-on-probe.mjs");
    writeFileSync(crashOnProbe, CRASH_ON_PROBE_SERVER);
    exitAtStartup = join(dir, "exit-at-startup.mjs");
    writeFileSync(
      exitAtStartup,
      'process.stderr.write("Error: API_KEY environment variable is required\\n"); process.exit(1);\n',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stdio = (path: string): TransportTarget => ({ type: "stdio", command: process.execPath, args: [path] });

  it("re-spawns a legacy child the probe killed, samples the fresh instance, and says so with the pin advice", async () => {
    // Before: every sample failed with "server crashed with exit code 1"
    // against the dead child, throughput was reported over 0ms, and
    // nothing said the benchmark's own probe was the cause.
    const result = await runBenchmark(stdio(crashOnProbe), { ...OPTS, startupTimeout: 10_000 });
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.method).toBe("ping");
    expectAllSucceeded(result);
    expect(result.warnings, JSON.stringify(result)).toHaveLength(1);
    const [warning] = result.warnings ?? [];
    expect(warning).toContain("Server exited (code 1) after the 2026-07-28 era probe (server/discover)");
    expect(warning).toContain("last stderr:");
    expect(warning).toContain("Error: unhandled method server/discover");
    expect(warning).toContain("The benchmark spawned a fresh instance.");
    expect(warning).toContain("pin --spec-version 2025-11-25 to skip the probe");
    // formatBenchmark prints it next to the counts.
    expect(formatBenchmark(result)).toContain(`  warning: ${warning}`);
  }, 20_000);

  it("a server that exits at startup regardless is not blamed on the probe", async () => {
    const result = await runBenchmark(stdio(exitAtStartup), { requests: 2, timeout: 2000, startupTimeout: 5000 });
    expect(result.failed).toBe(2);
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings ?? [];
    expect(warning).toContain("the server exits at startup regardless of the probe");
    expect(warning).toContain("Error: API_KEY environment variable is required");
    expect(warning).not.toContain("pin --spec-version");
  }, 20_000);

  it("the probe is bounded by startupTimeout, not the per-request timeout", async () => {
    // A silent legacy server ignores the probe; a 15s --timeout used to be
    // the probe budget, so a modern server with a slower cold start would
    // have been misclassified as 2025-11-25.
    const started = Date.now();
    const result = await runBenchmark(
      { type: "stdio", command: process.execPath, args: [LEGACY_SILENT_FIXTURE] },
      { requests: 2, timeout: 500, startupTimeout: 1500 },
    );
    const elapsed = Date.now() - started;
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.succeeded).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(8000);
  }, 20_000);

  it("~2s into an unanswered probe onStatus gets the same status line the test command prints", async () => {
    const status: string[] = [];
    await runBenchmark(
      { type: "stdio", command: process.execPath, args: [LEGACY_SILENT_FIXTURE] },
      { requests: 1, timeout: 5000, startupTimeout: 3500, onStatus: (m) => status.push(m) },
    );
    expect(status).toEqual([
      "Probing spec era (server/discover, up to 3.5s). A 2025-11-25 server that ignores unknown methods takes the whole startup timeout; --spec-version 2025-11-25 skips the probe.",
    ]);
  }, 20_000);

  it("a probe answered at once produces no status line and no warning", async () => {
    const status: string[] = [];
    const result = await runBenchmark(legacyEchoTarget, { ...OPTS, onStatus: (m) => status.push(m) });
    expect(status).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });
});

describe("runBenchmark against an unreachable server", () => {
  it("falls back to 2025-11-25 and records the transport error, never a success", async () => {
    const result = await runBenchmark({ type: "http", url: "http://127.0.0.1:1/mcp" }, { requests: 2, timeout: 2000 });
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.method).toBe("ping");
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.firstError).toBeTruthy();
  });
});

describe("describeProbeFailure", () => {
  it("accepts only a JSON-RPC result", () => {
    expect(describeProbeFailure({ body: { jsonrpc: "2.0", id: 1, result: {} }, requestId: 1 })).toBeNull();
    expect(
      describeProbeFailure({ body: { jsonrpc: "2.0", id: 1, result: {} }, requestId: 1, statusCode: 200 }),
    ).toBeNull();
  });

  it("names a JSON-RPC error with its code, message and non-200 status", () => {
    const res = {
      body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } },
      requestId: 1,
      statusCode: 404,
    };
    expect(describeProbeFailure(res)).toBe("JSON-RPC error -32601 nope (HTTP 404)");
    expect(describeProbeFailure({ ...res, statusCode: 200 })).toBe("JSON-RPC error -32601 nope");
    expect(describeProbeFailure({ ...res, statusCode: undefined })).toBe("JSON-RPC error -32601 nope");
  });

  it("treats a non-JSON-RPC body as a failure", () => {
    expect(describeProbeFailure({ body: { _raw: "<html>" }, requestId: 1, statusCode: 502 })).toBe(
      "HTTP 502 with no JSON-RPC result",
    );
    expect(describeProbeFailure({ body: null, requestId: 1 })).toBe("no JSON-RPC body");
  });
});

describe("formatBenchmark", () => {
  const base: BenchmarkResult = {
    target: "http://x/mcp",
    specVersion: "2026-07-28",
    method: "server/discover",
    requests: 3,
    succeeded: 3,
    failed: 0,
    durationMs: 30,
    throughputPerSec: 100,
    latencyMs: { min: 1, p50: 2, p90: 3, p95: 3, p99: 3, max: 3, mean: 2 },
  };

  it("prints the spec version and probe method", () => {
    const text = formatBenchmark(base);
    expect(text).toContain("spec 2026-07-28, probe method server/discover");
    expect(text).not.toContain("first failure");
  });

  it("prints the first failure when probes failed", () => {
    const text = formatBenchmark({ ...base, succeeded: 0, failed: 3, firstError: "JSON-RPC error -32601 nope" });
    expect(text).toContain("0 succeeded");
    expect(text).toContain("first failure: JSON-RPC error -32601 nope");
  });

  it("prints each warning, and none when there are none", () => {
    expect(formatBenchmark(base)).not.toContain("warning:");
    const text = formatBenchmark({ ...base, warnings: ["one", "two"] });
    expect(text).toContain("  warning: one\n  warning: two");
  });
});
