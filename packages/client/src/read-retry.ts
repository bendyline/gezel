/**
 * Bounded recovery for buffered, read-only API responses. The same caller
 * signal covers every attempt and backoff; no fresh deadline is introduced.
 * Callers must consume the complete response inside the operation so a dropped
 * body is recoverable. Streaming and mutating requests never use this helper.
 * Exhaustion is explicit so outer workflow/CLI observers do not multiply it.
 */
import { GezelApiError, describeTransportError } from './api-error.js';

const READ_RETRY_DELAYS = [250, 750, 1500];
const TRANSIENT_CONNECTION =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT)|NGHTTP2_ENHANCE_YOUR_CALM|Connect Timeout Error|socket hang up|other side closed/;

function transientReadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // The root and Node bundle entries have separate error constructors.
  if (error.name === 'GezelApiError') {
    const api = error as Error & {
      status?: number;
      details?: {
        kind?: string;
        cause?: unknown;
        causeName?: string;
        readRetryExhausted?: boolean;
      };
    };
    return (
      api.status === 0 &&
      api.details?.kind === 'transport' &&
      api.details.readRetryExhausted !== true &&
      !['SyntaxError', 'AbortError', 'TimeoutError'].includes(api.details.causeName ?? '') &&
      typeof api.details.cause === 'string' &&
      TRANSIENT_CONNECTION.test(api.details.cause)
    );
  }
  // Malformed JSON is not a transport failure, even if its text names a code.
  if (error instanceof SyntaxError || error.name === 'AbortError' || error.name === 'TimeoutError')
    return false;
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    const code = (cause as Error & { code?: string }).code;
    if (TRANSIENT_CONNECTION.test(`${code ?? ''} ${cause.message}`)) return true;
    cause = cause.cause;
  }
  return false;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function withReadTransportRetry<T>(
  read: () => Promise<T>,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  for (let retries = 0; ; retries++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal?.throwIfAborted();
      if (!transientReadFailure(error)) throw error;
      if (retries >= READ_RETRY_DELAYS.length) {
        const message = describeTransportError(error);
        const api = error as Error & { details?: { cause?: string } };
        const cause = api.details?.cause ?? message;
        throw new GezelApiError(`Gezel API transport unavailable on GET ${path}: ${cause}`, 0, {
          kind: 'transport',
          cause,
          readRetryExhausted: true,
          attempts: retries + 1,
        });
      }
      await waitForRetry(READ_RETRY_DELAYS[retries]!, signal);
    }
  }
}
