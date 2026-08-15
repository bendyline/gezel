import { GezelApiError } from '@bendyline/gezel-client';

/**
 * The message on a `GezelApiError` is only the HTTP status line
 * ("Gezel API error 409 on POST /api/projects/x/tasks"), which tells the
 * user nothing. The daemon's own sentence — the one naming what to fix —
 * travels in the response body, which the client preserves on `details`
 * as `{ error: string }`.
 *
 * Falls through to the raw message for transport failures and anything
 * that isn't a wrapped API error.
 */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof GezelApiError) {
    const details = err.details;
    if (details && typeof details === 'object' && 'error' in details) {
      const inner = (details as { error?: unknown }).error;
      if (typeof inner === 'string' && inner.length > 0 && inner !== 'internal_error') {
        return inner;
      }
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
