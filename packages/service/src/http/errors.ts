import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
export interface UnexpectedHttpErrorEvent {
  kind: 'unhandled_exception' | 'unsanitized_response';
  requestId: string;
  method: string;
  path: string;
  status: number;
  detail: string;
}
export type UnexpectedHttpErrorHandler = (event: UnexpectedHttpErrorEvent) => void;
export function notifyUnexpectedHttpError(
  handler: UnexpectedHttpErrorHandler | undefined,
  event: UnexpectedHttpErrorEvent,
  log: { error: (message: string) => void },
): void {
  if (!handler) return;
  try {
    handler(event);
  } catch (err) {
    log.error(
      `[http] unexpected-error observer failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
}
export function opaqueServerErrors(
  log: { error: (message: string) => void },
  onUnexpectedHttpError?: UnexpectedHttpErrorHandler,
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status < 500) return;

    const prior = c.res;
    const raw = await prior
      .clone()
      .text()
      .catch(() => '');
    try {
      const parsed = JSON.parse(raw) as {
        error?: unknown;
        message?: unknown;
        requestId?: unknown;
      };
      if (parsed.error === 'internal_error' && typeof parsed.requestId === 'string') {
        // Keep the correlation id in both the opaque body and the conventional
        // response header so clients can retain it without parsing JSON.
        c.header('x-request-id', parsed.requestId);
        return;
      }
      // The remote model boundary deliberately uses 503 as a scheduling /
      // admission result. These two route-owned messages are user-facing
      // contracts, and their request id is already opaque; preserving them is
      // what keeps an expected busy swap or memory refusal from turning back
      // into the generic 500-style error this middleware normally enforces.
      const remoteAvailabilityPath =
        c.req.path === '/v1/remote/admit' || c.req.path === '/v1/remote/infer';
      const remoteAvailabilityCode =
        parsed.error === 'capacity_denied' || parsed.error === 'engine_busy';
      const remoteAvailabilityKeys = Object.keys(parsed as Record<string, unknown>);
      if (
        prior.status === 503 &&
        remoteAvailabilityPath &&
        remoteAvailabilityCode &&
        typeof parsed.message === 'string' &&
        parsed.message.length > 0 &&
        parsed.message.length <= 2_000 &&
        typeof parsed.requestId === 'string' &&
        remoteAvailabilityKeys.every((key) => ['error', 'message', 'requestId'].includes(key))
      ) {
        c.header('x-request-id', parsed.requestId);
        return;
      }
      // Broker outages, capacity denials, and media-engine readiness failures
      // are expected, actionable degraded states rather than route exceptions.
      // Preserve only their fixed codes; the route/provider logs the underlying
      // detail and never puts it in this body.
      if (
        (parsed.error === 'machine_engine_unavailable' ||
          parsed.error === 'capacity_denied' ||
          parsed.error === 'speech_to_text_not_ready' ||
          parsed.error === 'speech_to_text_failed') &&
        Object.keys(parsed as Record<string, unknown>).length === 1
      ) {
        return;
      }
    } catch {
      /* sanitize non-JSON and malformed JSON errors too */
    }

    const requestId = randomUUID();
    const detail = raw.slice(0, 2000);
    log.error(
      `[http] route returned unsanitized ${prior.status} id=${requestId} method=${c.req.method} path=${c.req.path}: ${detail}`,
    );
    notifyUnexpectedHttpError(
      onUnexpectedHttpError,
      {
        kind: 'unsanitized_response',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: prior.status,
        detail,
      },
      log,
    );
    const replacement = new Response(JSON.stringify({ error: 'internal_error', requestId }), {
      status: prior.status,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
    for (const [name, value] of prior.headers) {
      if (name.startsWith('access-control-') || name === 'vary' || name === 'retry-after') {
        replacement.headers.set(name, value);
      }
    }
    replacement.headers.set('x-request-id', requestId);
    c.res = replacement;
  };
}
