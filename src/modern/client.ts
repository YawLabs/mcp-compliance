import type { Recorder } from "../recorder.js";
import { parseSSEMessages } from "../sse.js";
import type { HttpTransport } from "../transport/http.js";
import type { JsonRpcId, Transport, TransportStream } from "../transport/index.js";
import { HEADER_PROTOCOL_VERSION, standardHeadersFor } from "./headers.js";
import { buildMeta, type ClientIdentity, withMeta } from "./meta.js";

/**
 * The modern-era (2026-07-28) request builder. Wraps a Transport and
 * adds, per request: the `_meta` envelope (protocol version, client
 * capabilities, client info) and — on HTTP — the standard request headers
 * (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`).
 *
 * Everything the envelope adds can be overridden or removed per call so
 * negative tests (missing `_meta`, mismatched header, unsupported
 * version) send exactly the bytes they mean to. Every request and every
 * message received is logged to the Recorder for the post-hoc checks.
 */

export interface ModernClientOptions {
  transport: Transport;
  recorder: Recorder;
  nextId: () => JsonRpcId;
  /** Default per-request timeout in ms. */
  timeout: number;
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo: ClientIdentity;
  /** Default abort signal for every request (RunOptions.signal). */
  signal?: AbortSignal;
}

export interface RpcOptions {
  /**
   * `_meta` handling. Default: the conformant envelope, with any
   * `params._meta` keys the caller set taking precedence. An object is
   * merged over the defaults (a key set to `undefined` is DELETED, so a
   * test can drop e.g. clientCapabilities). `false` sends params exactly
   * as given — no `_meta` injection at all.
   */
  meta?: false | Record<string, unknown>;
  /**
   * HTTP header overrides, matched case-insensitively against the
   * generated standard headers. `null` removes a header. Ignored on stdio.
   */
  headers?: Record<string, string | null>;
  /** HTTP: user headers (e.g. Authorization) to drop for this request. */
  omitUserHeaders?: string[];
  timeout?: number;
  /** Force a specific JSON-RPC id (string-id test). */
  id?: JsonRpcId;
  /** inputSchema of the tool being called, for `Mcp-Param-*` mirroring. */
  toolInputSchema?: unknown;
  signal?: AbortSignal;
  /**
   * Protocol version for THIS request, applied to both the header and
   * `_meta` (version-negotiation tests). Use `headers`/`meta` to move only
   * one of the two (header-mismatch tests).
   */
  protocolVersion?: string;
}

export interface RpcResponse {
  body: any;
  requestId: JsonRpcId;
  /** 200 on stdio. */
  statusCode: number;
  headers: Record<string, string>;
  /** Every message on the response (SSE frames incl. notifications). */
  messages: unknown[];
}

export interface RawOptions {
  /** Hints used to derive the standard headers for a raw body. */
  method?: string;
  params?: unknown;
  headers?: Record<string, string | null>;
  omitUserHeaders?: string[];
  timeout?: number;
  protocolVersion?: string;
  /** Overrides the client's default signal (RunOptions.signal) for this probe. */
  signal?: AbortSignal;
}

export interface ModernClient {
  readonly kind: Transport["kind"];
  readonly transport: Transport;
  readonly protocolVersion: string;
  readonly clientCapabilities: Record<string, unknown>;
  readonly clientInfo: ClientIdentity;
  rpc(method: string, params?: unknown, opts?: RpcOptions): Promise<RpcResponse>;
  notify(
    method: string,
    params?: unknown,
    opts?: RpcOptions,
  ): Promise<{ statusCode: number; headers: Record<string, string> }>;
  stream(method: string, params?: unknown, opts?: RpcOptions): Promise<TransportStream>;
  /**
   * HTTP only: POST an arbitrary body. Standard headers are derived from
   * the `method`/`params` hints when given, then `headers` overrides
   * apply. Throws on stdio — callers gate with `kind`.
   */
  raw(body: string, opts?: RawOptions): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
  /** Build the conformant `_meta` for the client's defaults. */
  defaultMeta(): Record<string, unknown>;
  /** Build the conformant headers for a request (HTTP). */
  headersFor(method: string, params: unknown, opts?: RpcOptions): Record<string, string>;
  /** Finalize params: inject `_meta` per `opts.meta`. */
  paramsFor(params: unknown, opts?: RpcOptions): unknown;
}

function applyHeaderOverrides(base: Record<string, string>, overrides?: Record<string, string | null>) {
  if (!overrides) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === lower) delete out[existing];
    }
    if (value !== null) out[key] = value;
  }
  return out;
}

export function createModernClient(options: ModernClientOptions): ModernClient {
  const { transport, recorder } = options;

  function defaultMeta(protocolVersion = options.protocolVersion) {
    return buildMeta({
      protocolVersion,
      clientCapabilities: options.clientCapabilities,
      clientInfo: options.clientInfo,
    });
  }

  function paramsFor(params: unknown, opts: RpcOptions = {}): unknown {
    if (opts.meta === false) return params;
    const meta = defaultMeta(opts.protocolVersion);
    if (opts.meta) {
      for (const [k, v] of Object.entries(opts.meta)) {
        if (v === undefined) delete meta[k];
        else meta[k] = v;
      }
    }
    return withMeta(params, meta);
  }

  function headersFor(method: string, params: unknown, opts: RpcOptions = {}): Record<string, string> {
    const std = standardHeadersFor({
      method,
      params,
      protocolVersion: opts.protocolVersion ?? options.protocolVersion,
      toolInputSchema: opts.toolInputSchema,
    });
    return applyHeaderOverrides(std, opts.headers);
  }

  function metaOfParams(params: unknown): Record<string, unknown> | undefined {
    const m = (params as { _meta?: unknown } | undefined)?._meta;
    return m && typeof m === "object" ? (m as Record<string, unknown>) : undefined;
  }

  function http(): HttpTransport {
    if (transport.kind !== "http") throw new Error("raw requests are HTTP-only");
    return transport as HttpTransport;
  }

  const client: ModernClient = {
    kind: transport.kind,
    transport,
    protocolVersion: options.protocolVersion,
    clientCapabilities: options.clientCapabilities,
    clientInfo: options.clientInfo,
    defaultMeta: () => defaultMeta(),
    headersFor,
    paramsFor,
    async rpc(method, params, opts = {}) {
      const finalParams = paramsFor(params, opts);
      const headers = transport.kind === "http" ? headersFor(method, finalParams, opts) : undefined;
      let issued: JsonRpcId | undefined;
      const nextId = () => {
        issued = opts.id ?? options.nextId();
        recorder.recordSent({ id: issued, method, params: finalParams, meta: metaOfParams(finalParams) });
        return issued;
      };
      const res = await transport.request(method, finalParams, nextId, {
        timeout: opts.timeout ?? options.timeout,
        headers,
        omitUserHeaders: opts.omitUserHeaders,
        signal: opts.signal ?? options.signal,
      });
      return {
        body: res.body as any,
        requestId: res.requestId,
        statusCode: res.statusCode ?? 200,
        headers: res.headers ?? {},
        messages: res.messages ?? [res.body],
      };
    },
    async notify(method, params, opts = {}) {
      // Notification `_meta` is optional in the schema; only inject what
      // the caller asked for.
      const finalParams = opts.meta ? withMeta(params, opts.meta) : params;
      const headers = transport.kind === "http" ? headersFor(method, finalParams, opts) : undefined;
      recorder.recordSent({ id: undefined, method, params: finalParams, meta: metaOfParams(finalParams) });
      const res = await transport.notify(method, finalParams, {
        timeout: opts.timeout ?? options.timeout,
        headers,
        omitUserHeaders: opts.omitUserHeaders,
        signal: opts.signal ?? options.signal,
      });
      return { statusCode: res.statusCode ?? 202, headers: res.headers ?? {} };
    },
    async stream(method, params, opts = {}) {
      const finalParams = paramsFor(params, opts);
      const headers = transport.kind === "http" ? headersFor(method, finalParams, opts) : undefined;
      const nextId = () => {
        const id = opts.id ?? options.nextId();
        recorder.recordSent({ id, method, params: finalParams, meta: metaOfParams(finalParams) });
        return id;
      };
      return transport.stream(method, finalParams, nextId, {
        timeout: opts.timeout ?? options.timeout,
        headers,
        omitUserHeaders: opts.omitUserHeaders,
        signal: opts.signal ?? options.signal,
        // The stdio transport's close() writes notifications/cancelled
        // itself; log it so a reply to it is attributed to it, not to
        // the stream's request.
        onSent: (m) =>
          recorder.recordSent({ id: undefined, method: m.method, params: m.params, meta: metaOfParams(m.params) }),
      });
    },
    async raw(body, opts = {}) {
      const t = http();
      const base = opts.method
        ? standardHeadersFor({
            method: opts.method,
            params: opts.params,
            protocolVersion: opts.protocolVersion ?? options.protocolVersion,
          })
        : { [HEADER_PROTOCOL_VERSION]: opts.protocolVersion ?? options.protocolVersion };
      const headers = applyHeaderOverrides(base, opts.headers);
      recorder.recordSent({ id: undefined, method: opts.method ?? "", params: undefined, meta: undefined, raw: body });
      const res = await t.rawPost(
        body,
        headers,
        opts.timeout ?? options.timeout,
        opts.omitUserHeaders,
        opts.signal ?? options.signal,
      );
      // Raw responses bypass the transport's parser, so record them here.
      recordRawBody(recorder, res.body, res.headers["content-type"] || "", res.statusCode);
      return res;
    },
  };

  return client;
}

function recordRawBody(recorder: Recorder, text: string, contentType: string, statusCode: number) {
  if (!text) return;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    // The transport's own SSE parser: an event's `data:` lines join into
    // one payload, so a JSON message a server split across several lines
    // (pretty-printed, one line per `data:`) is recorded, not dropped.
    for (const message of parseSSEMessages(text)) recorder.recordReceived(message, { statusCode });
    return;
  }
  try {
    recorder.recordReceived(JSON.parse(text), { statusCode });
  } catch {}
}

/** JSON-RPC helpers over an RpcResponse body. */
export function errorOf(body: unknown): { code: number; message: string; data?: unknown } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const e = (body as { error?: unknown }).error;
  if (!e || typeof e !== "object") return undefined;
  const code = (e as { code?: unknown }).code;
  const message = (e as { message?: unknown }).message;
  return {
    code: typeof code === "number" ? code : Number.NaN,
    message: typeof message === "string" ? message : "",
    data: (e as { data?: unknown }).data,
  };
}

export function resultOf(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const r = (body as { result?: unknown }).result;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
}

/**
 * Short human summary of a response for test details. Transport-neutral:
 * it never names an HTTP status, because on stdio `statusCode` is the
 * synthetic 200 and on HTTP every caller appends the status itself.
 */
export function describeResponse(res: RpcResponse): string {
  const err = errorOf(res.body);
  if (err) return `JSON-RPC error ${err.code}${err.message ? ` (${err.message})` : ""}`;
  if (resultOf(res.body)) return "result";
  return "non-JSON-RPC body";
}
