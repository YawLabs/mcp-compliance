/**
 * Transport abstraction. Lets the runner drive MCP servers over any
 * protocol (Streamable HTTP, stdio). Each transport maps the common
 * operations — send a JSON-RPC request, send a notification, hold a
 * response stream open — onto its own wire format.
 *
 * HTTP-specific fields (`statusCode`, `headers`) are optional on the
 * response so stdio can omit them. Tests that rely on those fields are
 * gated by transport kind at the runner level.
 */

export type TransportKind = "http" | "stdio";

export type JsonRpcId = number | string;

export interface TransportRequestInit {
  timeout: number;
  /** HTTP only: extra headers for this specific request */
  headers?: Record<string, string>;
  /**
   * HTTP only: names of user-supplied headers to OMIT from this single
   * request, matched case-insensitively. Without this, the transport
   * re-injects every configured user header (e.g. Authorization) on
   * every request via sessionHeaders(), so a test cannot actually send
   * an unauthenticated request just by leaving the header out of
   * `headers`. The auth-stripping security tests use this to genuinely
   * drop (or, combined with `headers`, replace) the Authorization
   * header. Ignored by stdio.
   */
  omitUserHeaders?: string[];
  /**
   * Cancels the in-flight request. HTTP aborts the connection; stdio
   * rejects the pending promise (the server may still answer later —
   * that reply is dropped). Combined with `timeout`, whichever fires
   * first wins.
   */
  signal?: AbortSignal;
  /**
   * Called with every JSON-RPC message the transport composes and writes
   * on the caller's behalf BEYOND the request body itself -- today only
   * the `notifications/cancelled` a stdio stream's close() sends -- so a
   * recorder can log it as a sent entry and a later reply to it can be
   * attributed to it. Called right before the write; never for the
   * request the caller built, which the caller already knows about.
   */
  onSent?: (message: { method: string; params?: unknown }) => void;
}

export interface TransportResponse {
  /** Parsed JSON-RPC body. May be `{ _raw: string }` when parse fails. */
  body: unknown;
  /** The JSON-RPC id sent on the request. */
  requestId: JsonRpcId;
  /** HTTP only. */
  statusCode?: number;
  /** HTTP only. */
  headers?: Record<string, string>;
  /**
   * HTTP only: every JSON message on the response, in wire order, when
   * the server answered with an SSE stream (notifications that preceded
   * the response included). For a plain JSON body this is `[body]`.
   */
  messages?: unknown[];
}

export interface TransportNotifyResult {
  /** HTTP only. */
  statusCode?: number;
  /** HTTP only. */
  headers?: Record<string, string>;
}

/**
 * A request whose response stream is held open and read incrementally.
 * Used for `subscriptions/listen` (2026-07-28) and for observing
 * notifications that arrive before a response. `messages` yields every
 * JSON message as it arrives — notifications and, eventually, the
 * response carrying `requestId` — and completes when the server ends
 * the stream or `close()` is called.
 */
export interface TransportStream {
  requestId: JsonRpcId;
  /** HTTP only: status of the response that opened the stream. */
  statusCode?: number;
  /** HTTP only. */
  headers?: Record<string, string>;
  messages: AsyncIterable<unknown>;
  /**
   * stdio only: set once the child process exits while the stream is
   * open (which also ends `messages`), so a caller can report "server
   * exited (code N)" instead of a timeout. Undefined while the child is
   * alive and on HTTP.
   */
  readonly exit?: { code: number | null; signal: string | null };
  /**
   * Tear the stream down. HTTP: abort the connection (the spec's
   * cancellation mechanism for a stateless request). stdio: send
   * `notifications/cancelled` for `requestId` unless the response
   * carrying that id already arrived or the child is gone (reported
   * through `TransportRequestInit.onSent`), and stop listening.
   */
  close(): Promise<void>;
}

/** Transport-level facts about a received message a listener may need. */
export interface MessageMeta {
  /** HTTP only: status of the response that carried the message. */
  statusCode?: number;
}

export type MessageListener = (message: unknown, meta: MessageMeta) => void;

export interface Transport {
  readonly kind: TransportKind;
  /**
   * Send a JSON-RPC request. The transport allocates the id via the
   * provided counter so tests can correlate.
   */
  request(
    method: string,
    params: unknown | undefined,
    nextId: () => JsonRpcId,
    init: TransportRequestInit,
  ): Promise<TransportResponse>;
  /** Send a JSON-RPC notification (no id, no response body). */
  notify(method: string, params: unknown | undefined, init: TransportRequestInit): Promise<TransportNotifyResult>;
  /** Send a request and keep its response stream open. See TransportStream. */
  stream(
    method: string,
    params: unknown | undefined,
    nextId: () => JsonRpcId,
    init: TransportRequestInit,
  ): Promise<TransportStream>;
  /**
   * Observe every JSON message the server sends, on any request or
   * stream, in arrival order. Returns an unsubscribe function. Feeds the
   * modern suite's recorder (post-hoc checks over everything received).
   */
  onMessage(listener: MessageListener): () => void;
  /** Release any underlying resources (HTTP: no-op; stdio: terminate child). */
  close(): Promise<void>;
  /** Session state shared across tests. */
  setSessionId(id: string | null): void;
  setProtocolVersion(version: string | null): void;
  getSessionId(): string | null;
  getProtocolVersion(): string | null;
}

export type { HttpTransport } from "./http.js";
export { createHttpTransport } from "./http.js";
