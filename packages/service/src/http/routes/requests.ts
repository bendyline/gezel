import type { ListRequestsResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import { listRequestTracks } from '../../requests/sources.js';
import type { ServiceContext } from '../context.js';

/**
 * `GET /api/requests?sessions=a,b&live=1` — one tracker per person message:
 * the threads' requests (all of them when `sessions` is absent), only those
 * still under way with `live=1`.
 */
export function requestRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const sessions = (c.req.query('sessions') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const requests = await listRequestTracks(ctx, {
      ...(sessions.length > 0 ? { sessions } : {}),
      ...(c.req.query('live') === '1' ? { live: true } : {}),
    });
    const out: ListRequestsResponse = { requests, at: new Date().toISOString() };
    return c.json(out);
  });
  return app;
}
