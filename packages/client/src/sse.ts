import {
  type ChatEvent,
  type ChatEventEnvelope,
  ChatEventEnvelopeSchema,
  ChatEventSchema,
  type CopilotLoginEvent,
  CopilotLoginEventSchema,
  type MlxRuntimeStatus,
  MlxRuntimeStatusSchema,
  type SystemBootstrapStatus,
  SystemBootstrapStatusSchema,
  type TerminalEventEnvelope,
  TerminalEventEnvelopeSchema,
} from '@bendyline/gezel/schemas';
import type { ZodType } from 'zod';

const FINITE_OPERATION_STALL_TIMEOUT_MS = 2 * 60_000;

export interface SseStreamOptions {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /**
   * HTTP method. Defaults to `GET`. Set to `POST` when the endpoint
   * kicks off a server-side side effect (e.g. spawning a subprocess)
   * and the SSE connection reports its progress. Subscriptions that
   * only read server-owned state stay `GET`.
   */
  method?: 'GET' | 'POST';
  body?: RequestInit['body'];
  /**
   * Max wall-clock between any bytes (data OR pings) from the server
   * before the stream is treated as dead and {@link SseStreamStaleError}
   * is thrown. The chat-events route sends a ping every 1s, so a 10s
   * cap catches socket-level death (silent TCP drop, intermediary
   * buffering, daemon restart) without false-positive on healthy
   * streams. Set to 0 to disable (used by short-lived one-shot
   * streams that aren't worth heartbeating).
   */
  keepaliveTimeoutMs?: number;
}

/**
 * Thrown when the SSE reader doesn't see any bytes for
 * `keepaliveTimeoutMs`. Distinct from `AbortError` (caller-driven
 * teardown) and from generic network errors so consumers can decide
 * to reconnect specifically on stale-stream rather than on every
 * failure.
 */
export class SseStreamStaleError extends Error {
  constructor(timeoutMs: number) {
    super(`SSE stream stale: no bytes from server in ${timeoutMs}ms`);
    this.name = 'SseStreamStaleError';
  }
}

export class SsePrematureEofError extends Error {
  constructor(label = 'SSE operation') {
    super(`${label} ended before a terminal event was received`);
    this.name = 'SsePrematureEofError';
  }
}

export class SsePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsePayloadError';
  }
}

export class SseResponseError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
  ) {
    super(`SSE stream failed: ${status} ${statusText}`.trim());
    this.name = 'SseResponseError';
  }
}

interface SseParsePolicy {
  strictPayloads?: boolean;
  requireTerminal?: boolean;
  label?: string;
}

/**
 * Generic SSE reader. Yields parsed events from an `/events` endpoint and
 * stops when (a) the stream closes, (b) the caller aborts, or (c) the
 * `isTerminal` predicate returns true. Pass `isTerminal: undefined` to
 * read forever — used by the project / global chat streams which don't
 * have a natural end.
 */
async function* sseStream<T>(
  opts: SseStreamOptions,
  schema: ZodType<T>,
  isTerminal?: (event: T) => boolean,
  policy: SseParsePolicy = {},
): AsyncGenerator<T> {
  const fetchImpl = (opts.fetch ?? fetch).bind(globalThis);
  const res = await fetchImpl(opts.url, {
    method: opts.method ?? 'GET',
    headers: { Accept: 'text/event-stream', ...opts.headers },
    signal: opts.signal,
    body: opts.body,
  });
  if (!res.ok || !res.body) {
    throw new SseResponseError(res.ok ? 0 : res.status, res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const keepaliveTimeoutMs = opts.keepaliveTimeoutMs ?? 0;
  let sawTerminal = false;

  const parseFrame = (rawEvent: string): T | null => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data.trim() === '') return null;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      if (policy.strictPayloads) throw new SsePayloadError('SSE event contained invalid JSON');
      console.warn('[sse] skipping non-JSON payload:', data.slice(0, 200));
      return null;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      const eventType =
        json && typeof json === 'object' && 'type' in json
          ? String((json as { type: unknown }).type)
          : '<no type>';
      if (policy.strictPayloads) {
        throw new SsePayloadError(
          `SSE event ${eventType} failed schema validation: ${result.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      console.error(
        `[sse] DROPPED event (type=${eventType}) — failed schema validation. This usually means a schema/version mismatch between packages; rebuild all of them. Issues:`,
        result.error.issues,
      );
      return null;
    }
    return result.data;
  };

  try {
    while (true) {
      // Race the read against a keepalive deadline so a silently-dead
      // socket (server crashed mid-stream, intermediary buffered the
      // close, kernel never delivered FIN) doesn't leave the consumer
      // hanging on `reader.read()` forever. Server pings ≥ 1Hz on
      // long-lived streams, so a 10s default cap fires only on real
      // breakage. The throw-on-timeout puts the consumer in control
      // — they can reconnect or surface the failure as they see fit.
      const { value, done } = await readWithTimeout(reader, keepaliveTimeoutMs);
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim() !== '') {
          const event = parseFrame(buffer);
          if (event) {
            yield event;
            if (isTerminal?.(event)) sawTerminal = true;
          }
        }
        if (policy.requireTerminal && !sawTerminal) {
          throw new SsePrematureEofError(policy.label);
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const rawEvent = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = parseFrame(rawEvent);
        if (event) {
          yield event;
          if (isTerminal?.(event)) {
            sawTerminal = true;
            return;
          }
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (timeoutMs <= 0) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SseStreamStaleError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ConsumeSseJsonOptions<T> extends SseStreamOptions {
  schema: ZodType<T>;
  onEvent: (event: T) => void;
  isTerminal: (event: T) => boolean;
  label?: string;
}

/** Strict consumer for finite, side-effecting SSE operations. */
export async function consumeSseJson<T>(opts: ConsumeSseJsonOptions<T>): Promise<void> {
  const { schema, onEvent, isTerminal, label, ...streamOptions } = opts;
  for await (const event of sseStream(
    { keepaliveTimeoutMs: FINITE_OPERATION_STALL_TIMEOUT_MS, ...streamOptions },
    schema,
    isTerminal,
    {
      strictPayloads: true,
      requireTerminal: true,
      label,
    },
  )) {
    onEvent(event);
  }
}

export function streamChatEvents(opts: SseStreamOptions): AsyncGenerator<ChatEvent> {
  return sseStream<ChatEvent>(opts, ChatEventSchema, (e) => e.type === 'done', {
    requireTerminal: true,
    label: 'Chat stream',
  });
}

/**
 * Project-scoped envelope stream. Lives forever (no terminator) — the
 * caller aborts via `signal` when the surface unmounts. Each envelope
 * carries `sessionId`, `gezelId`, `projectId`, and the underlying
 * `ChatEvent` so listeners can disambiguate concurrent streams.
 *
 * Defaults `keepaliveTimeoutMs: 10_000` — the chat-events route pings
 * every second, so 10s of total silence (data + pings) means the
 * connection is genuinely dead. Caller can override.
 */
export function streamProjectChatEvents(opts: SseStreamOptions): AsyncGenerator<ChatEventEnvelope> {
  return sseStream<ChatEventEnvelope>(
    { keepaliveTimeoutMs: 10_000, ...opts },
    ChatEventEnvelopeSchema,
  );
}

/** Global envelope stream — every session anywhere. Used by the Meester. */
export function streamAllChatEvents(opts: SseStreamOptions): AsyncGenerator<ChatEventEnvelope> {
  return sseStream<ChatEventEnvelope>(
    { keepaliveTimeoutMs: 10_000, ...opts },
    ChatEventEnvelopeSchema,
  );
}

/**
 * Per-project terminal events stream. Lives forever; aborts via `signal`.
 * Each envelope is `{ projectId, threadId, workingDir, message }` —
 * the UI splices `message` into the matching thread's timeline rows.
 * Same keepalive defaults as the chat envelope streams.
 */
export function streamTerminalEvents(
  opts: SseStreamOptions,
): AsyncGenerator<TerminalEventEnvelope> {
  return sseStream<TerminalEventEnvelope>(
    { keepaliveTimeoutMs: 10_000, ...opts },
    TerminalEventEnvelopeSchema,
  );
}

/**
 * Stream the system-toolset bootstrap status (Playwright install +
 * Chromium download progress). Lives forever; caller aborts via `signal`.
 */
export function streamSystemToolsetStatus(
  opts: SseStreamOptions,
): AsyncGenerator<SystemBootstrapStatus> {
  return sseStream<SystemBootstrapStatus>(opts, SystemBootstrapStatusSchema);
}

/**
 * Stream the MLX Python venv lifecycle (idle → provisioning → ready /
 * error). Lives forever; caller aborts via `signal`.
 */
export function streamMlxRuntimeStatus(opts: SseStreamOptions): AsyncGenerator<MlxRuntimeStatus> {
  return sseStream<MlxRuntimeStatus>(opts, MlxRuntimeStatusSchema);
}

/**
 * Stream the in-app Copilot login flow. POSTs to
 * `/api/system/copilot-login` (the spawn is a side effect), and
 * yields stdout/stderr lines, a final `exit` event, or an `error`
 * if spawning failed. Terminates on `exit` / `error` so `for await`
 * loops drain naturally.
 */
export function streamCopilotLogin(opts: SseStreamOptions): AsyncGenerator<CopilotLoginEvent> {
  return sseStream<CopilotLoginEvent>(
    { method: 'POST', ...opts },
    CopilotLoginEventSchema,
    (e) => e.kind === 'exit' || e.kind === 'error',
    { requireTerminal: true, label: 'Copilot login stream' },
  );
}
