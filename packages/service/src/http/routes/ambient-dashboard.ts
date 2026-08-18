import { readFile, stat } from 'node:fs/promises';
import {
  AmbientDashboardDisplayTargetSchema,
  type AmbientDashboardStatusResponse,
} from '@bendyline/gezel';
import { ambientDashboardLatestFile } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { DEFAULT_RESOLUTION } from '../../ambient/dashboard-generator.js';
import { AMBIENT_DASHBOARD_THEMES, DEFAULT_THEME_ID } from '../../ambient/dashboard-themes.js';
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
 *
 *   PUT /api/ambient-dashboard/display-target
 *     Persists the Electron shell's primary-display canvas and safe content
 *     area for both manual and scheduled renders.
 */
export function ambientDashboardRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const [state, config, latestInfo] = await Promise.all([
      ctx.ambientDashboard.readState(),
      ctx.store.readConfig().catch(() => null),
      stat(ambientDashboardLatestFile(ctx.home)).catch(() => null),
    ]);
    const response: AmbientDashboardStatusResponse = {
      enabled: config?.ambientDashboard?.enabled === true,
      running: ctx.ambientDashboard.isRunning(),
      // Old state files predate `lastGeneratedAt`; the stable PNG's mtime is
      // the authoritative migration fallback and cannot be confused by a
      // newer failed attempt.
      lastGeneratedAt: state.lastGeneratedAt ?? latestInfo?.mtime.toISOString() ?? null,
      lastFailedAt: state.lastFailedAt ?? null,
      lastError: state.lastError ?? null,
      latestFilename: state.lastFile ?? null,
      resolution: config?.ambientDashboard?.resolution ?? DEFAULT_RESOLUTION,
      themeId: config?.ambientDashboard?.themeId ?? DEFAULT_THEME_ID,
      themes: AMBIENT_DASHBOARD_THEMES,
      displayTarget: config?.ambientDashboard?.displayTarget ?? null,
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

  app.put('/display-target', async (c) => {
    const displayTarget = AmbientDashboardDisplayTargetSchema.parse(await c.req.json());
    const config = await ctx.store.readConfig();
    const current = config.ambientDashboard?.displayTarget;
    if (JSON.stringify(current) !== JSON.stringify(displayTarget)) {
      await ctx.store.writeConfig({
        ambientDashboard: {
          ...(config.ambientDashboard ?? {}),
          displayTarget,
        },
      });
    }
    return c.json({ displayTarget });
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
