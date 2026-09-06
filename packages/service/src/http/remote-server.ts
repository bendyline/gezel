import { randomUUID } from 'node:crypto';
import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { bearerAuth, requireScope } from './auth.js';
import type { EngineContext } from './engine-context.js';
import { hostGuard } from './host-guard.js';
import { v1AppsRoutes } from './routes/v1-apps.js';
import { v1IdentityRoutes } from './routes/v1-identity.js';
import { v1RemoteRoutes } from './routes/v1-remote.js';

/**
 * The deliberately small HTTP surface exposed by the optional LAN listener.
 * Keep this list separate from the loopback app: adding a local route must
 * never make it remotely reachable as an accidental side effect.
 */
export function isRemoteServingRoute(method: string, path: string): boolean {
  if (method === 'GET' && path === '/v1/identity') return true;
  if (method === 'POST' && path === '/v1/apps/register') return true;
  if (method === 'GET' && /^\/v1\/apps\/grant\/[^/]+(?:\/events)?$/.test(path)) return true;
  if (method === 'DELETE' && /^\/v1\/apps\/[^/]+\/token$/.test(path)) return true;
  return path === '/v1/remote' || path.startsWith('/v1/remote/');
}

export function buildRemoteApp(ctx: EngineContext): Hono {
  const app = new Hono();
  const log = createLogger('remote-http');

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('proxy-connection');
    c.res.headers.delete('transfer-encoding');
  });

  // The remote listener is addressed by a LAN IP. Domain Host values stay
  // forbidden so DNS rebinding cannot turn an attacker-controlled hostname
  // into authority over this service.
  app.use('*', hostGuard({ allowLanIpHosts: () => true }));
  app.use('*', async (c, next) => {
    if (!isRemoteServingRoute(c.req.method, c.req.path)) {
      return c.json({ error: 'not_found' }, 404);
    }
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json(
        {
          error: err.issues
            .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
            .join('; '),
        },
        422,
      );
    }
    const requestId = randomUUID();
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(
      `[remote-http] unhandled request error id=${requestId} method=${c.req.method} path=${c.req.path}: ${detail}`,
    );
    return c.json({ error: 'internal_error', requestId }, 500);
  });

  app.route('/v1/apps', v1AppsRoutes(ctx));
  app.route('/v1/identity', v1IdentityRoutes(ctx));
  app.use('/v1/remote/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/remote/*', requireScope('remote-inference'));
  app.route('/v1/remote', v1RemoteRoutes(ctx));

  return app;
}
