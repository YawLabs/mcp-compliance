import { performance } from "node:perf_hooks";
import { buildDiscoverProbe, detectSpecVersion } from "./detect.js";
import { readPackageVersion } from "./pkg-version.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, type SpecVersion, type SpecVersionOption } from "./spec.js";
import { createHttpTransport } from "./transport/http.js";
import type { JsonRpcId, Transport, TransportResponse } from "./transport/index.js";
import { createStdioTransport } from "./transport/stdio.js";
import type { TransportTarget } from "./types.js";

const TOOL_VERSION = readPackageVersion(import.meta.url);

export interface BenchmarkOptions {
  /** Total number of probe requests to send (default 100). */
  requests?: number;
  /** Concurrency level — sequential by default since most servers are single-threaded. */
  concurrency?: number;
  /** Per-request timeout in milliseconds (default 15000). */
  timeout?: number;
  /**
   * MCP spec revision to benchmark against (default `auto`). The era
   * decides the probe: 2025-11-25 warms up with the initialize handshake
   * and measures `ping`; 2026-07-28 has no handshake, so it warms up with
   * one unmeasured `server/discover` and then measures `server/discover`
   * (the one request every modern server MUST serve). `auto` sends one
   * modern `server/discover` first and classifies the reply the way the
   * compliance runner does; that probe doubles as the modern warm-up.
   */
  specVersion?: SpecVersionOption;
  /** Optional progress callback for verbose mode. */
  onProgress?: (done: number, total: number) => void;
}

export interface BenchmarkResult {
  target: string;
  /** The RESOLVED spec revision the probes were shaped for (never `auto`). */
  specVersion: SpecVersion;
  /** The JSON-RPC method that was measured: `ping` (2025-11-25) or `server/discover` (2026-07-28). */
  method: string;
  requests: number;
  succeeded: number;
  failed: number;
  /**
   * Why the first failed probe failed (JSON-RPC error code + message, or
   * the transport error). Absent when every probe succeeded.
   */
  firstError?: string;
  durationMs: number;
  throughputPerSec: number;
  latencyMs: {
    min: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * A probe only counts as successful when the server answered it with a
 * JSON-RPC result. The transport resolves on ANY parseable response, so a
 * `-32601 Method not found` reply (a modern-only server asked to `ping`,
 * or a legacy server asked for `server/discover`) used to be recorded as
 * a fast, successful round-trip — error-path latency with `failed: 0`.
 * A non-JSON-RPC body (HTML error page, empty 202) is a failure too: the
 * request was not served.
 */
export function describeProbeFailure(res: TransportResponse): string | null {
  const body = res.body as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null | undefined;
  if (!body || typeof body !== "object") {
    return res.statusCode !== undefined ? `HTTP ${res.statusCode} with no JSON-RPC body` : "no JSON-RPC body";
  }
  if (body.error && typeof body.error === "object") {
    const code = typeof body.error.code === "number" ? `${body.error.code} ` : "";
    const message = typeof body.error.message === "string" ? body.error.message : "unknown error";
    const status = res.statusCode !== undefined && res.statusCode !== 200 ? ` (HTTP ${res.statusCode})` : "";
    return `JSON-RPC error ${code}${message}${status}`;
  }
  if (body.result === undefined) {
    return res.statusCode !== undefined ? `HTTP ${res.statusCode} with no JSON-RPC result` : "no JSON-RPC result";
  }
  return null;
}

export async function runBenchmark(target: TransportTarget, opts: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const requests = opts.requests ?? 100;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeout = opts.timeout ?? 15000;
  const requested: SpecVersionOption = opts.specVersion ?? "auto";
  const clientInfo = { name: "mcp-compliance-bench", version: TOOL_VERSION };

  const transport: Transport =
    target.type === "http"
      ? createHttpTransport({ url: target.url, headers: target.headers })
      : createStdioTransport({
          command: target.command,
          args: target.args,
          env: target.env,
          cwd: target.cwd,
        });

  let idCounter = 0;
  const nextId = (): JsonRpcId => ++idCounter;

  try {
    // Resolve the era exactly the way the compliance runner does: one
    // modern `server/discover` probe, classified by its reply. On stdio
    // this doubles as the boot wait; on HTTP it is one extra round-trip.
    let specVersion: SpecVersion;
    let probed = false;
    if (requested === "auto") {
      const detection = await detectSpecVersion(transport, { nextId, timeout, clientInfo });
      specVersion = detection.version;
      probed = true;
    } else {
      specVersion = requested;
    }

    // The measured request per era. Legacy: `ping` after the initialize
    // handshake. Modern: `server/discover` with the conformant envelope
    // (_meta on every request; MCP-Protocol-Version + Mcp-Method on HTTP).
    // 2026-07-28 has no handshake, so its warm-up is one UNMEASURED
    // `server/discover` -- under `auto` the detection probe already was
    // one; a pinned run sends it here so the first timed sample does not
    // absorb a stdio child's boot (or an HTTP cold start) and inflate
    // mean/max by orders of magnitude relative to an auto run.
    let method: string;
    let params: unknown;
    let headers: Record<string, string> | undefined;
    if (specVersion === MODERN_SPEC_VERSION) {
      const probe = buildDiscoverProbe(clientInfo);
      method = "server/discover";
      params = probe.params;
      headers = transport.kind === "http" ? probe.headers : undefined;
      if (!probed) {
        try {
          await transport.request(method, params, nextId, { timeout, headers });
        } catch {
          // The timed loop reports the failure with its reason; carry on.
        }
      }
    } else {
      method = "ping";
      params = undefined;
      headers = undefined;
      // Warm up: do an initialize so the server is responsive. For stdio
      // this also makes sure the child has booted.
      try {
        await transport.request(
          "initialize",
          {
            protocolVersion: LEGACY_SPEC_VERSION,
            capabilities: {},
            clientInfo,
          },
          nextId,
          { timeout },
        );
        await transport.notify("notifications/initialized", undefined, { timeout });
      } catch {
        // Some servers don't require init for ping; carry on.
      }
    }

    const latencies: number[] = [];
    let succeeded = 0;
    let failed = 0;
    let firstError: string | undefined;
    const overallStart = performance.now();

    let inFlight = 0;
    let issued = 0;
    let resolveAll!: () => void;
    const allDone = new Promise<void>((r) => {
      resolveAll = r;
    });

    function recordFailure(reason: string) {
      failed++;
      if (firstError === undefined) firstError = reason;
    }

    function tick() {
      while (inFlight < concurrency && issued < requests) {
        issued++;
        inFlight++;
        const t0 = performance.now();
        transport
          .request(method, params, nextId, { timeout, headers })
          .then((res) => {
            latencies.push(performance.now() - t0);
            const failure = describeProbeFailure(res);
            if (failure === null) succeeded++;
            else recordFailure(failure);
          })
          .catch((err: unknown) => {
            latencies.push(performance.now() - t0);
            recordFailure(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            inFlight--;
            opts.onProgress?.(succeeded + failed, requests);
            if (succeeded + failed >= requests) resolveAll();
            else tick();
          });
      }
    }
    tick();
    await allDone;

    const durationMs = performance.now() - overallStart;

    const sorted = [...latencies].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);

    const targetDescription =
      target.type === "http" ? target.url : `stdio:${target.command} ${target.args?.join(" ") ?? ""}`;

    return {
      target: targetDescription,
      specVersion,
      method,
      requests,
      succeeded,
      failed,
      ...(firstError !== undefined ? { firstError } : {}),
      durationMs,
      throughputPerSec: durationMs > 0 ? (requests / durationMs) * 1000 : 0,
      latencyMs: {
        min: sorted[0] ?? 0,
        p50: pct(sorted, 50),
        p90: pct(sorted, 90),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
        mean,
      },
    };
  } finally {
    await transport.close().catch(() => {});
  }
}

export function formatBenchmark(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`Benchmark: ${result.target}`);
  lines.push(`  spec ${result.specVersion}, probe method ${result.method}`);
  lines.push(
    `  ${result.requests} requests in ${result.durationMs.toFixed(0)}ms (${result.throughputPerSec.toFixed(1)} req/s)`,
  );
  lines.push(`  ${result.succeeded} succeeded · ${result.failed} failed`);
  if (result.failed > 0 && result.firstError) {
    lines.push(`  first failure: ${result.firstError}`);
  }
  lines.push("");
  lines.push("Latency (ms):");
  lines.push(`  min   ${result.latencyMs.min.toFixed(2)}`);
  lines.push(`  mean  ${result.latencyMs.mean.toFixed(2)}`);
  lines.push(`  p50   ${result.latencyMs.p50.toFixed(2)}`);
  lines.push(`  p90   ${result.latencyMs.p90.toFixed(2)}`);
  lines.push(`  p95   ${result.latencyMs.p95.toFixed(2)}`);
  lines.push(`  p99   ${result.latencyMs.p99.toFixed(2)}`);
  lines.push(`  max   ${result.latencyMs.max.toFixed(2)}`);
  return lines.join("\n");
}
