/**
 * Regenerates the 2026-07-28 half of mcp-compliance-rules.json and section
 * 3b of COMPLIANCE_RUBRIC.md from MODERN_TEST_DEFINITIONS plus the
 * hand-authored pass/fail criteria below. The catalog owns ids, names,
 * categories, required flags, transports, spec references and prose; this
 * file owns the pass/fail criteria and capability gates, which exist
 * nowhere in code. src/tests/catalog-parity.test.ts fails when the two
 * drift, so run this after every catalog change:
 *
 *   npx tsx scripts/gen-catalog-docs.ts
 *
 * The 2025-11-25 rules are read from the existing file and kept as they are.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODERN_TEST_DEFINITIONS } from "../src/definitions/2026-07-28.js";
import type { TestDefinition } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Gate = "tools" | "resources" | "prompts" | "completions" | null;
interface Criteria {
  pass: string;
  fail: string;
  gate: Gate;
}

/** Appended to every negative-probe pass criterion: the attribution guard from 4c75d38. */
const NOT_EVALUABLE =
  "credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable)";
/** Appended to every post-hoc scan's fail criterion: an empty recording fails instead of passing vacuously. */
const EMPTY_RECORDING =
  "Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.";
/** The six list-based definition checks fetch on demand. */
const LIST_ON_DEMAND = (what: string) =>
  `The list is fetched on demand under --only. When ${what}/list failed the rule skips (as passed) pointing at ${what}-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema). A declared but empty list leaves nothing to validate: the pass is flagged as a skip.`;

/**
 * List consumers outside the schema category (the feature checks that call
 * or read a listed item, and the tool-dependent security checks): a list
 * call that failed skips them pointing at the -list rule when it is in the
 * run, and fails them with the recorded reason when it was filtered out.
 */
const LIST_FAILED_SKIP = (what: string) =>
  `When ${what}/list failed the rule skips (as passed) pointing at ${what}-list if that rule is in the run.`;
const LIST_FAILED_FAIL = (what: string) =>
  `Also fails when ${what}/list failed while ${what}-list was filtered out of the run (the recorded reason is named).`;

/**
 * The gate reading (src/suites/modern/gate.ts, gateVerdict) of the checks
 * that credit any rejection: whose answer a rejection is. A 403 is an auth
 * gate's the way readAuthRefusal (src/detect.ts) reads one: without --auth
 * any Bearer challenge, with --auth only one carrying an error parameter;
 * every other 403 is read against the conformant twin. TWIN_CREDITS is that
 * twin rule (twinReachedServer), `twin` naming the request sent next to the
 * probe (a server/discover; error-invalid-cursor's list method without the
 * cursor); GATE_PASS is the pass-side half (the 429 resend, the own code on
 * a 5xx, the twin); GATE_FAIL lists what fails as not evaluable; GATE_5XX is
 * what a 5xx without the check's own JSON-RPC code `own` fails as (the server
 * failing on the probe, not "not evaluable"; with no own code, every 5xx).
 */
const DISCOVER_TWIN = "a conformant server/discover sent next to it";
const TWIN_CREDITS = (twin = DISCOVER_TWIN) =>
  `any 403 that is not an auth refusal (one without a Bearer challenge, or with --auth one whose challenge carries no error parameter) is read as the server's only when ${twin} (a 429 on it resent once) was served or drew a status the server chose (a 2xx, or a 4xx other than 401, 403 or 429)`;
const GATE_PASS = (own: string, twin?: string) =>
  `A 429 is resent once after Retry-After (capped at 2 s)${own ? `, a ${own} on a 5xx passes with a warning that a 4xx is expected` : ""}, and ${TWIN_CREDITS(twin)}.`;
const GATE_FAIL = (twin = "the conformant server/discover") =>
  `a 401, a 403 that reads as an auth refusal (without --auth any Bearer challenge, with --auth one carrying an error parameter; a gateway's -32001 body included), a 429 still a 429 after its one resend, or any other 403 ${twin} could not get past either (it drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer)`;
const GATE_5XX = (own: string, on: string) =>
  `${own ? `a 5xx without ${own}` : "any 5xx"} fails as the server failing on ${on} rather than rejecting it (a broken server, or a gateway with no backend)`;
/** GATE_5XX as a sentence of its own. */
const GATE_5XX_SENTENCE = (own: string, on: string) => {
  const clause = GATE_5XX(own, on);
  return `${clause[0].toUpperCase()}${clause.slice(1)}, not as not evaluable.`;
};

const C: Record<string, Criteria> = {
  // ── transport ──
  "transport-post": {
    pass: "HTTP 2xx for a POST carrying a conformant server/discover request (standard headers plus _meta).",
    fail: "Any non-2xx status; a 401/403 is annotated as authentication required (no --auth, and a 401 or a 403 carrying a WWW-Authenticate: Bearer challenge), as the configured credential rejected (--auth given, and a 401 or a 403 whose Bearer challenge carries an error parameter), or as forbidden (any other 403, which may be Host/Origin validation, a gateway, missing credentials or the token's permissions).",
    gate: null,
  },
  "transport-content-type": {
    pass: "The Content-Type of the server/discover response contains application/json or text/event-stream.",
    fail: "Any other Content-Type, or none.",
    gate: null,
  },
  "transport-content-type-reject": {
    pass: `HTTP 4xx (415 or 400 expected) for an otherwise valid server/discover sent with Content-Type: text/plain, as the server's own rejection, with the conformant setup server/discover served. ${GATE_PASS("")}`,
    fail: `The text/plain body is parsed and answered with a 2xx status, or a redirect; or the POST gets no answer, the resend after a 429 included ("server unreachable"). A rejecting status fails as not evaluable when it is ${GATE_FAIL()}, and any rejection (a status >= 400, or a JSON-RPC error on a 2xx) does when the conformant setup server/discover was itself rejected or got no response (when that discover drew the probe's 403, its answer is the twin and no further server/discover is sent). Otherwise ${GATE_5XX("", "the POST")}.`,
    gate: null,
  },
  "transport-batch-reject": {
    pass: `A JSON array of two valid server/discover requests draws HTTP 4xx or a JSON-RPC error body, as the server's own rejection, with the conformant setup server/discover served. ${GATE_PASS("-32600")}`,
    fail: `A 2xx status without a JSON-RPC error, an array response (a JSON array body, or an SSE data frame holding an array), or a text/event-stream carrying no JSON-RPC response (notifications before an error frame are ignored); or the batch gets no answer, the resend after a 429 included ("server unreachable"). A rejecting status fails as not evaluable when it is ${GATE_FAIL()}, and any rejection (a status >= 400, or a JSON-RPC error on any status) does when the conformant setup server/discover was itself rejected or got no response (a -32600 on a 5xx is then neither credited nor warned about; when that discover drew the probe's 403, its answer is the twin and no further server/discover is sent). Otherwise ${GATE_5XX("-32600", "the batch")}.`,
    gate: null,
  },
  "transport-notification-202": {
    pass: "HTTP 202 for a POSTed notifications/cancelled; a 4xx refusal also passes but is reported as a warning.",
    fail: "HTTP 200, 204, or any 5xx.",
    gate: null,
  },
  "transport-concurrent": {
    pass: "Three parallel server/discover POSTs each return a 2xx response whose id matches the request that produced it.",
    fail: "Any response missing, non-2xx, or carrying the id of a different request.",
    gate: null,
  },
  "transport-get-removed": {
    pass: "HTTP 405 for GET on the MCP endpoint; another 4xx passes with a warning.",
    fail: "A text/event-stream response, any 2xx, or any 5xx.",
    gate: null,
  },
  "transport-delete-removed": {
    pass: "HTTP 405 for DELETE on the MCP endpoint; another 4xx passes with a warning.",
    fail: "Any 2xx or 5xx status.",
    gate: null,
  },
  "transport-session-ignored": {
    pass: "A valid server/discover carrying a fabricated Mcp-Session-Id header returns a normal result with no Mcp-Session-Id header on the response.",
    fail: "HTTP 404 or 400 keyed to the unknown session, or a minted or echoed Mcp-Session-Id response header.",
    gate: null,
  },
  "transport-header-version-required": {
    pass: `HTTP 400 for a complete server/discover body sent without the MCP-Protocol-Version header, ${NOT_EVALUABLE}; a body without error code -32020 is reported as a warning.`,
    fail: `Any status other than 400, or a 400 or transport-level status (401, 403, 413, 415, 429) from a server whose conformant server/discover was itself rejected or unanswered.`,
    gate: null,
  },
  "transport-header-version-mismatch": {
    pass: `HTTP 400 and a JSON-RPC error with code -32020 when the header says 2026-07-28 and _meta says 1999-01-01, ${NOT_EVALUABLE}.`,
    fail: `A status other than 400, an error code other than -32020, a result, or a 400 from a server whose conformant server/discover was itself rejected.`,
    gate: null,
  },
  "transport-header-method-required": {
    pass: `HTTP 400 for a valid server/discover body sent without the Mcp-Method header, ${NOT_EVALUABLE}; a missing or different error code is reported as a warning.`,
    fail: "Any status other than 400, or a 400 from a server whose conformant server/discover was itself rejected or unanswered.",
    gate: null,
  },
  "transport-header-method-mismatch": {
    pass: `HTTP 400 when Mcp-Method: tools/list is sent on a server/discover body, ${NOT_EVALUABLE}; a missing -32020 code is reported as a warning.`,
    fail: "Any status other than 400 (the request was routed on one value and executed on another), or a 400 from a server whose conformant server/discover was itself rejected.",
    gate: null,
  },
  "transport-header-name-mismatch": {
    pass: `HTTP 400 for a resources/read of the first listed resource (else a prompts/get of the first prompt without required arguments) whose Mcp-Name header names a different object than the body, ${NOT_EVALUABLE}; a missing -32020 code is reported as a warning. The lists are fetched on demand; skipped when the server declares neither resources nor prompts or nothing listed is readable by name alone, and skipped pointing at the failed -list rules when a declared list call failed (even if the other list worked but held nothing readable by name) and those rules are in the run.`,
    fail: `Any status other than 400, a 400 from a server whose conformant server/discover was itself rejected, or a declared list call failed while its -list rule was filtered out of the run (the recorded reasons are named).`,
    gate: null,
  },
  "transport-header-case-insensitive": {
    pass: "A valid server/discover whose standard headers are spelled in lowercase (mcp-protocol-version, mcp-method) returns a normal result.",
    fail: "HTTP 400 or any other rejection attributable to header spelling.",
    gate: null,
  },
  "transport-no-server-requests": {
    pass: "No recorded server message on any response stream or on stdout carries both method and id.",
    fail: `At least one server-to-client JSON-RPC request was observed during the run. ${EMPTY_RECORDING}`,
    gate: null,
  },
  "stdio-framing": {
    pass: "Five rapid server/discover requests each receive a response on its own newline-terminated line of JSON.",
    fail: "Any of the five is unanswered, split across lines, or interleaved with non-JSON output on stdout.",
    gate: null,
  },
  "stdio-unicode": {
    pass: `The chosen tool (one named echo, else the first with a string property named message/text/input/query, else the first tool; tools/list fetched on demand) reproduces the CJK/emoji probe byte-for-byte, or reproduces every non-ASCII piece of it somewhere in the reply (a tokenizing tool); or, when the tool merely does not echo its input, a server/discover whose clientInfo name carries the probe is answered with a result.`,
    fail: `The tool reply or the discover reply shows mangling (U+FFFD, a Latin-1 mis-decode, the non-ASCII characters replaced by '?', or the probe's first word present with neither the CJK word nor the emoji anywhere in the reply), the tool call draws -32700, the discover carrying the probe in clientInfo is rejected or answered with a non-JSON-RPC reply, or a probe that is sent gets no reply because the server crashes or never answers it -- a tool call that gets none ends the check at once, without falling back to the discover (the details give a one-line reason, such as the exit code or the timeout) -- or a probe is answered by a child that then exits or stops answering (a plain server/discover between the tool call and the envelope probe, and after the last answered probe a wait of up to 250 ms for the exit followed by a plain server/discover, each with the per-request timeout, find it gone or get no reply; a child found gone when the next probe is about to be sent charges the probe it answered last; a child still running but silent for the whole --timeout fails as a hang, is named in a warning and is not restarted). Details keep to 220 characters, the note on the tool call and then the tool's name giving way, never the conclusion. A child that exits on the probe, or right after answering it, is restarted for the checks after this one, with a warning naming it, on every attempt; a child already gone before the probe was sent fails as server unreachable and is not restarted.`,
    gate: null,
  },
  "stdio-unknown-method-recovers": {
    pass: "The bogus method draws a JSON-RPC error (-32601 expected) and the server/discover sent immediately after succeeds on the same process.",
    fail: "The process exits, stops answering, or the follow-up server/discover fails.",
    gate: null,
  },
  "stdio-cancellation": {
    pass: "A notifications/cancelled for an unknown requestId produces no reply and the server/discover sent after it is answered normally.",
    fail: "Any message emitted in reply to the notification, the follow-up server/discover is unanswered, or the process exits.",
    gate: null,
  },
  // ── lifecycle ──
  "lifecycle-discover": {
    pass: "server/discover with a conformant _meta returns a result carrying a supportedVersions array and a capabilities object.",
    fail: "A JSON-RPC error, no response, or a result missing either field. Over HTTP a 429 is resent once after Retry-After (capped at 2 s) and the second answer decides, for this rule, its lifecycle-discover-* siblings, lifecycle-jsonrpc, the capability gates and the negative probes alike; a resend that gets no response is server unreachable.",
    gate: null,
  },
  "lifecycle-discover-versions": {
    pass: "supportedVersions is non-empty and every entry is a YYYY-MM-DD string; the absence of 2026-07-28 is reported as a warning.",
    fail: "An empty array, or any entry that is not a date-shaped string.",
    gate: null,
  },
  "lifecycle-discover-caching": {
    pass: "The server/discover result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.",
    fail: "Either field missing, ttlMs negative or non-integer, or an unknown cacheScope value.",
    gate: null,
  },
  "lifecycle-jsonrpc": {
    pass: "The server/discover response has jsonrpc exactly '2.0', the request id echoed, and exactly one of result (an object) or error. Over HTTP the setup server/discover that every lifecycle rule reads is resent once after Retry-After (capped at 2 s) when it draws a 429, and the answer it settles on is judged (the details add '; resent once after HTTP 429'); a server's own refusal code (-32600, -32601, -32602, -32020, -32021 or -32022) on a 5xx passes with a warning that a 4xx is expected.",
    fail: "A missing or wrong jsonrpc field, a missing id, both or neither of result/error, or a non-object result. Over HTTP a discover answered without a result fails as not evaluable when something in front of the server wrote the envelope: a 401, any 403 (an auth gate's, or one that refused the conformant request itself, so no twin is sent; a message naming Host/Origin validation is quoted), a 429 still a 429 after its one resend, or a 5xx without one of those codes (this rule's probe is the conformant request, so a 5xx on it is not read as the server failing on a defect). A resend that gets no response is server unreachable.",
    gate: null,
  },
  "lifecycle-id-match": {
    pass: "The id on the server/discover response equals the id the suite sent.",
    fail: "A different, missing, or null id.",
    gate: null,
  },
  "lifecycle-string-id": {
    pass: "A server/discover sent with a string id is answered with the identical string id.",
    fail: "The id is coerced to a number, replaced, or dropped.",
    gate: null,
  },
  "lifecycle-capabilities": {
    pass: "The server/discover result has a capabilities object and every declared feature is itself an object (an empty {} is valid).",
    fail: "capabilities missing or not an object, or a feature declared as a boolean, string, or other non-object.",
    gate: null,
  },
  "lifecycle-server-info": {
    pass: "result._meta['io.modelcontextprotocol/serverInfo'] on the server/discover result carries string name and version fields.",
    fail: "serverInfo absent from _meta, or name or version missing or not strings.",
    gate: null,
  },
  "lifecycle-instructions": {
    pass: "instructions is absent from the server/discover result, or present as a string.",
    fail: "instructions is present with a non-string type.",
    gate: null,
  },
  "lifecycle-meta-required": {
    pass: `A server/discover with no params._meta draws a JSON-RPC error (HTTP 400 on HTTP), ${NOT_EVALUABLE}; code -32602 is expected and any other code is reported as a warning. Runs after the feature tests and before the security tests, so a dual-era stdio server is already pinned modern (a --only run on stdio sends the first declared list, else ping, first) and the rate-limit burst cannot have tripped an intermediary.`,
    fail: `A result is returned, on HTTP the error arrives with a status other than 400 or no JSON-RPC error body arrives on a status other than 400 (a bare 400 passes with a warning), the conformant server/discover was itself rejected or unanswered, or the answer is a transport-level status (401, 403, 413, 415, 429) -- the last two not evaluable.`,
    gate: null,
  },
  "lifecycle-meta-protocol-version-required": {
    pass: `A _meta without protocolVersion draws a JSON-RPC error (HTTP 400 on HTTP), ${NOT_EVALUABLE}; -32602 is expected and another code (typically -32020) is reported as a warning. Runs after the feature tests and before the security tests.`,
    fail: `A result is returned, on HTTP the error arrives with a status other than 400 or no JSON-RPC error body arrives on a status other than 400 (a bare 400 passes with a warning), the conformant server/discover was itself rejected or unanswered, or the answer is a transport-level status (401, 403, 413, 415, 429) -- the last two not evaluable.`,
    gate: null,
  },
  "lifecycle-meta-client-capabilities-required": {
    pass: `A _meta without clientCapabilities draws a JSON-RPC error (HTTP 400 on HTTP), ${NOT_EVALUABLE}; -32602 is expected and another code is reported as a warning.`,
    fail: `The request is served as if {} had been sent, on HTTP the error arrives with a status other than 400 or no JSON-RPC error body arrives on a status other than 400 (a bare 400 passes with a warning), the conformant server/discover was itself rejected or unanswered, or the answer is a transport-level status (401, 403, 413, 415, 429) -- the last two not evaluable.`,
    gate: null,
  },
  "lifecycle-meta-client-info-optional": {
    pass: "A server/discover whose _meta omits clientInfo returns a normal result.",
    fail: "A JSON-RPC error or non-2xx status caused by the missing clientInfo; when the conformant server/discover was itself rejected, or the answer is a transport-level status (401, 403, 413, 415, 429), the failure is reported as not evaluable.",
    gate: null,
  },
  "lifecycle-version-unsupported": {
    pass: "Protocol version 1999-01-01 draws code -32022 with data.supported non-empty and a subset of the discover supportedVersions, data.requested equal to '1999-01-01', and HTTP 400 on HTTP.",
    fail: "A result, a different error code, an empty or malformed data.supported, a wrong data.requested, or on HTTP a status other than 400.",
    gate: null,
  },
  "lifecycle-removed-methods": {
    pass: `ping, logging/setLevel and resources/subscribe each draw a JSON-RPC error (or, on HTTP, a bare 404 with no JSON-RPC body), credited only when the conformant server/discover was served; -32601 (HTTP 404 on HTTP) is expected, and another code, another status with -32601, or a bare 404 is reported as a warning.`,
    fail: `Any of the three methods returns a result, gets no response, or draws neither a result nor an error; on HTTP, a bare status other than 404 with no JSON-RPC body, or a transport-level status (401, 403, 413, 415, 429) on any of the three (not evaluable); or all three are rejected by a server whose conformant server/discover was itself rejected or unanswered (not evaluable).`,
    gate: null,
  },
  "lifecycle-dual-era": {
    pass: `On every classified outcome: a result to the legacy initialize (sent to a fresh process on stdio) is reported as dual-era when server/discover was served and as legacy-only (with a warning) when it was not, an error as modern-only; an error that names no supported version -- neither in data.supported nor as a date other than the requested 2025-11-25 in the message -- is reported as a warning. No response (a timeout within the probe budget, or a connection error), a transport-level status (401, 403, 413, 415, 429), and a stdio fresh process that exits alongside a second instance that exits at startup too (a single-instance server) pass with a warning as era undetermined, flagged as skips (nothing the server said about its era was read).`,
    fail: `Only when a stdio server exits after the legacy initialize request while a second instance spawned with no input stays up (the request is what it exits on).`,
    gate: null,
  },
  "lifecycle-capability-handlers-match": {
    pass: "For each of tools, resources and prompts: a declared capability's list method returns a result and an undeclared capability's list method returns a JSON-RPC error (-32601 expected).",
    fail: "A declared capability whose list method errors, or an undeclared capability whose list method returns a result.",
    gate: null,
  },
  "lifecycle-subscriptions-listen": {
    pass: `With a listChanged or subscribe capability declared, the first frame on a subscriptions/listen stream is notifications/subscriptions/acknowledged carrying _meta subscriptionId equal to the request id and a notifications object; an acknowledgment that honours a type or URI the request did not include passes with a warning. With nothing advertised, either that acknowledgment or a rejection passes (-32601 expected; another error code, or a 4xx with no JSON-RPC body, passes with a warning), the rejection credited only when the conformant server/discover was served and it is the server's own. Over HTTP a 429 on the listen is resent once after Retry-After (capped at 2 s), a -32601 on a 5xx passes with a warning that a 4xx is expected when nothing is advertised, and ${TWIN_CREDITS()}.`,
    fail: `Any other frame first, a subscriptionId that differs from the request id, a missing notifications object, a rejection when something is advertised, a result before any acknowledgment, a rejection from a server whose conformant server/discover was itself rejected (not evaluable), no acknowledgment within the listen timeout, or a stdio server that exits before acknowledging. Over HTTP a rejection fails as not evaluable, advertised or not, when it is ${GATE_FAIL()}. ${GATE_5XX_SENTENCE("-32601", "the listen")} With something advertised, a -32601 on a 5xx fails as the server's own rejection of a method it advertises ('... rejected with -32601 (HTTP 500) although tools.listChanged advertised'), with no warning.`,
    gate: null,
  },
  "lifecycle-log-level-gating": {
    pass: "Every recorded notifications/message arrived on the response to a request that carried _meta['io.modelcontextprotocol/logLevel'].",
    fail: `A notifications/message on a request that set no logLevel, or on a subscriptions/listen stream. ${EMPTY_RECORDING}`,
    gate: null,
  },
  "lifecycle-meta-tolerance": {
    pass: "A server/discover carrying an extra vendor-prefixed _meta key returns a normal result.",
    fail: "A JSON-RPC error or no result for the probe carrying the unknown key. When the conformant server/discover was itself rejected or unanswered, or the probe drew a transport-level status (401, 403, 413, 415, 429), it fails as not evaluable instead of blaming the key.",
    gate: null,
  },
  "lifecycle-completions": {
    pass: "When the completions capability is declared, completion/complete for the first listed prompt argument (else the first resource-template variable, still used when prompts/list failed; prompts/list and resources/templates/list are fetched on demand) returns a result with a completion.values array (empty allowed); with nothing listed a placeholder ref is probed, where -32602 also passes. Skipped when the capability is absent, and skipped pointing at prompts-list / resources-templates when a declared list the probe draws from failed and that rule is in the run.",
    fail: "A JSON-RPC error (other than -32602 for the placeholder probe), a result without completion.values as an array, or a declared prompts/list or resources/templates/list failed (not a -32601 from resources/templates/list) with no argument listed while its owning rule was filtered out of the run (the recorded reason is named).",
    gate: "completions",
  },
  "lifecycle-progress-token": {
    pass: `tools/call of the first tool without required arguments (tools/list fetched on demand) with _meta.progressToken completes, and every notifications/progress observed for it carries the same token with a strictly increasing progress value (no notifications at all also passes). A 429 on any of the check's calls is resent once after Retry-After (capped at 2 s). A call that fails on the server's side passes as an observation when the failure is not the token's: the server's own answer to the same call without the token, sent right after, failed the same way (the same JSON-RPC error code whatever the HTTP status; with no JSON-RPC error, the same status), or the call carrying the token, resent after that, was answered without failing again (a cold backend's first call passes on the served resend, whose notifications are judged the same way); or the call without the token failed differently and the call carrying the token, resent, was served or answered as the call without it was. Skipped when the server declares no tools; skipped pointing at tools-list when tools/list failed and that rule is in the run; and skipped as measuring nothing about the token when a gate answered one of the calls (a 429 still a 429, a 401, or a 403 that reads as an auth refusal: without --auth any Bearer challenge, with --auth one carrying an error parameter), the call without the token got no response, the first or resent call got none (a timeout, a connection never established, a stdio child already gone), or, after a call without the token that failed differently, the resent call carrying it reproduced neither failure.`,
    fail: `A progress notification carrying a foreign token, or a non-numeric or non-increasing progress value (on the call or on its resend); a call carrying _meta.progressToken that fails on the server's side (a JSON-RPC error, an HTTP status >= 400 other than a 429 or an auth gate's 401 / 403, a connection the server closed, or a stdio exit -- before the answer, or right after it, found by a plain server/discover sent after each answered call and, after a call the server failed, a wait of up to 250 ms for the exit -- after which the child is restarted with a warning) while the same call without it, sent right after, is served and the call carrying it fails again when resent; or the call without the token failed differently (a tool whose required arguments the empty call lacks answers -32602 without it) and the call carrying the token, resent, failed the way it first did; or tools/list failed while tools-list was filtered out of the run (the recorded reason is named). Progress notifications on a call the server fails do not make it pass.`,
    gate: null,
  },
  // ── tools ──
  "tools-list": {
    pass: "tools/list returns a result with a tools array whose entries are objects (empty allowed).",
    fail: "A JSON-RPC error, or a result without a tools array of objects.",
    gate: "tools",
  },
  "tools-list-caching": {
    pass: "The tools/list result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.",
    fail: `Either hint missing or invalid, or the tools/list call got no response (reported once; not re-sent).`,
    gate: "tools",
  },
  "tools-list-deterministic-order": {
    pass: `Three consecutive tools/list calls return the tool names in the same order. Fewer than two listed tools, or a tool set that changed between the calls, leaves no order to compare: the pass is flagged as a skip. ${LIST_FAILED_SKIP("tools")}`,
    fail: `The order differs between any two of the three calls. ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "tools-call": {
    pass: `Calling the first tool without required properties (else the first tool) with empty arguments returns a content array whose items each carry a type (isError: true included), an input_required result with well-formed inputRequests and/or a string requestState, or a JSON-RPC error (-32602/-32600 as the expected answer for a tool that needs arguments; any other code is noted as a protocol error). resultType 'complete' is left to schema-result-type. Skipped when the server lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `No result object, a non-input_required result without a content array, a content item without a type, or an input_required result with neither field or a malformed inputRequests entry. ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "tools-content-types": {
    pass: `Every item in the tools/call content array has a type of text, image, audio, resource, or resource_link. Skipped when the server lists no tools; a result with no content items passes as a skip. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any content item with a missing or unrecognised type. ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "tools-pagination": {
    pass: "No nextCursor on tools/list, or a string nextCursor that yields another valid page when passed back as cursor.",
    fail: "A non-string nextCursor, or a follow-up page that errors or is malformed.",
    gate: "tools",
  },
  // ── resources ──
  "resources-list": {
    pass: "resources/list returns a result with a resources array whose entries are objects (empty allowed).",
    fail: "A JSON-RPC error, or a result without a resources array of objects.",
    gate: "resources",
  },
  "resources-list-caching": {
    pass: "The resources/list result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.",
    fail: `Either hint missing or invalid, or the resources/list call got no response (reported once; not re-sent).`,
    gate: "resources",
  },
  "resources-read": {
    pass: `Reading the first listed resource that has a uri returns a contents array whose items carry uri and text or blob, or an input_required result with a valid InputRequiredResult shape; an empty contents array passes with a warning. resultType 'complete' is left to schema-result-type. Skipped when the server lists no resource with a uri. ${LIST_FAILED_SKIP("resources")}`,
    fail: `A JSON-RPC error, no result object, no contents array, a contents item missing uri or both text and blob, or a malformed input_required result. ${LIST_FAILED_FAIL("resources")}`,
    gate: "resources",
  },
  "resources-read-caching": {
    pass: `The complete resources/read result carries ttlMs as an integer >= 0 and cacheScope equal to public or private; input_required interim results are exempt. Skipped when the server lists no resource with a uri. ${LIST_FAILED_SKIP("resources")}`,
    fail: `Either hint missing or invalid on a complete result. ${LIST_FAILED_FAIL("resources")}`,
    gate: "resources",
  },
  "resources-not-found": {
    pass: "Reading a nonexistent URI draws JSON-RPC error -32602; a missing data.uri is reported as a warning.",
    fail: "A result of any shape (including an empty contents array or input_required), or any error code other than -32602 (the retired -32002, -32603, -32601, ...).",
    gate: "resources",
  },
  "resources-templates": {
    pass: "resources/templates/list returns a resourceTemplates array whose entries carry uriTemplate and name, or a -32601 Method not found error.",
    fail: "A malformed result, or an error other than -32601.",
    gate: "resources",
  },
  "resources-templates-caching": {
    pass: "When resources/templates/list succeeds, its result carries ttlMs as an integer >= 0 and cacheScope equal to public or private; skipped when the method is not implemented.",
    fail: `Either hint missing or invalid on a successful result, or the resources/templates/list call got no response (reported once; not re-sent).`,
    gate: "resources",
  },
  "resources-pagination": {
    pass: "No nextCursor on resources/list, or a string nextCursor that yields another valid page when passed back as cursor.",
    fail: "A non-string nextCursor, or a follow-up page that errors or is malformed.",
    gate: "resources",
  },
  // ── prompts ──
  "prompts-list": {
    pass: "prompts/list returns a result with a prompts array whose entries are objects (empty allowed).",
    fail: "A JSON-RPC error, or a result without a prompts array of objects.",
    gate: "prompts",
  },
  "prompts-list-caching": {
    pass: "The prompts/list result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.",
    fail: `Either hint missing or invalid, or the prompts/list call got no response (reported once; not re-sent).`,
    gate: "prompts",
  },
  "prompts-get": {
    pass: `Getting the first prompt without required arguments (else the first prompt, its required arguments filled with the placeholder 'test') returns a messages array whose items have role user or assistant and a content object, an input_required result with a valid InputRequiredResult shape, or a -32602/-32600 error. resultType 'complete' is left to schema-result-type. Skipped when the server lists no prompts. ${LIST_FAILED_SKIP("prompts")}`,
    fail: `A JSON-RPC error other than -32602/-32600, no result object, a missing or malformed messages array, or a malformed input_required result. ${LIST_FAILED_FAIL("prompts")}`,
    gate: "prompts",
  },
  "prompts-pagination": {
    pass: "No nextCursor on prompts/list, or a string nextCursor that yields another valid page when passed back as cursor.",
    fail: "A non-string nextCursor, or a follow-up page that errors or is malformed.",
    gate: "prompts",
  },
  // ── errors ──
  "error-unknown-method": {
    pass: `A JSON-RPC error echoing the request id; on HTTP a 404 status passes cleanly and an error carried on another status (a 200, a 400) passes with a warning. A 429 is resent once after Retry-After (capped at 2 s), a -32601 on a 5xx passes with a warning that the spec requires 404, and ${TWIN_CREDITS()}.`,
    fail: `A result, no JSON-RPC error, no response, or an error that does not echo the request id. A server that rejects server/discover too fails as not evaluable, and so does an answer something in front of the server gave: ${GATE_FAIL()}. A 429 is not resent while server/discover was rejected. ${GATE_5XX_SENTENCE("-32601", "the probe")}`,
    gate: null,
  },
  "error-method-code": {
    pass: "The unknown-method error carries exactly code -32601.",
    fail: "Any other code (-32600, -32000, or an application code). A server that rejects server/discover too fails as not evaluable.",
    gate: null,
  },
  "error-invalid-jsonrpc": {
    pass: `A JSON object with no method and no id draws a JSON-RPC error or an HTTP 4xx status. ${GATE_PASS("-32600")}`,
    fail: `A result, a status below 400 without a JSON-RPC error, or no response. A server that rejects server/discover too fails as not evaluable, and so does an answer something in front of the server gave: ${GATE_FAIL()}. A 429 is not resent while server/discover was rejected. ${GATE_5XX_SENTENCE("-32600", "the probe")}`,
    gate: null,
  },
  "error-invalid-json": {
    pass: `The body '{not json' draws a JSON-RPC error (-32700 expected) or an HTTP 4xx status. ${GATE_PASS("-32700")}`,
    fail: `A hang, a result, or a status below 400 without a JSON-RPC error (an HTML page on a 200). A server that rejects server/discover too fails as not evaluable, and so does an answer something in front of the server gave: ${GATE_FAIL()}. A 429 is not resent while server/discover was rejected. ${GATE_5XX_SENTENCE("-32700", "the probe")}`,
    gate: null,
  },
  "error-parse-code": {
    pass: `The invalid-JSON response carries exactly code -32700; a 4xx with no JSON-RPC body passes with a warning when it is the server's own: a 429 is resent once after Retry-After (capped at 2 s), and ${TWIN_CREDITS()}.`,
    fail: `A JSON-RPC error with a code other than -32700, a result, or no JSON-RPC error on a status below 400 or a 5xx. A server that rejects server/discover too fails as not evaluable (its probe is then not resent after a 429), and so does a 4xx without a JSON-RPC body that something in front of the server gave (a rate limiter's, an auth gate's or a WAF's bodiless refusal): ${GATE_FAIL()}.`,
    gate: null,
  },
  "error-invalid-request-code": {
    pass: `The malformed-envelope response carries exactly code -32600; a 4xx with no JSON-RPC body passes with a warning when it is the server's own: a 429 is resent once after Retry-After (capped at 2 s), and ${TWIN_CREDITS()}.`,
    fail: `A JSON-RPC error with a code other than -32600 (for example -32601 or -32602), a result, or no JSON-RPC error on a status below 400 or a 5xx. A server that rejects server/discover too fails as not evaluable (its probe is then not resent after a 429), and so does a 4xx without a JSON-RPC body that something in front of the server gave (a rate limiter's, an auth gate's or a WAF's bodiless refusal): ${GATE_FAIL()}.`,
    gate: null,
  },
  "error-missing-params": {
    pass: `tools/call with params carrying only _meta (no name) draws a JSON-RPC error (-32602 expected). ${GATE_PASS("-32602")} Skipped when the server declares no tools.`,
    fail: `A result (isError: true included), no JSON-RPC error, or no response. An error the server did not write fails as not evaluable: ${GATE_FAIL()}. ${GATE_5XX_SENTENCE("-32602", "the probe")}`,
    gate: "tools",
  },
  "tools-call-unknown": {
    pass: "tools/call with a name the server did not list draws a JSON-RPC error (-32602 expected) or a result with isError: true. Skipped when the server declares no tools.",
    fail: "A successful result without isError: true.",
    gate: "tools",
  },
  "error-capability-gated": {
    pass: `Every list method for a capability the discover result did not declare draws a JSON-RPC error (-32601 expected) or a rejecting status, as the server's own rejection. Each method's 429 is resent once after Retry-After (capped at 2 s), a -32601 on a 5xx passes with a warning that a 4xx is expected, and ${TWIN_CREDITS().replace(" sent next to it (a 429 on it resent once)", ", sent at most once for all the methods (a 429 on it resent once),")}. Skipped when every capability is declared.`,
    fail: `A list method for an undeclared capability returns a result or gets no response. Without a served server/discover the test fails as not evaluable (the answers are still recorded, a 429 not resent); with one, so does an answer something in front of the server gave, the methods grouped by reason and those with the same answer named together: ${GATE_FAIL()}. ${GATE_5XX_SENTENCE("-32601", "the method")} When the details cannot hold every group, a method the server failed on is named first, and is never called not evaluable.`,
    gate: null,
  },
  "error-invalid-cursor": {
    pass: `A garbage cursor on the first supported list method draws a JSON-RPC error (-32602 expected) or a valid first page. ${GATE_PASS("-32602", "the same list method sent without the cursor next to it")}`,
    fail: `A result on a 5xx status, a crash (no response), a result without the list's array, or neither an error nor a result. An error or rejecting status fails as not evaluable when it is ${GATE_FAIL("the same list method sent without the cursor")}, so a gateway or ACL that lets server/discover through but refuses the list method itself is not credited. ${GATE_5XX_SENTENCE("-32602", "the cursor")}`,
    gate: null,
  },
  "error-id-echo": {
    pass: `Every recorded JSON-RPC error response (jsonrpc 2.0 with an error object carrying a numeric code) that answers an id-bearing request carries that same id; an id-less reply is attributed by timeline to the nearest earlier request that neither got its own reply nor had its exchange ended by the client (a finished HTTP response, a closed HTTP stream, a cancelled request), or to a more recent client notification or raw probe (which counts only while no request sent after it was answered before the stray arrived, and over HTTP only while its exchange was open). Exempt: replies to the suite's raw probes and client notifications, and replies without an id on HTTP 401/403/413/415/429 transport-level rejections; non-JSON-RPC error bodies (a gateway's {"error":...}) are not counted. A reply that arrives before the suite sent any request (a stray written at boot) is exempt too and noted as such. With no error response to an id-bearing request the pass is flagged as a skip.`,
    fail: `A JSON-RPC error with a null or missing id in reply to a well-formed request, whatever the error code (-32600 and -32700 included) -- including an id-less second answer to a request that already got its own reply, in either frame order, which is blamed on the most recent request sent before it -- or a present but wrong id whatever the HTTP status. ${EMPTY_RECORDING}`,
    gate: null,
  },
  "error-retired-codes": {
    pass: "No recorded JSON-RPC error carries code -32002 or -32042; with no JSON-RPC error recorded at all the pass is flagged as a skip.",
    fail: `Any occurrence of either code. ${EMPTY_RECORDING}`,
    gate: null,
  },
  // ── schema ──
  "tools-schema": {
    pass: `Every listed tool has a name matching [A-Za-z0-9_.-]{1,128} and an inputSchema object with type 'object'. ${LIST_ON_DEMAND("tools")}`,
    fail: "Any tool with a missing or malformed name, or an inputSchema that is absent, null, or not type 'object'.",
    gate: "tools",
  },
  "tools-annotations": {
    pass: `On every tool that carries annotations, readOnlyHint, destructiveHint, idempotentHint and openWorldHint are booleans when present and title is a string when present. ${LIST_ON_DEMAND("tools")}`,
    fail: "Any annotation hint with a non-boolean value, or a non-string annotations.title.",
    gate: "tools",
  },
  "tools-title-field": {
    pass: `Every listed tool that has a title has a string one; tools without a title are named in the details but still pass. ${LIST_ON_DEMAND("tools")}`,
    fail: "Any tool whose title is present but not a string.",
    gate: "tools",
  },
  "tools-output-schema": {
    pass: `Every declared outputSchema is a non-null JSON Schema object; any root type is accepted. ${LIST_ON_DEMAND("tools")}`,
    fail: "An outputSchema that is null, not an object, or otherwise not a JSON Schema object.",
    gate: "tools",
  },
  "prompts-schema": {
    pass: `Every listed prompt has a string name and every entry in its arguments array has a name. ${LIST_ON_DEMAND("prompts")}`,
    fail: "A prompt without a string name, or an argument without a name.",
    gate: "prompts",
  },
  "resources-schema": {
    pass: `Every listed resource has a parseable absolute URI and a string name. ${LIST_ON_DEMAND("resources")}`,
    fail: "An unparseable uri, or a missing or non-string name.",
    gate: "resources",
  },
  "schema-result-type": {
    pass: "Every recorded JSON-RPC result (the reply to the suite's legacy initialize probe exempt) carries resultType 'complete' or 'input_required'; another string value passes with a warning only when server/discover advertised a non-empty extensions capability. With no result recorded the pass is flagged as a skip.",
    fail: `A result with no string resultType, or a value other than complete/input_required while no extension is advertised. ${EMPTY_RECORDING}`,
    gate: null,
  },
  "schema-no-input-required-on-lists": {
    pass: "Every recorded input_required result answers tools/call, prompts/get, or resources/read; with no result recorded the pass is flagged as a skip.",
    fail: `An input_required result on server/discover, a list method, completion/complete, subscriptions/listen, or any other method. ${EMPTY_RECORDING}`,
    gate: null,
  },
  "schema-input-required-shape": {
    pass: `Every observed input_required result has inputRequests and/or requestState; each inputRequests value is an object whose method is elicitation/create, sampling/createMessage or roots/list and whose client capability the suite declared (elicitation only), with a params object for elicitation/create and sampling/createMessage; an elicitation/create's params.mode (form when absent) is a mode the declared elicitation capability covers (the suite's elicitation: {} is form only); requestState is a string when present. Passes, flagged as a skip, when none was observed.`,
    fail: `An input_required result missing both fields, an entry with an unknown method, a method whose client capability was not declared (sampling/createMessage, roots/list), an elicitation mode the client did not declare (url under elicitation: {}), a missing params object where required, or a non-string requestState. ${EMPTY_RECORDING}`,
    gate: null,
  },
  "schema-wire-valid": {
    pass: `Every recorded server message validates against the vendored 2026-07-28 JSON schema for its message type; replies to raw probes and to the legacy initialize are skipped, an error's id: null is treated as omitted, and a non-JSON-RPC body on any HTTP 4xx or 5xx (an auth gate, a header-validating intermediary, a gateway) is noted rather than validated. When nothing validatable was received the pass is flagged as a skip.`,
    fail: `Any other message that fails schema validation, including a non-JSON-RPC body served at 2xx (the details list the distinct violations grouped by originating method and first schema error, with counts; the overflow goes to a warning). ${EMPTY_RECORDING}`,
    gate: null,
  },
  // ── security ──
  "security-auth-required": {
    pass: "A conformant server/discover with the Authorization header removed draws HTTP 401, or a 403 carrying a WWW-Authenticate Bearer challenge (probed with or without --auth). With --auth and a credentialed server/discover that got past the gate (served, or answered at 2xx even with a JSON-RPC error such as -32021), a 403 without a Bearer challenge (the details note the spec expects 401) or a connection closed without an answer also passes.",
    fail: "A 2xx: the server accepted an unauthenticated request (the details say when no --auth was provided); any other status fails as what it is instead -- a non-401/403 4xx refused the request without asking for a credential, a 5xx failed on it, a 3xx redirected it. A 403 without a Bearer challenge fails as not evaluable unless --auth was given and the credentialed server/discover got past the gate; the details quote the server's error message and advise allowing the hostname you tested through when it names Host/Origin validation or the credentialed request drew a 403 too, name --auth when none was given, and otherwise name how the credentialed request was answered (its status and JSON-RPC error code). A timeout or refused connection fails as server unreachable, and so does a closed connection without that comparison.",
    gate: null,
  },
  "security-www-authenticate": {
    pass: `The 401 observed on the unauthenticated server/discover carries a WWW-Authenticate header (a challenge without resource_metadata, or whose resource_metadata is not an absolute http(s) URL, passes with a warning). A 403 carrying a Bearer challenge is read the same way (the details name the HTTP 403). Skipped when no 401 was observed (a served request), and when a connection closed without an answer is the rejection security-auth-required credits (with a warning that clients need the 401 challenge); a bare 403 skips as not evaluable when security-auth-required could not attribute it to authentication, and passes as not applicable when it could.`,
    fail: "A 401 with no WWW-Authenticate header, or no HTTP answer at all (server unreachable).",
    gate: null,
  },
  "security-auth-malformed": {
    pass: "In place of the configured credential, Authorization: Bearer aW52YWxpZC10b2tlbg (well-formed, unissued) draws HTTP 401 or 403 and a value outside the RFC 6750 b64token grammar draws 400, 401 or 403 (a connection closed without an answer also counts as a rejection when the credentialed server/discover got past the gate). Requires --auth; skipped otherwise. With --auth, also skipped as not evaluable when security-auth-required could not attribute a bare 403 to authentication, and skipped instead of passing when the configured credential itself drew 401 on the setup server/discover.",
    fail: "Either credential is accepted (2xx), the well-formed invalid token draws a status other than 401/403, or the malformed credential draws a status other than 400/401/403 (whatever the configured credential drew); without such a status, a probe that got no HTTP answer (a timeout, a refused connection, or a drop when the credentialed server/discover did not get past the gate) fails as server unreachable.",
    gate: null,
  },
  "security-tls-required": {
    pass: "For an https target, the same server/discover over plain http to the same host is refused (a 4xx/5xx, or no plaintext answer) or redirected with a single Location that resolves to an https URL.",
    fail: "A result over plaintext, a redirect to http, without a Location, with an unparseable one or with several, or an http target (fails outright).",
    gate: null,
  },
  "security-oauth-metadata": {
    pass: `When the WWW-Authenticate challenge carries resource_metadata, that absolute URL (and only it) returns JSON with resource and a non-empty authorization_servers array; without one, /.well-known/oauth-protected-resource followed by the endpoint path, then the root, does, or a legacy /.well-known/oauth-authorization-server document exists (passes with a warning). A resource that is not the MCP endpoint in canonical form passes with a warning. Runs without --auth when the unauthenticated request drew a 401, or a 403 carrying a Bearer challenge; without --auth it is otherwise skipped -- when that request was served (the server requires no auth), as not evaluable on a bare 403 (see security-auth-required), and naming the status and suggesting --auth on any other answer. With --auth the lookup runs whatever that request drew; after a bare 403 security-auth-required could not attribute to authentication, it skips as not evaluable when every well-known location and /.well-known/oauth-authorization-server drew that same 403.`,
    fail: `An advertised resource_metadata URL that is not absolute http(s), unreachable, non-200, non-JSON, or lacks resource or a non-empty authorization_servers (a valid well-known document does not rescue it; the details name it); without a challenge URL, no candidate serves the document and no legacy metadata exists (with --auth, including after an unattributed bare 403 when any lookup drew something other than that 403), a served document is malformed, or every candidate is unreachable; or the unauthenticated server/discover got no answer at all (server unreachable).`,
    gate: null,
  },
  "security-token-in-uri": {
    pass: "A server/discover with the token moved from the Authorization header to the ?access_token= query parameter draws HTTP 401 or 403, a non-2xx status, or a JSON-RPC error (plain JSON or an SSE event); a connection closed without an answer counts when the credentialed server/discover got past the gate. Requires --auth. A 401/403 skips as not evaluable when security-auth-required could not attribute a bare 403 to authentication, and a pass skips instead when the configured credential itself drew 401 on the setup server/discover.",
    fail: "A 2xx result or non-error body (the query-string token was honoured, whatever the other auth probes drew), or no HTTP answer at all (server unreachable).",
    gate: null,
  },
  "security-cors-headers": {
    pass: "Access-Control-Allow-Origin on the OPTIONS preflight and on the server/discover response is absent or names a specific origin.",
    fail: "Access-Control-Allow-Origin: * is returned, the foreign Origin is reflected back, or neither probe gets an HTTP answer (server unreachable).",
    gate: null,
  },
  "security-origin-validation": {
    pass: "A fully valid server/discover with Origin: https://evil-rebinding-attack.example.com draws HTTP 403 (401, or another 4xx other than 429, also counts as rejected). A 401/403 counts only when the same server/discover without the Origin got past the gate (served, or answered at 2xx) or drew a different status; otherwise the check skips as not attributable to the Origin (see security-auth-required). A 429 is resent once after its Retry-After (capped at 2 s). A connection closed without an answer counts when the server/discover without the Origin got past the gate.",
    fail: "A 2xx status (the origin was not validated), a 5xx (the server failed on the request rather than refusing it), a 429 on the retry as well (not evaluable: a rate limiter answered), a 1xx/3xx status, or no HTTP answer at all (server unreachable).",
    gate: null,
  },
  "security-command-injection": {
    pass: `No result from the single target -- a tool with a string argument from the safest annotation tier (readOnlyHint true, then destructiveHint false, then unannotated, then destructiveHint true; the spec defaults destructiveHint to true), a free-form argument before an enum/const/pattern one, other required arguments filled with schema-honouring placeholders -- shows evidence of executing an injected shell payload (passwd lines, id output, directory listings) without rejection wording or isError; the details count rejected, benign and never-reached payloads (a dropped HTTP connection the server outlives -- a WAF or IPS, a keep-alive close, or one crashed worker of a multi-process server, which a client cannot tell apart -- counts as never reached, with a warning), and a run where no payload reached the tool passes as inconclusive with a warning, flagged as a skip (as does a server with no tool that takes a string argument). Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any result containing evidence of execution that is not also a rejection, or a server that dies on a payload (the stdio child exits, and is restarted for the checks after it; or on HTTP the connection is dropped and a follow-up server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or a crash of one worker of a multi-process server while the others still answer, which a client cannot tell apart -- counts as never reached instead). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-sql-injection": {
    pass: `No result from the same single target contains database error text or unexpected row dumps for the SQL payloads without rejection wording or isError; all never-reached passes as inconclusive with a warning, flagged as a skip. Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any result containing database error text or dumped rows that is not also a rejection, or a server that dies on a payload (the stdio child exits, and is restarted for the checks after it; or on HTTP the connection is dropped and a follow-up server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or a crash of one worker of a multi-process server while the others still answer, which a client cannot tell apart -- counts as never reached instead). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-path-traversal": {
    pass: `No result from the target (a path-named string argument when one exists in the safest annotation tier, else a URL-named one, else the shared injection target) contains file contents from outside the tool's scope for the traversal payloads without rejection wording or isError; all never-reached passes as inconclusive with a warning, flagged as a skip. Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any result containing out-of-scope file contents that is not also a rejection, or a server that dies on a payload (the stdio child exits, and is restarted for the checks after it; or on HTTP the connection is dropped and a follow-up server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or a crash of one worker of a multi-process server while the others still answer, which a client cannot tell apart -- counts as never reached instead). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-ssrf-internal": {
    pass: `No result from the target (a URL-named string argument when one exists in the safest annotation tier, else a path-named one, else the shared injection target) contains cloud-metadata or internal-service content for the internal targets without rejection wording or isError; all never-reached passes as inconclusive with a warning, flagged as a skip. Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any result containing metadata or internal-service content that is not also a rejection, or a server that dies on a payload (the stdio child exits, and is restarted for the checks after it; or on HTTP the connection is dropped and a follow-up server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or a crash of one worker of a multi-process server while the others still answer, which a client cannot tell apart -- counts as never reached instead). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-oversized-input": {
    pass: `A roughly 1 MB string in the first string argument that is not header-mirrored (a mirrored one only when no other exists, noted in the details) draws HTTP 413 or another 4xx on HTTP -- a 403 without a Bearer challenge included, the tool list having come from a served server/discover -- or a JSON-RPC error on either transport; a completed result passes with a warning, and so does a reply to that call that overflowed the runner's stdio line buffer while the child kept running (an earlier overflow in the run, or the same marker text on the server's own stderr, does not count); on HTTP a connection closed on the 1 MB body passes only when a follow-up server/discover is then served or refused with 401/403 (a 429 retried once). Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `A 5xx status, an HTTP 429 that answers the call again after one retry (Retry-After, capped at 2 s) or a 401 or auth-gate 403 -- each not evaluable, a gate having answered before the server read the request -- a timeout, a broken stdio frame, no usable HTTP response (bytes that are not an HTTP response), a stdio child that dies (even after overflowing the line buffer, or partway through reading the 1 MB line; the child is restarted for the checks after it), an HTTP connection dropped on the 1 MB body after which server/discover is neither served nor refused with 401/403, or a server already unreachable (a refused connection, a dead child). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-extra-params": {
    pass: `Arguments with properties the first tool's inputSchema does not define are rejected with a JSON-RPC error or ignored with a normal result; a call that times out, or an HTTP connection dropped on the call after which a follow-up server/discover is served or refused with 401/403 (a 429 retried once), passes with a warning (inconclusive, flagged as a skip). Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `A 5xx status, a malformed or unusable response (no result or error, or bytes that are not an HTTP response), a stdio child that exits (restarted for the checks after it), an HTTP connection dropped on the call after which server/discover is neither served nor refused with 401/403, or a server already unreachable (a refused connection, a dead child). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-tool-schema-defined": {
    pass: `Every listed tool has an inputSchema with type 'object'. Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any tool without such an inputSchema. ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-tool-rug-pull": {
    pass: `Two tools/list calls return identical definitions (name, description, inputSchema, annotations); after a stdio restart both come from the new process, one before and one after a tools/call. Skipped when the server declares no tools, or when a restarted process's list before use was not read or the tools/call between its lists killed it. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any definition differs between the two calls (after a stdio restart: between the new process's lists before and after a tools/call). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-tool-description-poisoning": {
    pass: `No tool name, title, description, or parameter description matches a prompt-injection pattern (instruction overrides, hidden Unicode, long Base64 runs in prose). Skipped when the server declares or lists no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any match (the tool and pattern are named in the details). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-tool-cross-reference": {
    pass: `No tool description mentions another listed tool's name (a plain-word name counts only in code-like context: backticks, quotes, a call, or 'the X tool'). Skipped when the server declares no tools. ${LIST_FAILED_SKIP("tools")}`,
    fail: `Any cross-reference found (named in the details). ${LIST_FAILED_FAIL("tools")}`,
    gate: "tools",
  },
  "security-error-no-stacktrace": {
    pass: `No distinct error response (each scanned once) contains a stack trace, a file path (Unix, or Windows raw or JSON-escaped -- a letter and colon before a JSON escape such as an escaped newline is not a drive), a module name, a framework internal or a database connection string that is not an echo of the request; a leak repeated across responses is reported once with a count. With no error response to scan (the probes drew results or no answer, and the run recorded no JSON-RPC error) the pass is flagged as a skip.`,
    fail: `Any such leak found, or none of the failure probes was answered and the run recorded no server message (server unreachable).`,
    gate: null,
  },
  "security-error-no-internal-ip": {
    pass: `No distinct error response contains a private or link-local IPv4 address (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), an IPv6 loopback (::1, [::1]:port, ::1:port), link-local or unique-local address, or an internal hostname (lowercase *.internal, *.local, *.corp, *.lan, *.intranet as the last label, with two or more labels before it or a preceding //, @, getaddrinfo, ENOTFOUND, EAI_AGAIN, or a :port) that is not an echo of the request. With no error response to scan the pass is flagged as a skip.`,
    fail: `Any such address or hostname found, or none of the failure probes was answered and the run recorded no server message (server unreachable).`,
    gate: null,
  },
  "security-rate-limiting": {
    pass: `At least one HTTP 429 among 50 rapid tools/call requests to the first readOnlyHint tool that declares no required arguments (tools/list fetched on demand), or among 50 rapid server/discover requests when no such tool exists. A burst that draws no 429 passes with a warning on either path; one where every response is 401/403 is skipped as unmeasurable -- with a hint to pass --auth (or check the credential) when every refusal reads as an auth refusal, and pointing at security-auth-required (Host/Origin validation or a gateway) when any 403 does not.`,
    fail: `More than 25 of the 50 responses are 5xx (whichever method was bursted), or none of the 50 requests got a response (server unreachable).`,
    gate: null,
  },
};

const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";
const MODERN_BASE = `https://modelcontextprotocol.io/specification/${MODERN}`;

// ── sanity: every catalog id has criteria and vice versa ──
const catalogIds = new Set(MODERN_TEST_DEFINITIONS.map((d) => d.id));
for (const id of Object.keys(C)) if (!catalogIds.has(id)) throw new Error(`criteria for unknown id ${id}`);
for (const id of catalogIds) if (!C[id]) throw new Error(`no criteria for ${id}`);
for (const [id, c] of Object.entries(C)) {
  for (const s of [c.pass, c.fail]) {
    if (!/^[\x20-\x7e]+$/.test(s)) throw new Error(`non-ASCII in ${id}`);
  }
}
for (const d of MODERN_TEST_DEFINITIONS) {
  for (const s of [d.name, d.description, d.recommendation]) {
    if (!/^[\x20-\x7e]+$/.test(s)) throw new Error(`non-ASCII in catalog prose of ${d.id}`);
  }
}

// ── rules.json ──
const rulesPath = join(ROOT, "mcp-compliance-rules.json");
const src = JSON.parse(readFileSync(rulesPath, "utf8")) as Record<string, unknown> & {
  categories: Array<{ id: string; name: string; description: string; scope: string }>;
  rules: Array<Record<string, unknown>>;
};

const CATEGORIES = [
  {
    id: "transport",
    name: "Transport Validation",
    description: "Streamable HTTP and stdio transport compliance at the wire level",
    scope: "transport-gated (http / stdio)",
  },
  {
    id: "lifecycle",
    name: "Lifecycle & Protocol",
    description:
      "Connection setup (initialize handshake or per-request _meta plus server/discover), capabilities, and protocol compliance",
    scope: "always runs",
  },
  {
    id: "tools",
    name: "Tool Operations",
    description: "Tool listing, calling, caching hints, and pagination",
    scope: "capability-gated (tools)",
  },
  {
    id: "resources",
    name: "Resource Operations",
    description: "Resource listing, reading, templates, caching hints, pagination, and subscriptions",
    scope: "capability-gated (resources)",
  },
  {
    id: "prompts",
    name: "Prompt Operations",
    description: "Prompt listing, retrieval, caching hints, and pagination",
    scope: "capability-gated (prompts)",
  },
  {
    id: "errors",
    name: "Error Handling",
    description: "JSON-RPC error responses and error codes",
    scope: "always runs (some rules capability-gated on tools)",
  },
  {
    id: "schema",
    name: "Schema Validation",
    description: "Structural validation of tool, resource, and prompt definitions and of every recorded server message",
    scope: "capability-gated for definition checks; post-hoc recording scans always run",
  },
  {
    id: "security",
    name: "Security Validation",
    description: "Authentication, input validation, tool integrity, and information disclosure tests",
    scope: "runs after all functional tests (input validation and tool integrity rules capability-gated on tools)",
  },
];

/** The 2025-11-25 rules pass through untouched (only the first generation renamed error-method-code). */
function legacyRule(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    name: r.id === "error-method-code" ? "Uses correct JSON-RPC error code for unknown method" : r.name,
    category: r.category,
    specVersion: LEGACY,
    severity: r.severity,
    defaultRequired: r.defaultRequired,
    capabilityGated: r.capabilityGated,
    specRef: r.specRef,
    description: r.description,
    passCriteria: r.passCriteria,
    failCriteria: r.failCriteria,
  };
  if (r.transports) out.transports = r.transports;
  return out;
}

function modernRule(d: TestDefinition): Record<string, unknown> {
  const c = C[d.id];
  const out: Record<string, unknown> = {
    id: d.id,
    name: d.name,
    category: d.category,
    specVersion: MODERN,
    severity: d.required ? "error" : "warning",
    defaultRequired: d.required,
    capabilityGated: c.gate,
    specRef: d.specRef,
    description: d.description,
    passCriteria: c.pass,
    failCriteria: c.fail,
  };
  if (d.transports) out.transports = d.transports;
  return out;
}

const legacyRules = src.rules.filter((r) => r.specVersion === undefined || r.specVersion === LEGACY);
if (legacyRules.length !== 88) throw new Error(`expected 88 legacy rules in rules.json, found ${legacyRules.length}`);

const out = {
  $schema: src.$schema,
  title: src.title,
  description:
    "Machine-readable catalog of compliance test rules for MCP servers. Rules are grouped by the MCP specification revision they apply to (specVersion); ids are only comparable within one revision.",
  specVersion: "3.0.0",
  specDate: "2026-09-18",
  mcpSpecCompatibility: [LEGACY, MODERN],
  categories: CATEGORIES,
  rules: [...legacyRules.map(legacyRule), ...MODERN_TEST_DEFINITIONS.map(modernRule)],
};
writeFileSync(rulesPath, `${JSON.stringify(out, null, 2)}\n`);
console.log("rules.json written:", out.rules.length, "rules");

// ── rubric section 3b ──
const CAT_LABEL: Record<string, string> = {
  transport: "Transport Validation",
  lifecycle: "Protocol Lifecycle",
  tools: "Tool Operations",
  resources: "Resource Operations",
  prompts: "Prompt Operations",
  errors: "Error Handling",
  schema: "Schema Validation",
  security: "Security Validation",
};
const CAT_ORDER = ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema", "security"];
const CAT_INTRO: Record<string, string> = {
  transport:
    'Transport tests for 2026-07-28 send a **conformant `server/discover`** (standard headers plus `_meta`) rather than `ping`, so the only defect in each probe is the one under test. There is no session and no initialization handshake: every request is independent, so nothing here is "pre-init" or "post-init". 15 rules are HTTP-only (`transports: ["http"]`), 4 are stdio-only, and `transport-no-server-requests` is a post-hoc scan of the recording that runs on both transports (the design counts it with the HTTP group, hence "16 HTTP + 4 stdio"). The standard-header rejection rules are **attributable**: a 400 is credited only when the conformant `server/discover` was served, so a server that rejects everything (a legacy-only server pinned to this catalog) fails them as "not evaluable" instead of passing, and so does a transport-level status (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter answering before the JSON-RPC layer). `transport-batch-reject` and `transport-content-type-reject` credit a rejecting status only when it is the server\'s own: a 429 is resent once, and a 401, a 403 that reads as an auth refusal (without `--auth` any Bearer challenge, with `--auth` one carrying an `error` parameter; a gateway\'s `-32001` body included), a 429 still a 429, or any other 403 that a conformant `server/discover` sent next to the probe could not get past either fails as not evaluable, while a 5xx without the batch\'s own `-32600` (any 5xx for `text/plain`) fails as the server failing on the request. Both also fail as not evaluable on any rejection -- a status >= 400, or a JSON-RPC error on a 2xx -- when the conformant setup `server/discover` was itself rejected or got no response, as the standard-header rules do (a `-32600` on a 5xx is then neither credited nor warned about). When that setup `server/discover` already drew the probe\'s 403, its answer is the twin and no further `server/discover` is sent. A probe that gets no answer, the resend after a 429 included, fails as "server unreachable". On stdio, `stdio-unicode` restarts a child that exits on its probe, or right after answering it, as the security checks do, and fails one that answers and then stops answering (named in a warning, not restarted).',
  lifecycle:
    "Lifecycle in 2026-07-28 is `server/discover` plus the per-request `_meta` envelope. The suite validates the discover result (versions, capabilities, caching hints, serverInfo), then sends deliberately incomplete envelopes (no `_meta`, no `protocolVersion`, no `clientCapabilities`, no `clientInfo`, an unsupported version) and checks the server rejects exactly the ones the spec says it must; like the header rules, a rejection is credited only when the conformant discover was served and is not a transport-level status. The late block -- `lifecycle-completions`, `lifecycle-progress-token`, the two claim-less probes (`lifecycle-meta-required`, `lifecycle-meta-protocol-version-required`) and `lifecycle-dual-era` -- runs after the feature and stdio tests and before the security tests: a dual-era stdio server that has not yet been pinned modern treats a claim-less message as a legacy opening (a `--only` run on stdio sends a pinning request first), and the security rate-limit burst would otherwise leave an intermediary answering these probes with 429. On stdio, `lifecycle-progress-token` restarts a child that exits on one of its calls (before answering it, or right after) before the next, as the security checks do, so the rules after it measure a live process. Over HTTP the setup `server/discover` is resent once after a 429, and every rule that reads it -- the discover-result rules, `lifecycle-jsonrpc`, the capability gates and the negative probes' not-evaluable reading -- judges the answer it settles on. `lifecycle-jsonrpc` and `lifecycle-subscriptions-listen` ask whose answer a rejection is, as the error rules do (see 3b.6), so a gateway's envelope or `-32001` is not read as the server's. Three rules are post-hoc scans of the recording (`lifecycle-log-level-gating`) or informational probes (`lifecycle-dual-era`, which on stdio goes to a fresh process and tells a single-instance server apart from one that exits on `initialize`; `lifecycle-removed-methods`).",
  tools:
    "Only present in the report when the discover result declares the `tools` capability; every rule is then required at runtime except `tools-list-deterministic-order` and `tools-pagination`. `tools/call` may now answer with an MRTR `input_required` result instead of content. The feature tests do not check `resultType: 'complete'` themselves; the post-hoc `schema-result-type` scan does, over every result.",
  resources:
    "Only present when the `resources` capability is declared. New in this revision: caching hints on every cacheable result, and `resources-not-found`, which fails the retired `-32002` code (any code other than `-32602` fails).",
  prompts: "Only present when the `prompts` capability is declared.",
  errors:
    'Error tests send conformant envelopes so the error under test comes from the server\'s own dispatch, not from `_meta` validation. `error-unknown-method` now expects HTTP 404 on the JSON-RPC error. Two rules are post-hoc scans of every JSON-RPC error recorded during the run; a body that is not a jsonrpc 2.0 error (an auth gate\'s `{"error":"invalid_token"}` on 401, a gateway\'s `{"error":{"code":400,...}}`) is not counted. The rules that credit any rejection (`error-unknown-method`, `error-invalid-jsonrpc`, `error-invalid-json`, `error-missing-params`, `error-capability-gated`, `error-invalid-cursor`) also ask whose answer it is, so a gateway\'s 401 with a `-32001` body that echoes the id does not pass them: a 401, a 403 that reads as an auth refusal (without `--auth` any Bearer challenge, with `--auth` one carrying an `error` parameter), a 429 still a 429 after one resend, or any other 403 that a conformant twin sent next to the probe (a `server/discover`; for `error-invalid-cursor` its list method without the cursor) could not get past either fails as not evaluable. A 5xx without the rule\'s own code (`-32601`, `-32600`, `-32700`, `-32602`, `-32601`, `-32602`) fails as the server failing on the probe rather than rejecting it, and the rule\'s own code on a 5xx is credited with a warning about the status. No probe is resent after a 429 while the setup `server/discover` was rejected: every rejection is then not evaluable whatever the resend would draw. The exact-code rules (`error-parse-code`, `error-invalid-request-code`) credit only the one right code, which no gate produces, and a 4xx without a JSON-RPC body only when it is the server\'s own, read the same way. `tools-call-unknown` is not read this way yet: a gateway\'s `-32001` on its `tools/call` still passes it.',
  schema:
    "Definition checks (`tools-schema`, `tools-annotations`, `tools-title-field`, `tools-output-schema`, `prompts-schema`, `resources-schema`) validate the list results -- cached by the feature tests, or fetched once on demand when those did not run (`--only schema`) -- and are capability-gated. When a list call failed they skip pointing at the `-list` rule if it is in the run, and fail with the recorded reason when it was filtered out, so `--only schema` cannot grade A over a broken list. The four post-hoc rules scan every server message the Recorder captured: `resultType` on every result (`complete` or `input_required`, or an extension value only when an `extensions` capability is advertised), `input_required` only on MRTR methods, well-formed `InputRequiredResult`s whose methods the client declared support for, and full validation against the vendored 2026-07-28 JSON schema.",
  security:
    "Same coverage as 2025-11-25 minus the two session-id rules (there are no sessions). Auth and transport-security probes use a conformant `server/discover` with modern headers so credentials are the only variable; `security-auth-required`, `security-www-authenticate` and `security-oauth-metadata` probe with or without `--auth`, and only `security-auth-malformed` and `security-token-in-uri` need a credential. A credential is not the only gate: the sibling auth probes skip as not evaluable on a bare 403 that `security-auth-required` could not attribute to authentication, and the two credential probes skip when the configured credential itself drew 401. The four injection rules share **one** target, chosen from the safest annotation tier that has a string argument -- `readOnlyHint: true`, then `destructiveHint: false`, then unannotated tools (destructive by the spec default), then `destructiveHint: true` -- with free-form arguments before enum/const/pattern ones, the other required arguments filled with schema-honouring placeholders, and `x-mcp-header` parameters mirrored into `Mcp-Param-*` headers so the request stays valid; passed-over and live-probed tools are named in warnings, and a run in which no payload reached the tool passes as inconclusive with a warning, flagged as a skip. On stdio a check whose own request kills the server -- an injection payload, the 1 MB argument of `security-oversized-input`, the unknown arguments of `security-extra-params` -- fails as died, and the server is restarted (a fresh `server/discover` plus one request that pins its era, with a warning naming the check) every time that happens, `--retries` included, so the checks after it measure a live process; `security-tool-rug-pull` then compares two lists from the new process. `security-rate-limiting` passes a quiet burst with a warning on either path and skips a burst refused 401/403 before it reached a handler. `security-origin-validation` skips a 401/403 when the same request without the Origin did not get past the gate and drew the same status or no answer. Tool-dependent rules fetch `tools/list` on demand, so `--only security` measures the server. All rules stay optional (severity `warning`); the leak scans and the rate-limit burst fail as 'server unreachable' when nothing answered.",
};

const lines: string[] = [];
lines.push("## 3b. Test Rules -- 2026-07-28");
lines.push("");
lines.push(
  "The 2026-07-28 catalog (`MODERN_TEST_DEFINITIONS` in `src/definitions/2026-07-28.ts`) has 103 rules in the same 8 categories. Spec references are relative to `https://modelcontextprotocol.io/specification/2026-07-28/`. Ids are only comparable within one catalog: an id shared with section 3 covers the same feature, but its wording, pass criteria and required flag may differ between the eras (`stdio-framing` and `error-invalid-jsonrpc` are optional here and required in section 3, `error-method-code` the reverse); a check whose verdict on the same server behaviour flipped carries a new id (for example `lifecycle-discover` replaces `lifecycle-init`, `transport-get-removed` replaces `transport-get`, `resources-not-found` is new because `-32002` is now a failure). `Default required` is the catalog default; rules marked capability-gated become required at runtime when the server declares the capability (see [section 1.2](#12-capability-driven-execution)).",
);
lines.push("");
lines.push(
  "Counts: transport 20 (16 HTTP + 4 stdio), lifecycle 22, tools 6, resources 8, prompts 4, errors 12, schema 10, security 21. Required by default: 24. Runs on HTTP: 99 (28 HTTP-only + 71 both); on stdio: 75 (4 stdio-only + 71 both).",
);
lines.push("");
lines.push("---");
lines.push("");
let n = 0;
for (const cat of CAT_ORDER) {
  n++;
  const defs = MODERN_TEST_DEFINITIONS.filter((d) => d.category === cat);
  lines.push(`### 3b.${n} ${cat} -- ${CAT_LABEL[cat]} (${defs.length} tests)`);
  lines.push("");
  lines.push(CAT_INTRO[cat]);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const d of defs) {
    const c = C[d.id];
    lines.push(`#### \`${d.id}\` -- ${d.name}`);
    lines.push("");
    lines.push(`- **Category:** ${d.category}`);
    lines.push(
      `- **Default required:** ${d.required ? "Yes" : "No"}${c.gate ? ` (required at runtime when \`${c.gate}\` is declared)` : ""}`,
    );
    if (d.transports) lines.push(`- **Transports:** ${d.transports.join(", ")}`);
    lines.push(`- **Spec reference:** [${d.specRef}](${MODERN_BASE}/${d.specRef})`);
    lines.push(`- **Description:** ${d.description}`);
    lines.push(`- **Pass criteria:** ${c.pass}`);
    lines.push(`- **Fail criteria:** ${c.fail}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
}
const section3b = `${lines.join("\n")}\n`;

// ── splice 3b into COMPLIANCE_RUBRIC.md (between "## 3b." and "## 4.") ──
const rubricPath = join(ROOT, "COMPLIANCE_RUBRIC.md");
const rubric = readFileSync(rubricPath, "utf8");
const start = rubric.indexOf("## 3b. Test Rules -- 2026-07-28");
const end = rubric.indexOf("## 4. Rule Catalog (Machine-Readable)");
if (start < 0 || end < 0 || end < start) throw new Error("rubric section 3b / 4 markers not found");
writeFileSync(rubricPath, `${rubric.slice(0, start)}${section3b}${rubric.slice(end)}`);
console.log("rubric section 3b spliced into", rubricPath);

// Biome's formatter is the last word on rules.json (it collapses short
// arrays); run it so the generated file matches what `npm run lint` expects.
const lint = spawnSync(process.execPath, [join(ROOT, "scripts", "lint.mjs"), "check", "--write", rulesPath], {
  stdio: "inherit",
});
if (lint.status !== 0) process.exit(lint.status ?? 1);
