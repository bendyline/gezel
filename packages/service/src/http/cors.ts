import type { Context, MiddlewareHandler } from 'hono';
import { isOfficeListenerRequest } from '../office-host/static-routes.js';
import { requestHost } from './host-guard.js';

/**
 * Unauthenticated `/v1` endpoints. None is meant for a web page, so none is
 * ever readable cross-origin:
 *
 *   - `/v1/apps/*` is how an app requests and polls for its token. With CORS
 *     a drive-by page could script register → poll and read an issued token.
 *     The legitimate flow runs from a native/desktop context, which isn't
 *     subject to CORS.
 *   - `/v1/identity` publishes the device id, a stable identifier that
 *     survives cookie clearing, plus the Gezel version. Its callers are
 *     pairing peers and the machine-engine bridge (native) and the app's own
 *     UI (same-origin).
 *   - `/v1/openapi.json` carries the Gezel version. Reading the schema in a
 *     browser is a navigation, not a cross-origin fetch.
 */
const NO_CORS_PREFIXES = ['/v1/apps', '/v1/identity', '/v1/openapi.json'];

function isNoCorsPath(path: string): boolean {
  return NO_CORS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

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
 *   - Never on the unauthenticated endpoints in {@link NO_CORS_PREFIXES}.
 *   - On the Office listener, only the task pane's own origin. That
 *     listener has a stable port and a certificate every browser on the
 *     machine trusts, so echoing any Origin there lets every website read
 *     from Gezel. The pane is its only browser client.
 *   - Methods + headers are the standard set the SDK needs: GET, POST,
 *     DELETE, OPTIONS; Authorization, Content-Type, Accept.
 *   - `Access-Control-Max-Age: 86400` so a browser caches the preflight
 *     for a day — reduces overhead for a chatty SDK.
 *
 * Auth is still enforced per route. The bearer token gates access;
 * CORS just lets the browser execute the request in the first place.
 */
export function v1Cors(opts: { officeHostOrigin?: () => string | null } = {}): MiddlewareHandler {
  return async (c, next) => {
    const origin = allowedOrigin(c, opts.officeHostOrigin?.() ?? null);

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

/** The Origin this request may be answered for, or undefined for no CORS headers at all. */
function allowedOrigin(c: Context, officeOrigin: string | null): string | undefined {
  const requested = c.req.header('origin');
  if (!requested || isNoCorsPath(c.req.path)) return undefined;
  if (isOfficeListenerRequest(requestHost(c) ?? undefined, officeOrigin)) {
    return requested === officeOrigin ? requested : undefined;
  }
  return requested;
}
