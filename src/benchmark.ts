import { performance } from "node:perf_hooks";
import {
  buildDiscoverProbe,
  type DetectionResult,
  detectSpecVersion,
  type ProbeExit,
  probeExitOf,
  probeExitWarning,
} from "./detect.js";
import { readPackageVersion } from "./pkg-version.js";
import { spawnStdioTarget } from "./runner.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, type SpecVersion, type SpecVersionOption } from "./spec.js";
import { createHttpTransport } from "./transport/http.js";
import type { JsonRpcId, Transport, TransportResponse } from "./transport/index.js";
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
   * Budget for the server's first reply -- the era probe under `auto`
   * and the unmeasured warm-up (the 2025-11-25 initialize handshake, or
   * a pinned 2026-07-28 run's first server/discover) -- in milliseconds.
   * Same default as the compliance runner, `max(timeout, 60000)`: a cold
   * `npx` stdio server can take tens of seconds to produce its first
   * byte, and a probe bounded by the per-request timeout would classify
   * it as 2025-11-25 (no reply) instead of waiting for its answer.
   */
  startupTimeout?: number;
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
  /**
   * Human-facing status lines while nothing is being measured yet --
   * today the stdio era probe, which a 2025-11-25 server that ignores
   * unknown methods lets sit for the whole startup timeout. The CLI
   * prints them dim to stderr in terminal mode; not part of the result.
   */
  onStatus?: (message: string) => void;
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
  /**
   * What happened around the timed loop that a reader must know to
   * interpret the numbers -- today, that the era probe killed a legacy
   * stdio child and the samples were taken against a fresh instance.
   * Absent when there is nothing to say.
   */
  warnings?: string[];
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
  const startupTimeout = opts.startupTimeout ?? Math.max(timeout, 60000);
  const requested: SpecVersionOption = opts.specVersion ?? "auto";
  const clientInfo = { name: "mcp-compliance-bench", version: TOOL_VERSION };

  // Reassigned once, and only on stdio: when the era probe kills the
  // child (a legacy server that exits on an unknown pre-initialize
  // request) the samples are taken against a fresh instance, exactly as
  // the compliance runner does; `finally` closes whichever is current.
  let transport: Transport =
    target.type === "http"
      ? createHttpTransport({ url: target.url, headers: target.headers })
      : spawnStdioTarget(target);

  let idCounter = 0;
  const nextId = (): JsonRpcId => ++idCounter;
  const warnings: string[] = [];

  try {
    // Resolve the era exactly the way the compliance runner does: one
    // modern `server/discover` probe, classified by its reply, within the
    // startup budget. On stdio this doubles as the boot wait; on HTTP it
    // is one extra round-trip.
    let specVersion: SpecVersion;
    let probed = false;
    let detection: DetectionResult | undefined;
    let probeExit: ProbeExit | null = null;
    if (requested === "auto") {
      detection = await detectSpecVersion(transport, {
        nextId,
        timeout: startupTimeout,
        clientInfo,
        onStatus: opts.onStatus,
      });
      specVersion = detection.version;
      probed = true;
      probeExit = await probeExitOf(transport);
      if (probeExit && target.type === "stdio") {
        await transport.close().catch(() => {});
        transport = spawnStdioTarget(target);
        // The fresh instance has not been warmed up by the probe.
        probed = false;
      }
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
    // Whether the warm-up got any reply; decides what a probe-exit
    // warning says about the fresh instance.
    let warmedUp = probed;
    if (specVersion === MODERN_SPEC_VERSION) {
      const probe = buildDiscoverProbe(clientInfo);
      method = "server/discover";
      params = probe.params;
      headers = transport.kind === "http" ? probe.headers : undefined;
      if (!probed) {
        try {
          await transport.request(method, params, nextId, { timeout: startupTimeout, headers });
          warmedUp = true;
        } catch {
          // The timed loop reports the failure with its reason; carry on.
        }
      }
    } else {
      method = "ping";
      params = undefined;
      headers = undefined;
      // Warm up: do an initialize so the server is responsive. For stdio
      // this also makes sure the child has booted (startup budget).
      try {
        await transport.request(
          "initialize",
          {
            protocolVersion: LEGACY_SPEC_VERSION,
            capabilities: {},
            clientInfo,
          },
          nextId,
          { timeout: startupTimeout },
        );
        warmedUp = true;
        await transport.notify("notifications/initialized", undefined, { timeout: startupTimeout });
      } catch {
        // Some servers don't require init for ping; carry on.
      }
    }
    if (probeExit && detection) {
      warnings.push(
        await probeExitWarning(probeExit, transport, { era: detection.era, answered: warmedUp, spawner: "benchmark" }),
      );
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
      ...(warnings.length > 0 ? { warnings } : {}),
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
  for (const w of result.warnings ?? []) {
    lines.push(`  warning: ${w}`);
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
