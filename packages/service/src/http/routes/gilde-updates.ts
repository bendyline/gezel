import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/**
 * Live gilde content updates (Settings → About → Catalog content).
 *
 *   GET  /api/gilde-updates
 *     Current status: opt-in flag, content mode (bundled/live/overridden),
 *     bundled vs active version, last check result, in-flight flag.
 *
 *   POST /api/gilde-updates/check
 *     User-requested check. Returns 202 immediately (attaching to an
 *     in-flight run also 202s); the UI polls GET until
 *     `updateInProgress` clears.
 */
export function gildeUpdateRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await ctx.gildeUpdates.status()));

  app.post('/check', (c) => {
    void ctx.gildeUpdates.checkNow('manual').catch(() => {
      /* failures land in status().lastCheck */
    });
    return c.json({ started: true }, 202);
  });

  return app;
}
