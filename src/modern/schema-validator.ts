import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import vendoredSchema from "../schemas/mcp-2026-07-28.schema.json";

/**
 * Wire-level validation of server messages against the vendored
 * 2026-07-28 schema.json. The schema is authoritative for SHAPES (which
 * fields a DiscoverResult must carry, what a -32022 error's `data` looks
 * like) but it cannot tell WHICH shape a given message should satisfy:
 * its `*ResultResponse` unions accept any object with a `resultType`
 * (InputRequiredResult is open and requires only that one string field),
 * so validating a tools/call response against `CallToolResultResponse`
 * proves nothing. This module supplies the dispatch the schema lacks --
 * by request method, by `resultType`, by notification method, by error
 * code -- and validates against the CONCRETE definition each time.
 *
 * Everything here is pure: no transport, no harness. The post-hoc
 * schema-wire-valid test feeds it the recorder's messages; other tests
 * call `validateAgainst` for one-off shapes (Tool, ServerCapabilities).
 */

/** One schema violation, addressed relative to the whole message. */
export interface SchemaViolation {
  /** The `$defs` entry the value was checked against. */
  def: string;
  /** JSON pointer into the message ("" = the message itself). */
  path: string;
  message: string;
}

export interface ServerMessageContext {
  /** Method of the request this message answers, when known. */
  requestMethod?: string;
}

export interface WireValidator {
  /**
   * Validate one message the SERVER sent (a response, a notification, or
   * -- illegal in this era but still a JSON-RPC shape -- a request).
   * Returns [] when the message conforms.
   */
  validateServerMessage(message: unknown, ctx?: ServerMessageContext): SchemaViolation[];
  /** Validate any value against a named `$defs` entry (Tool, Implementation, ...). */
  validateAgainst(defName: string, value: unknown): SchemaViolation[];
  hasDef(defName: string): boolean;
  /** notification method -> def name, as derived from the schema. */
  readonly notificationDefs: ReadonlyMap<string, string>;
  /** error code -> def name for the codes whose def is a full JSON-RPC envelope. */
  readonly envelopeErrorDefs: ReadonlyMap<number, string>;
  /** error code -> def name for the codes whose def is a bare `error` object. */
  readonly bareErrorDefs: ReadonlyMap<number, string>;
}

/** Key the vendored schema is registered under; defs resolve as `${SCHEMA_KEY}#/$defs/<Name>`. */
export const SCHEMA_KEY = "mcp-2026-07-28";

/** Violations kept per message; the rest collapse into one sentinel entry. */
export const MAX_VIOLATIONS_PER_MESSAGE = 20;

/**
 * Concrete result def for each request method. `Result` (just
 * `resultType` + `_meta`) is the fallback for unknown methods, so a
 * method this table does not know still gets the envelope checked.
 */
export const RESULT_DEF_BY_METHOD: Readonly<Record<string, string>> = {
  "server/discover": "DiscoverResult",
  "tools/list": "ListToolsResult",
  "tools/call": "CallToolResult",
  "resources/list": "ListResourcesResult",
  "resources/templates/list": "ListResourceTemplatesResult",
  "resources/read": "ReadResourceResult",
  "prompts/list": "ListPromptsResult",
  "prompts/get": "GetPromptResult",
  "completion/complete": "CompleteResult",
  "subscriptions/listen": "SubscriptionsListenResult",
};

const RESULT_TYPE_INPUT_REQUIRED = "input_required";

type SchemaObject = Record<string, unknown>;
type SchemaDoc = { $schema: string; $defs: Record<string, SchemaObject> };

/**
 * Fix the one definition the upstream generator got wrong. schema.ts
 * declares `JSONValue = string | number | boolean | null | JSONObject |
 * JSONArray`, but schema.json emits the scalar branch as
 * `{type: ["string","integer","boolean"]}` -- no `null`, no non-integer
 * numbers. Everything typed `JSONObject` inherits the defect:
 * `ServerCapabilities.logging/completions/experimental/extensions` and
 * every `ClientCapabilities` sub-object. Measured (understand/schema-diff
 * section 9, pitfall 3): `{extensions: {"com.example/x": {flag: null}}}`
 * and `{logging: {level: 0.5}}` are rejected by the unpatched schema, so
 * a conformant server/discover answer would fail for a generator bug.
 *
 * The patch is applied to a deep copy at load time; the vendored file
 * stays byte-identical to upstream. It refuses to run if the definition
 * no longer has the shape it was written against, so a schema refresh
 * that fixes (or further changes) JSONValue fails loudly here instead of
 * leaving a stale patch in place.
 */
export function patchJsonValueDef(doc: SchemaDoc): void {
  const def = doc.$defs.JSONValue;
  const branches = def && Array.isArray(def.anyOf) ? (def.anyOf as SchemaObject[]) : undefined;
  const scalar = branches?.find((b) => Array.isArray(b.type) && (b.type as string[]).includes("integer"));
  if (!branches || !scalar || branches.length !== 3) {
    throw new Error(
      "mcp-2026-07-28.schema.json: $defs/JSONValue no longer matches the shape the JSONValue patch expects " +
        "(anyOf with a scalar branch typed [string, integer, boolean]); re-check the patch against the new schema",
    );
  }
  scalar.type = ["string", "number", "boolean", "null"];
}

/** Union aliases whose `method` const would shadow the concrete def they wrap. */
const UNION_ALIAS = /^(Client|Server)(Request|Notification|Result)$/;

function constOf(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * notification method -> def name. Derived from the schema rather than
 * hand-written so a refresh that adds a notification is picked up
 * without a code change; the test suite pins the expected entries.
 */
function deriveNotificationDefs(defs: Record<string, SchemaObject>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, def] of Object.entries(defs)) {
    if (UNION_ALIAS.test(name)) continue;
    const method = constOf(def, "properties", "method", "const");
    if (typeof method !== "string") continue;
    // A notification has the jsonrpc envelope but no `id` slot. Embedded
    // MRTR requests (CreateMessageRequest, ...) have neither; client
    // requests have both.
    const props = def.properties as Record<string, unknown>;
    if (!("jsonrpc" in props) || "id" in props) continue;
    out.set(method, name);
  }
  return out;
}

/** Bare `Error`-shaped defs (`code` const at the top level): ParseError, InvalidParamsError, ... */
function deriveBareErrorDefs(defs: Record<string, SchemaObject>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [name, def] of Object.entries(defs)) {
    const code = constOf(def, "properties", "code", "const");
    if (typeof code === "number") out.set(code, name);
  }
  return out;
}

/**
 * Full-envelope error defs (`error.allOf[...].properties.code.const`):
 * HeaderMismatchError, UnsupportedProtocolVersionError,
 * MissingRequiredClientCapabilityError.
 */
function deriveEnvelopeErrorDefs(defs: Record<string, SchemaObject>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [name, def] of Object.entries(defs)) {
    const allOf = constOf(def, "properties", "error", "allOf");
    if (!Array.isArray(allOf)) continue;
    for (const branch of allOf) {
      const code = constOf(branch, "properties", "code", "const");
      if (typeof code === "number") out.set(code, name);
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk a JSON pointer (ajv `instancePath`) down a value; undefined when it does not resolve. */
function valueAt(root: unknown, pointer: string): unknown {
  if (!pointer) return root;
  let cur: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

/** Short JSON rendering for "got X" suffixes; long values are cut so a blob does not swamp the line. */
function brief(value: unknown): string {
  if (value === undefined) return "undefined";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Turn an ajv error into one readable line. ajv's own text says "must
 * be equal to constant" without the constant and "must be integer"
 * without the offending value; both are what a server author needs to
 * see, so they are added here. `validated` is the value the validator
 * ran on -- `instancePath` is relative to it, not to the whole message.
 */
function describeError(err: ErrorObject, validated: unknown): string {
  const base = err.message ?? err.keyword;
  const params = err.params as Record<string, unknown>;
  switch (err.keyword) {
    case "const":
      return `${base} ${brief(params.allowedValue)} (got ${brief(valueAt(validated, err.instancePath))})`;
    case "enum":
      return `${base}: ${(params.allowedValues as unknown[]).map(brief).join(", ")} (got ${brief(valueAt(validated, err.instancePath))})`;
    case "type":
    case "minimum":
    case "maximum":
    case "maxItems":
    case "format":
      return `${base} (got ${brief(valueAt(validated, err.instancePath))})`;
    case "additionalProperties":
      return `${base} (${brief(params.additionalProperty)})`;
    case "anyOf":
      return "must match one of the allowed shapes (anyOf)";
    default:
      return base;
  }
}

export function createWireValidator(): WireValidator {
  // Deep copy: the JSON import is a shared module-level object and the
  // patch mutates; each validator instance must start from upstream.
  // JSON round-trip rather than structuredClone because the latter is
  // not in lib ES2022 and tsup's dts pass does not see @types/node's
  // web-globals, so it fails the build that `tsc --noEmit` accepts.
  const doc = JSON.parse(JSON.stringify(vendoredSchema)) as SchemaDoc;
  patchJsonValueDef(doc);

  // strict + allowUnionTypes is the minimum that compiles: RequestId and
  // ProgressToken are `type: ["string","integer"]`, which strict mode
  // rejects without the union opt-in (schema-diff section 9, "Compile").
  // allErrors so one pass reports every defect in a message rather than
  // the first, which matters for a post-hoc check that runs once.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(doc as unknown as Record<string, unknown>, SCHEMA_KEY);

  const notificationDefs = deriveNotificationDefs(doc.$defs);
  const bareErrorDefs = deriveBareErrorDefs(doc.$defs);
  const envelopeErrorDefs = deriveEnvelopeErrorDefs(doc.$defs);

  const compiled = new Map<string, ValidateFunction | null>();
  function validatorFor(def: string): ValidateFunction | null {
    let fn = compiled.get(def);
    if (fn === undefined) {
      // getSchema compiles on first use and caches inside ajv; the local
      // map only short-circuits the "unknown def" case.
      fn = ajv.getSchema(`${SCHEMA_KEY}#/$defs/${def}`) ?? null;
      compiled.set(def, fn);
    }
    return fn;
  }

  /**
   * Validate `value` against `def`. `prefix` is the JSON pointer from the
   * message to `value`, so reported paths address the whole message.
   */
  function check(def: string, value: unknown, prefix = ""): SchemaViolation[] {
    const fn = validatorFor(def);
    if (!fn) return [{ def, path: prefix, message: `unknown schema definition "${def}"` }];
    if (fn(value)) return [];
    return (fn.errors ?? []).map((err) => ({
      def,
      path: `${prefix}${err.instancePath}`,
      message: describeError(err, value),
    }));
  }

  /**
   * Dedupe on path + message (the concrete def and the generic envelope
   * both report a missing `resultType`; the first -- always the concrete
   * one, see the dispatch order below -- keeps the more useful label),
   * then cap.
   */
  function finalize(violations: SchemaViolation[]): SchemaViolation[] {
    const seen = new Set<string>();
    const unique = violations.filter((v) => {
      const key = `${v.path} ${v.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length <= MAX_VIOLATIONS_PER_MESSAGE) return unique;
    const kept = unique.slice(0, MAX_VIOLATIONS_PER_MESSAGE - 1);
    kept.push({
      def: "",
      path: "",
      message: `... and ${unique.length - kept.length} more violation(s) suppressed`,
    });
    return kept;
  }

  function validateResultMessage(msg: Record<string, unknown>, ctx: ServerMessageContext): SchemaViolation[] {
    const out: SchemaViolation[] = [];
    const result = msg.result;
    if (isObject(result)) {
      if (result.resultType === RESULT_TYPE_INPUT_REQUIRED) {
        out.push(...check("InputRequiredResult", result, "/result"));
        // "At least one of inputRequests or requestState MUST be present"
        // (schema.ts InputRequiredResult doc) is not encoded in schema.json:
        // `{resultType: "input_required"}` alone validates (pitfall 1).
        if (result.inputRequests === undefined && result.requestState === undefined) {
          out.push({
            def: "InputRequiredResult",
            path: "/result",
            message: "must have at least one of inputRequests or requestState",
          });
        }
      } else {
        const def = (ctx.requestMethod && RESULT_DEF_BY_METHOD[ctx.requestMethod]) || "Result";
        // The envelope below validates `result` as a Result already; a
        // pass against the same def would only duplicate its findings.
        if (def !== "Result") out.push(...check(def, result, "/result"));
      }
    }
    // The generic envelope covers jsonrpc, id and `result` as a bare
    // Result, so a missing resultType or a non-object result is caught
    // even when no concrete def applies.
    out.push(...check("JSONRPCResultResponse", msg));
    return out;
  }

  function validateErrorMessage(msg: Record<string, unknown>): SchemaViolation[] {
    const code = isObject(msg.error) ? msg.error.code : undefined;
    const envelopeDef = typeof code === "number" ? envelopeErrorDefs.get(code) : undefined;
    // The three MCP-specific defs are whole envelopes (jsonrpc + error +
    // optional id), so one check covers everything. The JSON-RPC ones
    // are bare `error` objects: check the error member against its
    // code-specific def, then the envelope generically.
    if (envelopeDef) return check(envelopeDef, msg);
    const out: SchemaViolation[] = [];
    const bareDef = typeof code === "number" ? bareErrorDefs.get(code) : undefined;
    if (bareDef && isObject(msg.error)) out.push(...check(bareDef, msg.error, "/error"));
    out.push(...check("JSONRPCErrorResponse", msg));
    return out;
  }

  return {
    notificationDefs,
    envelopeErrorDefs,
    bareErrorDefs,
    hasDef: (def) => validatorFor(def) !== null,
    validateAgainst: (def, value) => finalize(check(def, value)),
    validateServerMessage(message, ctx = {}) {
      if (!isObject(message)) {
        // Batches were removed in 2026-07-28, so an array is as wrong as a scalar.
        return [
          { def: "JSONRPCMessage", path: "", message: `server message must be a JSON object (got ${brief(message)})` },
        ];
      }
      const hasMethod = typeof message.method === "string";
      const hasResult = "result" in message;
      const hasError = "error" in message;
      if (hasResult && hasError) {
        return [{ def: "JSONRPCResponse", path: "", message: "response carries both result and error" }];
      }
      if (hasMethod) {
        if (message.id !== undefined) {
          // No ServerRequest def exists in this era; the shape is still
          // checked so a malformed one is reported precisely. Whether a
          // server may send requests at all is the no-server-requests
          // transport test's call, not the schema's.
          return finalize(check("JSONRPCRequest", message));
        }
        const def = notificationDefs.get(message.method as string) ?? "JSONRPCNotification";
        return finalize(check(def, message));
      }
      if (hasError) return finalize(validateErrorMessage(message));
      if (hasResult) return finalize(validateResultMessage(message, ctx));
      return [{ def: "JSONRPCMessage", path: "", message: "not a JSON-RPC message (no method, result, or error)" }];
    },
  };
}

let shared: WireValidator | undefined;

/**
 * Process-wide instance. Compiling the 155-def schema is a one-off cost
 * every test in a run would otherwise pay again; the validator holds no
 * per-run state so sharing it is safe.
 */
export function getWireValidator(): WireValidator {
  if (!shared) shared = createWireValidator();
  return shared;
}

/** `<def> at <path>: <message>` for test details and warnings. */
export function formatViolation(v: SchemaViolation): string {
  const where = v.path ? `${v.def} at ${v.path}` : v.def;
  return where ? `${where}: ${v.message}` : v.message;
}
