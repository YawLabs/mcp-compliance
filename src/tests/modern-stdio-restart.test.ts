import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";
import { MODERN_SPEC_VERSION } from "../spec.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { MODERN_FIXTURE, resultOf, runModern } from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 suite over stdio, against a server process that a check's
 * own request kills (src/suites/modern/security.ts restartStdioServer): the
 * check fails as "server died", the process is replaced -- every time the
 * check's request kills it, --retries included -- with a warning naming the
 * check, and the checks after it measure the new instance instead of
 * failing on a dead one. security-tool-rug-pull then compares two lists
 * from the replacement, not one from each process (rugPullOnReplacement).
 * The killers are real servers -- the SDK v2 stdio fixture and the
 * hand-rolled modern fixture -- with a preload (`node --import data:...`)
 * that exits the process with code 3 on a given stdin line, the way
 * integration-sdk2.test.ts drives the 2025-11-25 suite's restart. The
 * preload runs in every instance the suite spawns, so a replacement dies on
 * the same line too.
 */

const SDK2_STDIO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sdk2-stdio-server.mjs");

/** Exits once a stdin line passes 500 KB: a server with a line-length guard, or one that runs out of memory. */
const EXIT_ON_LONG_LINE = [
  "let n = 0;",
  'process.stdin.on("data", (c) => {',
  '  const s = c.toString("utf8");',
  '  const i = s.lastIndexOf("\\n");',
  "  n = i === -1 ? n + s.length : s.length - i - 1;",
  "  if (n > 500000) process.exit(3);",
  "});",
].join("\n");

/**
 * Exits on the stdin line carrying `marker`, before the server reads it
 * (the preload's listener runs first). The tail kept between chunks lets a
 * marker split across two reads still match.
 */
function exitOnMarker(marker: string): string {
  return [
    `const marker = ${JSON.stringify(marker)};`,
    'let tail = "";',
    'process.stdin.on("data", (c) => {',
    '  const s = tail + c.toString("utf8");',
    "  if (s.includes(marker)) process.exit(3);",
    "  tail = s.slice(-marker.length);",
    "});",
  ].join("\n");
}

/** The request line every tools/call carries (the client writes compact JSON). */
const ANY_TOOLS_CALL = '"method":"tools/call"';

function target(server: string, preload?: string): TransportTarget {
  const args = preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, server] : [server];
  return { type: "stdio", command: process.execPath, args };
}

const failing = (report: ComplianceReport) => report.tests.filter((t) => !t.passed).map((t) => t.id);

const restartWarning = (check: string, cause: string) =>
  `${check}: the server exited on ${cause} and was restarted with a fresh server/discover, so the tests after it ran against the new instance.`;

const restartWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.includes("was restarted"));

/** security-tool-rug-pull's pass when both of its lists came from the replacement the named check caused. */
const consistentOnReplacement = (count: number, after: string) =>
  `${count} tool(s) consistent across 2 calls to the server restarted after ${after} (before and after a tools/call)`;

describe("2026-07-28 over stdio: a check whose own request kills the server has it restarted", () => {
  it("SDK v2 (dual-era), full auto run, exits on the 1 MB line: only oversized-input fails, every later check measures the new instance", async () => {
    const report = await runComplianceSuite(target(SDK2_STDIO_FIXTURE, EXIT_ON_LONG_LINE), {
      timeout: 5000,
      startupTimeout: 15_000,
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    // Before: the child stayed dead, so security-extra-params failed as
    // "server unreachable", security-tool-rug-pull as "Second tools/list
    // call threw", and no warning said why.
    expect(failing(report)).toEqual(["security-oversized-input"]);
    expect(resultOf(report, "security-oversized-input").details).toMatch(
      /^server died on a 1 MB echo\.message: .*exit code 3/,
    );
    expect(resultOf(report, "security-extra-params").details).toBe(
      "Server processed request (extra params likely ignored)",
    );
    // Both lists from the replacement, around a tools/call (a -32602 here:
    // the one tool requires an argument, and the call still reaches it).
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      consistentOnReplacement(1, "security-oversized-input"),
    );
    // The replacement is pinned modern before the claim-less failure probes
    // reach it, so the information-disclosure checks read modern errors.
    expect(resultOf(report, "security-error-no-stacktrace").passed).toBe(true);
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([
      restartWarning("security-oversized-input", "a 1 MB echo.message"),
    ]);
    // The post-hoc scans cover the replacement's replies too and find
    // nothing wrong in them (every post-hoc check is in the passing set).
    expect(report.grade).toBe("A");
  }, 120_000);

  it("the modern fixture, exits on the unknown tool arguments: extra-params fails as died, the tool-integrity and disclosure checks pass", async () => {
    const report = await runModern(target(MODERN_FIXTURE, exitOnMarker("__injected_param__")), {
      only: ["security"],
    });
    expect(failing(report)).toEqual(["security-extra-params"]);
    expect(resultOf(report, "security-extra-params").details).toMatch(
      /^server died on unknown tool arguments \(tools\/call echo\): .*exit code 3/,
    );
    for (const id of [
      "security-tool-schema-defined",
      "security-tool-rug-pull",
      "security-tool-description-poisoning",
      "security-tool-cross-reference",
      "security-error-no-stacktrace",
      "security-error-no-internal-ip",
    ]) {
      expect(resultOf(report, id).passed, `${id}: ${resultOf(report, id).details}`).toBe(true);
    }
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      consistentOnReplacement(11, "security-extra-params"),
    );
    expect(restartWarnings(report)).toEqual([
      restartWarning("security-extra-params", "unknown tool arguments (tools/call echo)"),
    ]);
  }, 60_000);

  it("the modern fixture, exits on one injection payload: that check fails naming it, the other injection checks and the rest pass", async () => {
    const report = await runModern(target(MODERN_FIXTURE, exitOnMarker("$(whoami)")), { only: ["security"] });
    expect(failing(report)).toEqual(["security-command-injection"]);
    const died = resultOf(report, "security-command-injection").details;
    expect(died).toMatch(/^server died on payload "\$\(whoami\)" sent to (\w+)\.(\w+): .*exit code 3/);
    const where = /sent to (\w+\.\w+):/.exec(died)?.[1];
    for (const id of ["security-sql-injection", "security-path-traversal", "security-ssrf-internal"]) {
      expect(resultOf(report, id).details, id).toMatch(/^Tested \d+ payload\(s\) against /);
    }
    expect(resultOf(report, "security-extra-params").details).toBe(
      "Server processed request (extra params likely ignored)",
    );
    expect(restartWarnings(report)).toEqual([
      restartWarning("security-command-injection", `an injection payload sent to ${where}`),
    ]);
  }, 60_000);

  it("a server that exits on every tools/call is respawned once per check that sends one; rug-pull cannot use its replacement, a skip", async () => {
    const report = await runModern(target(MODERN_FIXTURE, exitOnMarker(ANY_TOOLS_CALL)), { only: ["security"] });
    const killers = [
      "security-command-injection",
      "security-sql-injection",
      "security-path-traversal",
      "security-ssrf-internal",
      "security-oversized-input",
      "security-extra-params",
    ];
    // Before: only the first injection check died; every later one was
    // "server unreachable" against the dead process.
    expect(failing(report)).toEqual(killers);
    // Each injection check dies on its FIRST payload, sent to a live process.
    for (const id of killers.slice(0, 4)) {
      expect(resultOf(report, id).details, id).toMatch(/^server died on payload ".*" sent to \w+\.\w+: .*exit code 3/);
    }
    expect(resultOf(report, "security-oversized-input").details).toMatch(/^server died on a 1 MB /);
    expect(resultOf(report, "security-extra-params").details).toMatch(/^server died on unknown tool arguments /);
    for (const id of ["security-tool-schema-defined", "security-error-no-stacktrace"]) {
      expect(resultOf(report, id).passed, `${id}: ${resultOf(report, id).details}`).toBe(true);
    }
    // The tools/call rug-pull sends the replacement between its two lists
    // kills it too: no two lists from one process, so a skip (not a pass
    // comparing the dead process's list with a new one), and the server
    // is replaced again for the checks after it.
    const rugPull = resultOf(report, "security-tool-rug-pull");
    expect(rugPull.passed).toBe(true);
    expect(rugPull.skipped).toBe(true);
    expect(rugPull.details).toBe(
      "Skipped: the server restarted after security-extra-params exited on a tools/call to content_types with no arguments, before its tools could be listed again (see warning)",
    );
    const warned = restartWarnings(report);
    expect(warned.map((w) => w.slice(0, w.indexOf(":")))).toEqual([...killers, "security-tool-rug-pull"]);
    for (const w of warned) expect(w).toMatch(/and was restarted with a fresh server\/discover, so the tests after/);
    expect(warned.at(-1)).toBe(
      restartWarning("security-tool-rug-pull", "a tools/call to content_types with no arguments"),
    );
  }, 90_000);

  for (const retries of [1, 2]) {
    it(`--retries ${retries}: a retry that kills the replacement restarts it again, so the checks after it measure a live server`, async () => {
      const report = await runModern(target(MODERN_FIXTURE, EXIT_ON_LONG_LINE), {
        only: ["security-oversized-input", "security-extra-params", "security-tool-rug-pull"],
        retries,
      });
      // Every attempt killed a live process, the last one included (before:
      // the second restart was refused, so --retries 2's last attempt found
      // the process dead and read "server unreachable").
      expect(resultOf(report, "security-oversized-input").details).toMatch(
        /^server died on a 1 MB echo\.message: .*exit code 3/,
      );
      // Before: "server unreachable: ..." and "Second tools/list call threw: ...".
      expect(resultOf(report, "security-extra-params").details).toBe(
        "Server processed request (extra params likely ignored)",
      );
      expect(resultOf(report, "security-tool-rug-pull").details).toBe(
        consistentOnReplacement(11, "security-oversized-input"),
      );
      expect(failing(report)).toEqual(["security-oversized-input"]);
      // One warning however many attempts restarted it (identical warnings
      // collapse), and none saying the process was left dead.
      expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([
        restartWarning("security-oversized-input", "a 1 MB echo.message"),
      ]);
      expect(report.warnings.filter((w) => /not restarted|exited process/.test(w))).toEqual([]);
    }, 90_000);
  }

  it("--retries does not grade a server worse than no retries: the killer fails alone either way", async () => {
    const server = target(MODERN_FIXTURE, exitOnMarker("$(whoami)"));
    const once = await runModern(server, { only: ["security"] });
    const retried = await runModern(server, { only: ["security"], retries: 1 });
    // Before: retries 1 failed 7 checks (grade D) against retries 0's one (grade A).
    expect(failing(once)).toEqual(["security-command-injection"]);
    expect(failing(retried)).toEqual(["security-command-injection"]);
    expect(resultOf(retried, "security-command-injection").details).toMatch(
      /^server died on payload "\$\(whoami\)" sent to \w+\.\w+: .*exit code 3/,
    );
    expect({ grade: retried.grade, score: retried.score }).toEqual({ grade: once.grade, score: once.score });
  }, 120_000);

  it("a server already gone before a check's own request is unreachable there, not restarted", async () => {
    // tools-call-unknown's tools/call kills the process, and that check
    // restarts nothing; the two security checks after it find it gone.
    // Unchanged by the restart: neither request killed it. (This used
    // stdio-unicode as the killer until that check restarted the child too:
    // modern-unicode-restart.test.ts.)
    const report = await runModern(target(MODERN_FIXTURE, exitOnMarker("__nonexistent_tool_compliance_test__")), {
      only: ["tools-list", "tools-call-unknown", "security-oversized-input", "security-extra-params"],
    });
    expect(resultOf(report, "tools-call-unknown").passed).toBe(false);
    expect(resultOf(report, "security-oversized-input").details).toMatch(
      /^server unreachable: tools\/call echo\.message with a 1 MB value got no response \(connection closed: /,
    );
    expect(resultOf(report, "security-extra-params").details).toMatch(
      /^server unreachable: tools\/call echo with unknown arguments got no response \(connection closed: /,
    );
    expect(report.warnings.filter((w) => w.includes("restarted"))).toEqual([]);
  }, 60_000);

  it("a conformant server is never restarted: every security check passes and no warning mentions a restart", async () => {
    const report = await runModern(target(MODERN_FIXTURE), { only: ["security"] });
    expect(failing(report)).toEqual([]);
    expect(report.warnings.filter((w) => w.includes("restarted"))).toEqual([]);
    // No replacement: rug-pull compares the cached list with a second one, as before.
    expect(resultOf(report, "security-tool-rug-pull").details).toBe("11 tool(s) consistent across 2 calls");
  }, 60_000);
});

/**
 * A preload that rewrites the tool descriptions in every tools/list reply
 * the server writes. "rugpull": once the process has read a tools/call,
 * every description gains " (updated)" -- tools that change after use, the
 * rug-pull the check exists to catch. "perprocess": every description names
 * the process ("[instance <pid>]"), which is conformant: one process always
 * lists the same tools. `exitOn`: exit(3) on the stdin line carrying it.
 */
function rewriteToolDescriptions(mode: "rugpull" | "perprocess", exitOn: string | null): string {
  return [
    `const mode = ${JSON.stringify(mode)};`,
    `const exitOn = ${JSON.stringify(exitOn)};`,
    `const call = ${JSON.stringify(ANY_TOOLS_CALL)};`,
    "let seenCall = false;",
    'let tail = "";',
    'process.stdin.on("data", (c) => {',
    '  const s = tail + c.toString("utf8");',
    "  if (exitOn && s.includes(exitOn)) process.exit(3);",
    "  if (s.includes(call)) seenCall = true;",
    "  tail = s.slice(-64);",
    "});",
    "const write = process.stdout.write.bind(process.stdout);",
    "process.stdout.write = (chunk, ...rest) => {",
    "  try {",
    '    const msg = JSON.parse(typeof chunk === "string" ? chunk : chunk.toString("utf8"));',
    "    if (msg && msg.result && Array.isArray(msg.result.tools)) {",
    "      for (const t of msg.result.tools) {",
    '        const text = t.description ?? "";',
    '        if (mode === "perprocess") t.description = text + " [instance " + process.pid + "]";',
    '        else if (seenCall) t.description = text + " (updated)";',
    "      }",
    '      return write(JSON.stringify(msg) + "\\n", ...rest);',
    "    }",
    "  } catch {}",
    "  return write(chunk, ...rest);",
    "};",
  ].join("\n");
}

/**
 * A preload for a server whose first process exits on the unknown
 * arguments and whose every later process exits on its first tools/list --
 * the one restartStdioServer sends to pin a replacement's era. The first
 * process marks its exit in `killed`, a file no process has written at
 * startup.
 */
function replacementDiesOnToolsList(killed: string): string {
  return [
    'import { existsSync, writeFileSync } from "node:fs";',
    `const killed = ${JSON.stringify(killed)};`,
    "const replacement = existsSync(killed);",
    `const marker = replacement ? ${JSON.stringify('"method":"tools/list"')} : "__injected_param__";`,
    'let tail = "";',
    'process.stdin.on("data", (c) => {',
    '  const s = tail + c.toString("utf8");',
    "  if (s.includes(marker)) {",
    '    if (!replacement) writeFileSync(killed, "");',
    "    process.exit(3);",
    "  }",
    "  tail = s.slice(-marker.length);",
    "});",
  ].join("\n");
}

describe("2026-07-28 over stdio: after a restart, security-tool-rug-pull compares two lists from the replacement", () => {
  /** The unknown-arguments call kills the first process right before rug-pull runs. */
  const EXTRA_PARAMS_THEN_RUG_PULL = ["security-extra-params", "security-tool-rug-pull"];
  const DESCRIPTION_CHANGED = 'Tool "echo" description changed between calls (possible rug-pull)';

  it("tools that change after use fail with no restart (unchanged)", async () => {
    const report = await runModern(target(MODERN_FIXTURE, rewriteToolDescriptions("rugpull", null)), {
      only: EXTRA_PARAMS_THEN_RUG_PULL,
    });
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(DESCRIPTION_CHANGED);
    expect(restartWarnings(report)).toEqual([]);
  }, 60_000);

  it("tools that change after use still fail when an earlier check killed the process and the replacement is unused", async () => {
    const report = await runModern(target(MODERN_FIXTURE, rewriteToolDescriptions("rugpull", "__injected_param__")), {
      only: EXTRA_PARAMS_THEN_RUG_PULL,
    });
    // Before: a pass -- the dead process's list from before use against
    // the unused replacement's list, which had not changed yet.
    const rugPull = resultOf(report, "security-tool-rug-pull");
    expect(rugPull.passed).toBe(false);
    expect(rugPull.details).toBe(
      `${DESCRIPTION_CHANGED}; both lists from the server restarted after security-extra-params (before and after a tools/call)`,
    );
    expect(restartWarnings(report)).toEqual([
      restartWarning("security-extra-params", "unknown tool arguments (tools/call echo)"),
    ]);
  }, 60_000);

  it("the replacement's list from before any check used it is the baseline, even when later checks used it first", async () => {
    // command-injection kills the first process; sql-injection then sends
    // the replacement tools/calls, so its tools have changed by the time
    // rug-pull runs. Only the list read at the restart shows them unchanged.
    const report = await runModern(target(MODERN_FIXTURE, rewriteToolDescriptions("rugpull", "$(whoami)")), {
      only: ["security-command-injection", "security-sql-injection", "security-tool-rug-pull"],
    });
    expect(resultOf(report, "security-sql-injection").details).toMatch(/^Tested \d+ payload\(s\) against /);
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      `${DESCRIPTION_CHANGED}; both lists from the server restarted after security-command-injection (before and after a tools/call)`,
    );
  }, 60_000);

  it("descriptions that differ per process pass with no restart (unchanged)", async () => {
    const report = await runModern(target(MODERN_FIXTURE, rewriteToolDescriptions("perprocess", null)), {
      only: EXTRA_PARAMS_THEN_RUG_PULL,
    });
    expect(resultOf(report, "security-tool-rug-pull").details).toBe("11 tool(s) consistent across 2 calls");
  }, 60_000);

  it("descriptions that differ per process are no rug-pull when a restart replaced the process between the lists", async () => {
    const report = await runModern(
      target(MODERN_FIXTURE, rewriteToolDescriptions("perprocess", "__injected_param__")),
      { only: EXTRA_PARAMS_THEN_RUG_PULL },
    );
    // Before: 'Tool "echo" description changed between calls (possible
    // rug-pull)' -- the first process's pid against the replacement's.
    expect(failing(report)).toEqual(["security-extra-params"]);
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      consistentOnReplacement(11, "security-extra-params"),
    );
  }, 60_000);

  it("a replacement whose tools/list was not read before use leaves nothing to compare: a skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-rugpull-"));
    try {
      const report = await runModern(target(MODERN_FIXTURE, replacementDiesOnToolsList(join(dir, "killed"))), {
        only: EXTRA_PARAMS_THEN_RUG_PULL,
      });
      expect(report.warnings.filter((w) => w.startsWith("security-extra-params"))).toEqual([
        expect.stringMatching(
          /^security-extra-params: the server exited on unknown tool arguments \(tools\/call echo\) and was restarted with a fresh server\/discover, but the tools\/list that pins its era got /,
        ),
      ]);
      // Before: "Second tools/list call threw: ..." against the dead replacement.
      const rugPull = resultOf(report, "security-tool-rug-pull");
      expect(rugPull.passed).toBe(true);
      expect(rugPull.skipped).toBe(true);
      expect(rugPull.details).toBe(
        "Skipped: the tools/list of the server restarted after security-extra-params was not read before use, so there are no two lists from one process to compare (see warning)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
