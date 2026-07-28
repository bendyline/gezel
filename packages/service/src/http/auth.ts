import type { MiddlewareHandler } from 'hono';
import type { TokenStore } from './token-store.js';

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * Set by {@link bearerAuth} once the request's bearer token is
     * resolved to a known {@link import('./token-store.js').TokenRecord}.
     * Route handlers (and the {@link requireScope} middleware) read this
     * to audit per-app calls and gate scope-sensitive endpoints. Absent
     * on the unauthenticated `/api/health` path.
     */
    auth: {
      appId: string;
      scopes: readonly string[];
      /** Present on session-scoped tokens (a gezel's MCP subprocess); the
       *  scope-guard confines them to this project unless `team`. */
      projectId?: string;
      gezelId?: string;
      team?: boolean;
    };
  }
}

/**
 * Bearer-token gate. Replaces the prior single-token equality check with
 * a {@link TokenStore} lookup so the same middleware authorizes both the
 * root token (rotated every launch) and per-app tokens issued through
 * `/v1/apps/register`.
 *
 * `/api/health` stays unauthenticated — clients use it to probe whether
 * the daemon is up before they've read a token from `runtime/auth-token`.
 *
 * Tokens are header-only by default. A narrowly mounted EventSource route may
 * opt into query capabilities because the browser API cannot attach headers;
 * ordinary API routes must never accept credentials in URLs.
 */
export function bearerAuth(
  store: TokenStore,
  options: { allowQueryToken?: (method: string, path: string) => boolean } = {},
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const queryAllowed = options.allowQueryToken?.(c.req.method, c.req.path) === true;
    const supplied = match?.[1] ?? (queryAllowed ? c.req.query('token') : undefined) ?? '';
    if (!supplied) return c.json({ error: 'unauthorized' }, 401);
    const record = store.lookup(supplied);
    if (!record) return c.json({ error: 'unauthorized' }, 401);
    store.touch(supplied);
    c.set('auth', {
      appId: record.appId,
      scopes: record.scopes,
      ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
      ...(record.gezelId !== undefined ? { gezelId: record.gezelId } : {}),
      ...(record.team !== undefined ? { team: record.team } : {}),
    });
    return next();
  };
}

/**
 * Gate a route group on a specific scope. The process-local root token's
 * `scopes: ['root']` matches every scope check. Every other caller —
 * including the scoped desktop client and third-party apps — passes only
 * when the requested scope is explicitly present. Session/MCP tokens do
 * not receive this wildcard.
 *
 * Usage:
 *   app.use('/v1/*', bearerAuth(ctx.tokenStore));
 *   app.use('/v1/chat/*', requireScope('openai'));
 *
 * Apply this at mount time, *after* {@link bearerAuth} has populated
 * `c.var.auth`. A missing or mismatched scope returns
 * `403 { error: 'missing_scope:<scope>' }` so callers can show the user
 * an actionable message ("DocBlocks needs the openai scope — re-grant").
 */
export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    if (auth.scopes.includes('root') || auth.scopes.includes(scope)) return next();
    return c.json({ error: `missing_scope:${scope}` }, 403);
  };
}

/**
 * Gate a first-party administrative surface. The daemon's process-local
 * `root` token and the per-launch desktop/web credential (`ui`) are the only
 * callers allowed through. Unlike `requireScope('root')`, this does not force
 * the renderer discovery credential to be root-equivalent.
 */
export function requireFirstParty(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    if (auth.scopes.includes('root') || auth.scopes.includes('ui')) return next();
    return c.json({ error: 'missing_scope:first-party' }, 403);
  };
}

/**
 * Scope boundary for the internal `/api/*` and `/events/*` surfaces.
 *
 * `bearerAuth` answers only "is this a live token?". Without this second
 * check an approved third-party `openai` token is also a live token and can
 * accidentally reach the product API. First-party clients and explicitly
 * approved `product`/`cli` credentials may use the internal surface; session
 * tokens continue to the stricter route/ownership guard in `scope-guard.ts`.
 * Every other app/device scope is rejected here.
 */
export function requireInternalApiAccess(): MiddlewareHandler {
  return async (c, next) => {
    // `/api/health` is intentionally public for supervisor discovery.
    if (c.req.path === '/api/health') return next();
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    if (
      auth.scopes.includes('root') ||
      auth.scopes.includes('ui') ||
      auth.scopes.includes('product') ||
      auth.scopes.includes('cli') ||
      auth.scopes.includes('session')
    ) {
      return next();
    }
    return c.json(
      {
        error: 'forbidden',
        hint: 'this token is not authorized for the internal Gezel API',
      },
      403,
    );
  };
}

/**
 * Confine paired-device (`remote-inference`) tokens to the `/v1/remote/*`
 * inference surface. Applied on `/api/*` so a remote token — which can only
 * ever run inference — gets 403 on every project/fs/session route, never
 * reaching this host's files or projects. Root/ui tokens (first-party) always
 * pass; session + other app tokens are unaffected (they don't carry the
 * remote-inference scope). This is the load-bearing least-privilege boundary
 * for remote model execution.
 */
export function denyRemoteInferenceScope(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return next(); // bearerAuth already rejected a missing/invalid token
    if (auth.scopes.includes('root') || auth.scopes.includes('ui')) return next();
    if (auth.scopes.includes('remote-inference')) {
      return c.json(
        { error: 'forbidden', hint: 'remote-inference tokens are confined to /v1/remote/*' },
        403,
      );
    }
    return next();
  };
}
