/**
 * Control surface for app-serve sites (docs/app-serve.md):
 *
 *   POST   /api/app-serve                     start a site → 201 (the only
 *                                             response carrying the site key)
 *   GET    /api/app-serve                     list sites
 *   GET    /api/app-serve/:siteId             one site's status
 *   POST   /api/app-serve/:siteId/rotate-key  new key (± revoke visitors)
 *   DELETE /api/app-serve/:siteId             stop + archive visitor chats
 *
 * Guarded to root | ui | cli — narrower than `requireInternalApiAccess`,
 * which also admits `session` and `product`: a gezel's MCP token must never
 * be able to open a listener to the outside world.
 */

import { AppServeRotateKeyRequestSchema, AppServeStartRequestSchema } from '@bendyline/gezel';
import { Hono, type MiddlewareHandler } from 'hono';
import { AppServeStartError } from '../../app-serve/controller.js';
import type { ServiceContext } from '../context.js';

function requireAppServeControl(): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    if (auth.scopes.includes('root') || auth.scopes.includes('ui') || auth.scopes.includes('cli')) {
      return next();
    }
    return c.json({ error: 'missing_scope:app-serve-control' }, 403);
  };
}

export function appServeRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', requireAppServeControl());

  const controller = () => {
    if (!ctx.appServe)
      throw new AppServeStartError('app serve is not available on this daemon', 403);
    return ctx.appServe;
  };

  app.onError((err, c) => {
    if (err instanceof AppServeStartError) return c.json({ error: err.message }, err.status);
    throw err;
  });

  app.get('/', (c) => c.json({ sites: controller().list() }));

  app.post('/', async (c) => {
    const body = AppServeStartRequestSchema.parse(await c.req.json());
    const started = await controller().start(body);
    return c.json(started, 201);
  });

  app.get('/:siteId', (c) => {
    const site = controller().get(c.req.param('siteId'));
    if (!site) return c.json({ error: 'site not found' }, 404);
    return c.json(site);
  });

  app.post('/:siteId/rotate-key', async (c) => {
    const body = AppServeRotateKeyRequestSchema.parse(await c.req.json().catch(() => ({})));
    const rotated = controller().rotateKey(c.req.param('siteId'), {
      revokeVisitors: body.revokeVisitors ?? false,
    });
    if (!rotated) return c.json({ error: 'site not found' }, 404);
    return c.json(rotated);
  });

  app.delete('/:siteId', async (c) => {
    const stopped = await controller().stop(c.req.param('siteId'));
    if (!stopped) return c.json({ error: 'site not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
