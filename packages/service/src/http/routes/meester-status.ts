import type { MeesterStatusResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import { DEFAULT_MAX_RUNS_PER_DAY, localDay } from '../../meester/status-generator.js';
import type { ServiceContext } from '../context.js';

/**
 * The meester status report surface.
 *
 *   GET  /api/meester-status
 *     Current report (null before the first run), today's run budget,
 *     and whether a run is in flight.
 *
 *   POST /api/meester-status/run
 *     User-requested run. Bypasses the idle/budget/change gates and
 *     returns 202 immediately — completion arrives on the global SSE
 *     stream as a `meester_status` event.
 */
export function meesterStatusRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const [report, state, config] = await Promise.all([
      ctx.store.readMeesterStatus(),
      ctx.store.readMeesterStatusState(),
      ctx.store.readConfig().catch(() => null),
    ]);
    const today = localDay(new Date());
    const response: MeesterStatusResponse = {
      report,
      budget: {
        runsToday: state.runDay === today ? (state.runsOnDay ?? 0) : 0,
        maxRunsPerDay: config?.meesterStatus?.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
        lastRunAt: state.lastRunAt ?? null,
      },
      running: ctx.meesterStatus.isRunning(),
    };
    return c.json(response);
  });

  app.post('/run', (c) => {
    if (ctx.meesterStatus.isRunning()) {
      return c.json({ error: 'a status run is already in flight' }, 409);
    }
    void ctx.meesterStatus.runNow();
    return c.json({ started: true }, 202);
  });

  return app;
}
