/** Shared client error envelope and transport diagnostics. Keep nested socket
 * codes visible so callers can distinguish connection loss from HTTP rejection
 * without logging credentials or request bodies. This module does not retry.
 */
export class GezelApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GezelApiError';
  }
}

/** `office_setup_failed`, `not_found`: a machine code, not a sentence for a person. */
const ERROR_CODE = /^[a-z0-9_.:-]+$/;

/**
 * The sentence to show a person for a failed call.
 *
 * A `GezelApiError`'s own message is the HTTP status line ("Gezel API error
 * 409 on PUT /api/office-setup"), which tells the user nothing. The daemon's
 * sentence travels in the response body, which the client keeps on
 * `details`: `message` where a route pairs a code with a sentence
 * (`{ error: 'office_setup_failed', message: '…' }`), else `error`. A bare
 * code is never shown. Transport failures keep their own message, which
 * already names the cause.
 */
export function apiErrorMessage(err: unknown): string {
  if (!(err instanceof GezelApiError)) return err instanceof Error ? err.message : String(err);
  const details = err.details;
  if (details && typeof details === 'object') {
    const { message, error } = details as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof error === 'string' && error.trim() && !ERROR_CODE.test(error)) return error;
  }
  if (err.status === 0) return err.message;
  return err.status >= 500
    ? 'Something went wrong inside Gezel. Try again; if it keeps happening, the service log has the details.'
    : 'Gezel could not do that.';
}

/** A transport failure message that keeps the underlying cause (ECONNREFUSED, …). */
export function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current && typeof current.code === 'string' ? current.code : '';
    const message = current instanceof Error ? current.message : '';
    const detail = code && !message.includes(code) ? `${code}: ${message}`.trim() : message || code;
    if (detail && !messages.includes(detail)) messages.push(detail);
    current = 'cause' in current ? current.cause : undefined;
  }
  return messages.length > 1
    ? `${messages[0]} (${messages.slice(1).join('; ')})`
    : (messages[0] ?? error.message);
}
