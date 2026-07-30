import type { MiddlewareHandler } from 'hono';

/**
 * Re-shape the shared auth middlewares' flat error bodies
 * (`{error: 'unauthorized'}`, `{error: 'missing_scope:openai'}`) into
 * the OpenAI error envelope on the `/v1/*` surface. The auth layer is
 * shared with the internal `/api/*` product surface, where the flat
 * shape is the house style — rather than fork the auth middlewares,
 * this wrapper runs OUTSIDE them and rewrites the response after the
 * fact. OpenAI SDKs throw the right error class off the status code
 * either way; this fixes the *displayed* message, which for a flat body
 * is `undefined`.
 *
 * Already-enveloped bodies (`{error: {…}}`) pass through untouched, so
 * route-level errors and the endpoints-disabled gate are unaffected.
 * Headers (CORS, request ids) are preserved.
 */
export function openAiErrorEnvelope(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status !== 401 && c.res.status !== 403) return;
    let flat: string | null = null;
    try {
      const body = (await c.res.clone().json()) as { error?: unknown };
      flat = typeof body.error === 'string' ? body.error : null;
    } catch {
      return;
    }
    if (flat === null) return;

    const message =
      c.res.status === 401
        ? 'Missing or invalid API key. Connect this app through gezel (Settings → Connected Apps) to get one.'
        : `This API key is not authorized for this endpoint (${flat}). Re-connect the app with the right permissions in gezel.`;
    const replacement = new Response(
      JSON.stringify({
        error: {
          message,
          type: c.res.status === 401 ? 'invalid_request_error' : 'permission_error',
          code: c.res.status === 401 ? 'invalid_api_key' : flat,
        },
      }),
      { status: c.res.status, headers: c.res.headers },
    );
    replacement.headers.set('content-type', 'application/json; charset=UTF-8');
    c.res = replacement;
  };
}
