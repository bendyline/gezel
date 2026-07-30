import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';

/**
 * Host literals we accept. The daemon binds `127.0.0.1` only, so these
 * are the realistic values a legitimate client sends; the IPv6 forms are
 * defensive (the daemon doesn't bind `::1` today).
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Extract the hostname from a `Host` header value, dropping any `:port`.
 *   `127.0.0.1:6228` → `127.0.0.1`
 *   `[::1]:6228`     → `[::1]`
 *   `localhost`       → `localhost`
 */
function hostnameOf(host: string): string {
  const bracketed = /^\[[^\]]+\]/.exec(host);
  if (bracketed) return bracketed[0];
  return host.replace(/:\d+$/, '');
}

/**
 * DNS-rebinding guard for the loopback daemon.
 *
 * The daemon binds `127.0.0.1` only, but now that it claims a fixed,
 * documented port (6228), the port is no longer a secret. A malicious web
 * page can point a hostname it controls at `127.0.0.1` (DNS rebinding) and
 * have the victim's browser issue requests to us — and the browser puts the
 * attacker's hostname in the `Host` header, not ours. Reject any request
 * whose Host isn't a loopback literal so only pages actually served from
 * `127.0.0.1`/`localhost` (our own UI) can reach the API.
 *
 * This does NOT break legitimate cross-origin `/v1/*` apps: a page at
 * `http://localhost:3000` fetching `http://127.0.0.1:6228/v1/...` sends
 * `Host: 127.0.0.1:6228` (the addressed server) and `Origin:
 * http://localhost:3000`. We check Host (loopback → allowed); CORS handles
 * Origin separately.
 *
 * HTTP/2 carries the addressed host in `:authority`, not `Host`. Hono's Node
 * adapter incorporates that authority into `c.req.url` but does not expose
 * the pseudo-header through `c.req.header()`, so the canonical URL is the
 * fallback authority source. A request with neither a usable Host header nor
 * an absolute URL is rejected; in-process `app.request('/')` remains usable
 * because Hono resolves it against `http://localhost`.
 */
export function hostGuard(opts: { allowLanIpHosts?: () => boolean } = {}): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? authorityFromUrl(c.req.url);
    if (!host) return c.json({ error: 'forbidden_host' }, 403);
    const lower = host.toLowerCase();
    if (LOOPBACK_HOSTS.has(lower) || LOOPBACK_HOSTS.has(hostnameOf(lower))) {
      return next();
    }
    const hostname = hostnameOf(lower).replace(/^\[/, '').replace(/\]$/, '');
    // Remote serving deliberately accepts requests addressed to a LAN IP.
    // Keep domain names forbidden so DNS rebinding cannot turn an attacker
    // hostname into authority over the loopback daemon.
    if (opts.allowLanIpHosts?.() && isIP(hostname) !== 0) return next();
    return c.json({ error: 'forbidden_host' }, 403);
  };
}

function authorityFromUrl(url: string): string | null {
  try {
    const authority = new URL(url).host;
    return authority || null;
  } catch {
    return null;
  }
}
