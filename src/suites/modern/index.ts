import { getTestDefinitionMap } from "../../definitions/index.js";
import type { DetectionResult } from "../../detect.js";
import { createHarness } from "../../harness.js";
import { createModernClient } from "../../modern/client.js";
import { createRecorder } from "../../recorder.js";
import { assembleReport } from "../../report.js";
import type { RunOptions } from "../../runner.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, specBaseFor } from "../../spec.js";
import type { JsonRpcId, Transport } from "../../transport/index.js";
import type { ComplianceReport } from "../../types.js";
import { createModernState, type ModernSuiteContext } from "./context.js";
import { runErrors } from "./errors.js";
import { runFeatures } from "./features.js";
import { runLifecycle, runLifecycleLate } from "./lifecycle.js";
import { runPostHoc } from "./posthoc.js";
import { runSchema } from "./schema.js";
import { runSecurity } from "./security.js";
import { runStdio } from "./stdio.js";
import { runTransport } from "./transport.js";

export interface ModernSuiteInput {
  transport: Transport;
  options: RunOptions;
  nextId: () => JsonRpcId;
  timeout: number;
  startupTimeout: number;
  backendUrl: string;
  userHeaders: Record<string, string>;
  displayUrl: string;
  toolVersion: string;
  detection: DetectionResult | undefined;
  /** Warnings accumulated before the suite started (preflight, detection). */
  warnings: string[];
  /** stdio only: spawn an independent second instance of the server. */
  spawnFresh?: () => Transport;
}

/**
 * The 2026-07-28 suite. Module order matters: lifecycle establishes the
 * discover result every capability gate reads; the feature modules fill
 * the cached lists that transport/security reuse and, on stdio, pin a
 * dual-era server modern so the late lifecycle block's claim-less `_meta`
 * probes measure validation rather than era selection; that late block
 * (which also holds the legacy `initialize` probe, sent to a fresh child
 * on stdio) runs BEFORE security, whose rate-limit burst can leave an
 * intermediary answering 429 for a while -- a bare 429 on a negative
 * probe is not the server rejecting the defect; post-hoc checks scan the
 * recorder last.
 */
export async function runModernSuite(input: ModernSuiteInput): Promise<ComplianceReport> {
  const { transport, options } = input;
  const definitions = getTestDefinitionMap(MODERN_SPEC_VERSION);
  const harness = createHarness({
    definitions,
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: transport.kind,
    only: options.only,
    skip: options.skip,
    retries: options.retries,
    concurrency: options.concurrency,
    signal: options.signal,
    onProgress: options.onProgress,
    onTestComplete: options.onTestComplete,
  });
  harness.warnings.push(...input.warnings);

  const recorder = createRecorder();
  const unsubscribe = transport.onMessage((m, meta) => recorder.recordReceived(m, meta));
  const client = createModernClient({
    transport,
    recorder,
    nextId: input.nextId,
    timeout: input.timeout,
    protocolVersion: MODERN_SPEC_VERSION,
    // Declare elicitation (not deprecated) so an MRTR-capable server may
    // ask for input; leave the deprecated sampling/roots undeclared so a
    // server that needs them must answer -32021, which is testable.
    clientCapabilities: { elicitation: {} },
    clientInfo: { name: "mcp-compliance", version: input.toolVersion },
    signal: options.signal,
  });

  const ctx: ModernSuiteContext = {
    harness,
    client,
    recorder,
    transport,
    kind: transport.kind,
    timeout: input.timeout,
    startupTimeout: input.startupTimeout,
    backendUrl: input.backendUrl,
    userHeaders: input.userHeaders,
    displayUrl: input.displayUrl,
    detection: input.detection,
    hasAuth: Object.keys(input.userHeaders).some((h) => h.toLowerCase() === "authorization"),
    spawnFresh: input.spawnFresh,
    signal: options.signal,
    state: createModernState(),
  };

  try {
    await runLifecycle(ctx);
    if (
      input.detection?.supportedVersions?.length &&
      !input.detection.supportedVersions.includes(MODERN_SPEC_VERSION)
    ) {
      harness.warnings.push(
        `Server advertises supportedVersions [${input.detection.supportedVersions.join(", ")}] without ${MODERN_SPEC_VERSION}; tests still run against ${MODERN_SPEC_VERSION}.`,
      );
    }
    await runFeatures(ctx);
    await runTransport(ctx);
    await runErrors(ctx);
    await runSchema(ctx);
    await runStdio(ctx);
    await runLifecycleLate(ctx);
    await runSecurity(ctx);
    await harness.drainPool();
    await runPostHoc(ctx);
    await harness.drainPool();
  } finally {
    unsubscribe();
  }

  // A served legacy initialize means "dual-era" only when the conformant
  // server/discover was served too (SDK 2.0 servers advertise only modern
  // versions in supportedVersions yet still serve the handshake, so key on
  // either); served while discover was rejected, the server is legacy-only
  // and this run graded the era it does not speak.
  const advertisesLegacy = ctx.state.supportedVersions.includes(LEGACY_SPEC_VERSION);
  if (ctx.state.discover && (advertisesLegacy || ctx.state.legacyInitializeServed)) {
    const how = advertisesLegacy
      ? `also advertises ${LEGACY_SPEC_VERSION}`
      : "also serves the legacy initialize handshake";
    harness.warnings.push(
      `Server is dual-era (${how}); this run graded ${MODERN_SPEC_VERSION}. Re-run with --spec-version ${LEGACY_SPEC_VERSION} to test the legacy handshake.`,
    );
  } else if (!ctx.state.discover && ctx.state.legacyInitializeServed) {
    harness.warnings.push(
      `Server is legacy-only (served the ${LEGACY_SPEC_VERSION} initialize handshake but rejected server/discover); this run graded ${MODERN_SPEC_VERSION}, so most of its tests are not evaluable. Re-run with --spec-version ${LEGACY_SPEC_VERSION} (or auto) to grade the era it speaks.`,
    );
  }
  harness.finalizeWarnings();

  return assembleReport({
    specVersion: MODERN_SPEC_VERSION,
    toolVersion: input.toolVersion,
    url: input.displayUrl,
    tests: harness.tests,
    warnings: harness.warnings,
    serverInfo: {
      protocolVersion: ctx.state.discover ? MODERN_SPEC_VERSION : null,
      name: ctx.state.serverInfo.name,
      version: ctx.state.serverInfo.version,
      capabilities: ctx.state.capabilities,
    },
    toolCount: ctx.state.tools?.length ?? 0,
    toolNames: ctx.state.toolNames,
    resourceCount: ctx.state.resources?.length ?? 0,
    resourceNames: ctx.state.resourceNames,
    promptCount: ctx.state.prompts?.length ?? 0,
    promptNames: ctx.state.promptNames,
  });
}
