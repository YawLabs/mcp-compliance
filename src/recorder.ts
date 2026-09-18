import type { JsonRpcId } from "./transport/index.js";

/**
 * Records every JSON-RPC message the server sends during a run, plus the
 * requests the suite sent, so post-hoc checks can assert wire-level
 * properties over the whole conversation ("every result carries
 * resultType", "no server->client requests on any stream", "no
 * notifications/message when no request asked for logging") without each
 * test re-implementing the scan.
 *
 * Messages arrive from the transport's onMessage hook (responses, SSE
 * frames, stdio lines); requests are logged by the modern client. The
 * two are correlated by id: `requestFor(response)` returns the request
 * that produced a response, when known.
 */

export interface SentRequest {
  id: JsonRpcId | undefined; // undefined for notifications
  method: string;
  params: unknown;
  /** `_meta` keys as sent, for "did this request opt into X" checks. */
  meta: Record<string, unknown> | undefined;
  /** Raw (non-JSON-RPC) payloads, e.g. malformed-body probes: `raw` set, method "" */
  raw?: string;
  seq: number;
}

export interface ReceivedMessage {
  message: unknown;
  seq: number;
  /** The request whose id this message echoes, if any. */
  request: SentRequest | undefined;
  /**
   * HTTP status of the response that carried the message (undefined on
   * stdio). Lets post-hoc checks tell a transport-level rejection body
   * (401/403/413/415/429 from an auth gate or proxy, which need not be
   * JSON-RPC at all) from a JSON-RPC reply the server chose to send.
   */
  statusCode?: number;
}

export interface Recorder {
  readonly sent: SentRequest[];
  readonly received: ReceivedMessage[];
  recordSent(req: Omit<SentRequest, "seq">): SentRequest;
  recordReceived(message: unknown, meta?: { statusCode?: number }): ReceivedMessage;
  /** Received messages that are JSON-RPC results (have `result`). */
  results(): ReceivedMessage[];
  /** Received messages that are JSON-RPC errors (have `error`). */
  errors(): ReceivedMessage[];
  /** Received messages that are notifications (have `method`, no `id`). */
  notifications(): ReceivedMessage[];
  /** Received messages that are requests FROM the server (have `method` and `id`). */
  serverRequests(): ReceivedMessage[];
  /** Number of messages received, for "was anything observed" gates. */
  readonly size: number;
}

function idKey(id: unknown): string | undefined {
  if (typeof id === "number") return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return undefined;
}

export function createRecorder(): Recorder {
  const sent: SentRequest[] = [];
  const received: ReceivedMessage[] = [];
  const byId = new Map<string, SentRequest>();
  let seq = 0;

  function isObj(m: unknown): m is Record<string, unknown> {
    return !!m && typeof m === "object" && !Array.isArray(m);
  }

  return {
    sent,
    received,
    get size() {
      return received.length;
    },
    recordSent(req) {
      const entry: SentRequest = { ...req, seq: seq++ };
      sent.push(entry);
      const key = idKey(req.id);
      if (key) byId.set(key, entry);
      return entry;
    },
    recordReceived(message, meta) {
      const key = isObj(message) ? idKey(message.id) : undefined;
      const entry: ReceivedMessage = {
        message,
        seq: seq++,
        request: key ? byId.get(key) : undefined,
        statusCode: meta?.statusCode,
      };
      received.push(entry);
      return entry;
    },
    results() {
      return received.filter((r) => isObj(r.message) && "result" in r.message);
    },
    errors() {
      return received.filter((r) => isObj(r.message) && "error" in r.message);
    },
    notifications() {
      return received.filter(
        (r) => isObj(r.message) && typeof r.message.method === "string" && r.message.id === undefined,
      );
    },
    serverRequests() {
      return received.filter(
        (r) => isObj(r.message) && typeof r.message.method === "string" && r.message.id !== undefined,
      );
    },
  };
}
