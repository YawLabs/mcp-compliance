import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BenchmarkResult, describeProbeFailure, formatBenchmark, runBenchmark } from "../benchmark.js";
import type { TransportTarget } from "../types.js";
import { type HttpFixture, LEGACY_ECHO_FIXTURE, startHttpFixture, stdioFixture } from "./helpers/modern-fixture.js";

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
});
