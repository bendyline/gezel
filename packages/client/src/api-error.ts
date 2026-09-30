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
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message} (${cause.message})`;
  }
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return `${error.message} (${String((cause as { code?: unknown }).code)})`;
  }
  return error.message;
}
