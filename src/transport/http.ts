import { request } from "undici";
import { createSSEDecoder, parseSSEMessages, parseSSEResponse } from "../sse.js";
import type {
  JsonRpcId,
  MessageListener,
  Transport,
  TransportNotifyResult,
  TransportResponse,
  TransportStream,
} from "./index.js";

export interface HttpTransport extends Transport {
  readonly kind: "http";
  readonly url: string;
  /**
   * Raw POST bypassing JSON-RPC framing. Used by HTTP-transport tests
   * that need to inspect wire-level behavior (status codes, rejected
   * content types, batch requests, etc.).
   */
  rawPost(
    body: string,
    extraHeaders: Record<string, string>,
    timeout: number,
    omitUserHeaders?: string[],
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
  rawRequest(
    method: "GET" | "POST" | "DELETE" | "OPTIONS",
    body: string | undefined,
    extraHeaders: Record<string, string>,
    timeout: number,
    omitUserHeaders?: string[],
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
}

export interface HttpTransportOptions {
  url: string;
  /** Extra headers merged into every request (e.g. Authorization). */
  headers?: Record<string, string>;
}

function combineSignals(timeout: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export function createHttpTransport(opts: HttpTransportOptions): HttpTransport {
  const { url } = opts;
  const userHeaders = { ...(opts.headers ?? {}) };
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  const listeners = new Set<MessageListener>();

  function emit(message: unknown) {
    for (const l of listeners) {
      try {
        l(message);
      } catch {
        // A listener must never break the transport.
      }
    }
  }

  function sessionHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...userHeaders };
    if (sessionId) h["mcp-session-id"] = sessionId;
    if (protocolVersion) h["mcp-protocol-version"] = protocolVersion;
    return h;
  }

  function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue;
      // undici returns repeated headers (Set-Cookie, WWW-Authenticate, etc.)
      // as string[]. Join them so downstream tests can still inspect the
      // value — silently dropping multi-value headers would hide exactly
      // the kind of misconfig (e.g. multiple Mcp-Session-Id) these tests
      // exist to catch. Set-Cookie is ambiguous under comma-join but we
      // don't currently assert on it; revisit if that changes.
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return out;
  }

  function buildHeaders(body: string | undefined, extraHeaders: Record<string, string>, omitUserHeaders?: string[]) {
    const base = sessionHeaders();
    // Strip any user-supplied headers the caller asked to omit (matched
    // case-insensitively). This is what lets the auth-stripping security
    // tests genuinely send a request without Authorization — otherwise
    // sessionHeaders() re-injects the configured user header and the
    // "stripped" request still carries auth. extraHeaders is applied
    // AFTER stripping so a malformed/replacement value can be supplied.
    if (omitUserHeaders && omitUserHeaders.length > 0) {
      const drop = new Set(omitUserHeaders.map((h) => h.toLowerCase()));
      for (const key of Object.keys(base)) {
        if (drop.has(key.toLowerCase())) delete base[key];
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      ...base,
      ...extraHeaders,
    };
    if (body !== undefined && !("Content-Type" in headers) && !("content-type" in headers)) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  async function doRawRequest(
    method: "GET" | "POST" | "DELETE" | "OPTIONS",
    body: string | undefined,
    extraHeaders: Record<string, string>,
    timeout: number,
    omitUserHeaders?: string[],
    signal?: AbortSignal,
  ) {
    const res = await request(url, {
      method,
      headers: buildHeaders(body, extraHeaders, omitUserHeaders),
      body,
      signal: combineSignals(timeout, signal),
    });
    const text = await res.body.text();
    return {
      statusCode: res.statusCode,
      body: text,
      headers: normalizeHeaders(res.headers as Record<string, string | string[] | undefined>),
    };
  }

  function parseBody(text: string, contentType: string): { body: unknown; messages: unknown[] } {
    if (contentType.includes("text/event-stream")) {
      const messages = parseSSEMessages(text);
      const sseParsed = parseSSEResponse(text);
      if (sseParsed) return { body: sseParsed, messages };
      try {
        const parsed = JSON.parse(text);
        return { body: parsed, messages: messages.length ? messages : [parsed] };
      } catch {
        return { body: { _raw: text }, messages };
      }
    }
    try {
      const parsed = JSON.parse(text);
      return { body: parsed, messages: [parsed] };
    } catch {
      return { body: { _raw: text }, messages: [] };
    }
  }

  const transport: HttpTransport = {
    kind: "http",
    url,
    async request(method, params, nextId, init): Promise<TransportResponse> {
      const id = nextId();
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      const raw = await doRawRequest("POST", body, init.headers ?? {}, init.timeout, init.omitUserHeaders, init.signal);
      const contentType = (raw.headers["content-type"] || "").toLowerCase();
      const parsed = parseBody(raw.body, contentType);
      for (const m of parsed.messages) emit(m);
      return {
        body: parsed.body,
        requestId: id,
        statusCode: raw.statusCode,
        headers: raw.headers,
        messages: parsed.messages,
      };
    },
    async notify(method, params, init): Promise<TransportNotifyResult> {
      const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      const raw = await doRawRequest("POST", body, init.headers ?? {}, init.timeout, init.omitUserHeaders, init.signal);
      return { statusCode: raw.statusCode, headers: raw.headers };
    },
    async stream(method, params, nextId, init): Promise<TransportStream> {
      const id: JsonRpcId = nextId();
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      const controller = new AbortController();
      const upstream = init.signal;
      if (upstream) {
        if (upstream.aborted) controller.abort(upstream.reason);
        else upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
      }
      // The timeout bounds the WHOLE stream, so a `subscriptions/listen`
      // that the server never closes still ends. Callers that need a
      // shorter observation window call close() themselves.
      const timer = setTimeout(
        () => controller.abort(new Error(`stream timed out after ${init.timeout}ms`)),
        init.timeout,
      );
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url, {
          method: "POST",
          headers: buildHeaders(body, init.headers ?? {}, init.omitUserHeaders),
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
      const headers = normalizeHeaders(res.headers as Record<string, string | string[] | undefined>);
      const contentType = (headers["content-type"] || "").toLowerCase();
      const isSSE = contentType.includes("text/event-stream");
      const decoder = createSSEDecoder();
      const textDecoder = new TextDecoder();

      async function* iterate(): AsyncGenerator<unknown> {
        try {
          if (!isSSE) {
            const text = await res.body.text();
            const parsed = parseBody(text, contentType);
            for (const m of parsed.messages) {
              emit(m);
              yield m;
            }
            return;
          }
          for await (const chunk of res.body) {
            const text = textDecoder.decode(chunk as Uint8Array, { stream: true });
            for (const data of decoder.push(text)) {
              const msg = jsonOrNull(data);
              if (msg === null) continue;
              emit(msg);
              yield msg;
            }
          }
          for (const data of decoder.flush()) {
            const msg = jsonOrNull(data);
            if (msg === null) continue;
            emit(msg);
            yield msg;
          }
        } catch (err) {
          // An abort (ours or the caller's) is the normal way a held-open
          // stream ends; anything else propagates.
          if (!controller.signal.aborted) throw err;
        } finally {
          clearTimeout(timer);
        }
      }

      return {
        requestId: id,
        statusCode: res.statusCode,
        headers,
        messages: iterate(),
        async close() {
          clearTimeout(timer);
          controller.abort(new Error("stream closed by client"));
          try {
            await res.body.dump({ limit: 0 });
          } catch {
            // already aborted
          }
        },
      };
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      /* HTTP has no persistent resources; each request opens a new connection pool entry. */
    },
    setSessionId(id) {
      sessionId = id;
    },
    setProtocolVersion(v) {
      protocolVersion = v;
    },
    getSessionId() {
      return sessionId;
    },
    getProtocolVersion() {
      return protocolVersion;
    },
    rawPost(body, extraHeaders, timeout, omitUserHeaders) {
      return doRawRequest("POST", body, extraHeaders, timeout, omitUserHeaders);
    },
    rawRequest(method, body, extraHeaders, timeout, omitUserHeaders) {
      return doRawRequest(method, body, extraHeaders, timeout, omitUserHeaders);
    },
  };

  return transport;
}

function jsonOrNull(data: string): unknown | null {
  if (!data.trim()) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
