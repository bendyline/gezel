import { PageTableRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import { readPageTables } from '../page-tables.js';

export function pageTableRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const times = new Map<string, number[]>();
  app.post('/:projectId/page-tables', requireFirstParty(), async (c) => {
    const projectId = c.req.param('projectId');
    const recent = (times.get(projectId) ?? []).filter((at) => Date.now() - at < 60_000);
    if (recent.length >= 120)
      return c.json({ error: 'Too many table requests.', errorCode: 'rate-limited' }, 429);
    recent.push(Date.now());
    times.set(projectId, recent);
    const parsed = PageTableRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid table request.', errorCode: 'invalid-input' }, 400);
    const result = await readPageTables(ctx, { projectId, request: parsed.data });
    return c.json(result.body, result.status);
  });
  return app;
}
