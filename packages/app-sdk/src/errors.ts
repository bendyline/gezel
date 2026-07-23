import type { SdkError } from './types.js';

/**
 * Throw shape for SDK calls. Mirrors the OpenAI error envelope so an
 * app that already handles OpenAI errors needs minimal changes.
 *
 *   try {
 *     await app.chat({ ... });
 *   } catch (err) {
 *     if (err instanceof GezelSdkError && err.code === 'missing_scope:openai') {
 *       // Re-run connect() and ask the user to approve again.
 *     }
 *   }
 */
export class GezelSdkError extends Error implements SdkError {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'GezelSdkError';
    if (opts.code) this.code = opts.code;
    if (opts.status) this.status = opts.status;
  }
}

interface ErrorEnvelope {
  error?: string | { message?: string; code?: string };
}

/**
 * Translate a non-OK response into a {@link GezelSdkError}. Handles
 * both the OpenAI-shape envelope (`{error: {message, code, type}}`)
 * and the simpler gezel envelope (`{error: 'string'}`) used by
 * `/v1/apps/*`.
 */
export async function errorFromResponse(res: Response): Promise<GezelSdkError> {
  let body: ErrorEnvelope = {};
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    /* body wasn't JSON */
  }
  let message: string;
  let code: string | undefined;
  if (typeof body.error === 'string') {
    message = body.error;
    code = body.error;
  } else if (body.error && typeof body.error === 'object') {
    message = body.error.message ?? `HTTP ${res.status}`;
    code = body.error.code;
  } else {
    message = `HTTP ${res.status}`;
  }
  return new GezelSdkError(message, {
    status: res.status,
    ...(code ? { code } : {}),
  });
}
