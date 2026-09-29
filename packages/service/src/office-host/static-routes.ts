import { readFile, stat } from 'node:fs/promises';
import { Hono } from 'hono';
import { safeJoin } from '../fs/safe-paths.js';
import { mimeTypeForPath } from '../http/mime.js';
import { staticUiCacheControl } from '../http/static-ui.js';

/**
 * Microsoft requires add-ins to load `office.js` from its CDN; everything
 * else the pane needs is served same-origin. That CDN is the one exception
 * this policy makes to the daemon's default CSP.
 */
export const OFFICE_JS_ORIGIN = 'https://appsforoffice.microsoft.com';

export const OFFICE_PANE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${OFFICE_JS_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  `connect-src 'self' ${OFFICE_JS_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'self'",
  // Word, Excel and PowerPoint on the desktop load the pane top-level.
  // Office on the web frames it, and is deliberately not supported.
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/**
 * `/office/*`: the task-pane pages staged from `packages/ui/dist-office`.
 * Exact files only: no SPA fallback, so a missing script is an honest 404.
 */
export function officeStaticRoutes(officeDir: string): Hono {
  const app = new Hono();
  app.get('/*', async (c) => {
    const rel = c.req.path.replace(/^\/office\/?/, '');
    if (!rel) return c.notFound();
    const file = safeJoin(officeDir, rel);
    if (!file) return c.notFound();
    try {
      if (!(await stat(file)).isFile()) return c.notFound();
      return c.body(await readFile(file), 200, {
        'content-type': mimeTypeForPath(file),
        'cache-control': staticUiCacheControl(rel),
      });
    } catch {
      return c.notFound();
    }
  });
  return app;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a request arrived through the Office listener: a loopback Host
 * header naming the Office origin's port. The host guard has already
 * refused non-loopback hosts; this only tells the two loopback listeners
 * apart.
 */
export function isOfficeListenerRequest(
  host: string | undefined,
  officeOrigin: string | null,
): boolean {
  if (!host || !officeOrigin) return false;
  let officePort: string;
  try {
    officePort = new URL(officeOrigin).port;
  } catch {
    return false;
  }
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host.trim().toLowerCase());
  if (!m) return false;
  return LOOPBACK_HOSTNAMES.has(m[1]!) && m[2] === officePort;
}
