import { performance } from "node:perf_hooks";
import { createHttpTransport } from "./transport/http.js";
import type { Transport } from "./transport/index.js";
import { createStdioTransport } from "./transport/stdio.js";
import type { TransportTarget } from "./types.js";

export interface BenchmarkOptions {
  /** Total number of ping requests to send (default 100). */
  requests?: number;
  /** Concurrency level — sequential by default since most servers are single-threaded. */
  concurrency?: number;
  /** Per-request timeout in milliseconds (default 15000). */
  timeout?: number;
  /** Optional progress callback for verbose mode. */
  onProgress?: (done: number, total: number) => void;
}

export interface BenchmarkResult {
  target: string;
  requests: number;
  succeeded: number;
  failed: number;
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

export async function runBenchmark(target: TransportTarget, opts: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const requests = opts.requests ?? 100;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeout = opts.timeout ?? 15000;

  const transport: Transport =
    target.type === "http"
      ? createHttpTransport({ url: target.url, headers: target.headers })
      : createStdioTransport({
          command: target.command,
          args: target.args,
          env: target.env,
          cwd: target.cwd,
        });

  // Warm up: do an initialize so the server is responsive. For stdio
  // this also makes sure the child has booted.
  let nextId = 1;
  try {
    await transport.request(
      "initialize",
      { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-compliance-bench", version: "1" } },
      () => nextId++,
      { timeout },
    );
    await transport.notify("notifications/initialized", undefined, { timeout });
  } catch {
    // Some servers don't require init for ping; carry on.
  }

  const latencies: number[] = [];
  let succeeded = 0;
  let failed = 0;
  const overallStart = performance.now();

  let inFlight = 0;
  let issued = 0;
  let resolveAll!: () => void;
  const allDone = new Promise<void>((r) => {
    resolveAll = r;
  });

  function tick() {
    while (inFlight < concurrency && issued < requests) {
      issued++;
      inFlight++;
      const t0 = performance.now();
      transport
        .request("ping", undefined, () => nextId++, { timeout })
        .then(() => {
          latencies.push(performance.now() - t0);
          succeeded++;
        })
        .catch(() => {
          latencies.push(performance.now() - t0);
          failed++;
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
  await transport.close().catch(() => {});

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);

  const targetDescription =
    target.type === "http" ? target.url : `stdio:${target.command} ${target.args?.join(" ") ?? ""}`;

  return {
    target: targetDescription,
    requests,
    succeeded,
    failed,
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
}

export function formatBenchmark(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`Benchmark: ${result.target}`);
  lines.push(
    `  ${result.requests} requests in ${result.durationMs.toFixed(0)}ms (${result.throughputPerSec.toFixed(1)} req/s)`,
  );
  lines.push(`  ${result.succeeded} succeeded · ${result.failed} failed`);
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
