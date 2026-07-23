import type { MiddlewareHandler } from 'hono';

/**
 * CORS middleware for the public `/v1/*` surface. Browser-based apps
 * that try to hit `https://127.0.0.1:<port>/v1/*` from a non-matching
 * origin (e.g. an Electron-renderer app hosted at `file://` or an
 * arbitrary http://localhost dev server) need this to receive the
 * standard preflight + response headers.
 *
 * Posture:
 *
 *   - `Access-Control-Allow-Origin` echoes the request's `Origin`
 *     header — necessary for `Access-Control-Allow-Credentials: true`.
 *     We deliberately do NOT use `*` here.
 *   - Restricted to `/v1/*` paths only. The internal `/api/*` surface
 *     stays origin-locked to the static UI bundle (which has no
 *     `Origin` and bypasses CORS anyway).
 *   - Methods + headers are the standard set the SDK needs: GET, POST,
 *     DELETE, OPTIONS; Authorization, Content-Type, Accept.
 *   - `Access-Control-Max-Age: 86400` so a browser caches the preflight
 *     for a day — reduces overhead for a chatty SDK.
 *
 * Auth is still enforced per route. The bearer token gates access;
 * CORS just lets the browser execute the request in the first place.
 */
export function v1Cors(): MiddlewareHandler {
  return async (c, next) => {
    // The app-grant endpoints (/v1/apps/*) are unauthenticated by
    // necessity — they're how an app requests + polls for its token.
    // Deliberately DON'T serve CORS for them: otherwise a drive-by web
    // page could script the register → poll flow cross-origin and read
    // an issued token. The legitimate app-SDK flow runs from a native/
    // desktop context, which isn't subject to CORS. The inference
    // endpoints (/v1/chat etc.) still get CORS so browser apps work.
    const isAppGrantPath = c.req.path.startsWith('/v1/apps/');
    const origin = isAppGrantPath ? undefined : c.req.header('origin');

    if (c.req.method === 'OPTIONS') {
      // Preflight short-circuit. The browser already decided this is a
      // CORS request; no need to invoke the downstream handler.
      const headers: Record<string, string> = {
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers':
          c.req.header('access-control-request-headers') ?? 'Authorization, Content-Type, Accept',
        'access-control-max-age': '86400',
      };
      if (origin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
        headers['access-control-allow-credentials'] = 'true';
      }
      return c.body(null, 204, headers);
    }

    await next();

    if (origin) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('vary', 'Origin');
      c.res.headers.set('access-control-allow-credentials', 'true');
    }
  };
}
