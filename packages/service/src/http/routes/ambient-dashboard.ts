import { readFile } from 'node:fs/promises';
import type { AmbientDashboardStatusResponse } from '@bendyline/gezel';
import { ambientDashboardLatestFile } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { DEFAULT_RESOLUTION } from '../../ambient/dashboard-generator.js';
import type { ServiceContext } from '../context.js';

/**
 * The ambient dashboard surface.
 *
 *   GET  /api/ambient-dashboard
 *     Enabled flag, whether a run is in flight, and what the newest
 *     render is.
 *
 *   GET  /api/ambient-dashboard/latest.png
 *     The stable latest render. 404 before the first successful run.
 *
 *   POST /api/ambient-dashboard/run
 *     User-requested run. Bypasses the throttle/change gates and
 *     returns 202 immediately — completion arrives on the global SSE
 *     stream as an `ambient_dashboard` event.
 */
export function ambientDashboardRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const [state, config] = await Promise.all([
      ctx.ambientDashboard.readState(),
      ctx.store.readConfig().catch(() => null),
    ]);
    const response: AmbientDashboardStatusResponse = {
      enabled: config?.ambientDashboard?.enabled === true,
      running: ctx.ambientDashboard.isRunning(),
      lastGeneratedAt: state.lastRunAt && state.lastFile ? state.lastRunAt : null,
      latestFilename: state.lastFile ?? null,
      resolution: config?.ambientDashboard?.resolution ?? DEFAULT_RESOLUTION,
    };
    return c.json(response);
  });

  app.get('/latest.png', async (c) => {
    const bytes = await readFile(ambientDashboardLatestFile(ctx.home)).catch(() => null);
    if (!bytes) return c.json({ error: 'no dashboard has been generated yet' }, 404);
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': 'image/png',
      'cache-control': 'no-cache',
    });
  });

  app.post('/run', (c) => {
    if (ctx.ambientDashboard.isRunning()) {
      return c.json({ error: 'a dashboard run is already in flight' }, 409);
    }
    void ctx.ambientDashboard.runNow();
    return c.json({ started: true }, 202);
  });

  return app;
}
