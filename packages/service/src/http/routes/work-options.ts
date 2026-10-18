import { SuggestWorkRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { resolveSuggestedWork } from '../../suggested-work/resolve.js';
import { suggestWork } from '../../work/suggest.js';
import type { ServiceContext } from '../context.js';

/**
 * The ranked options behind `suggest_work`, for one request in one project.
 * Coordinator-only (scope guard): it is the Meester's routing surface.
 *
 *   POST /api/projects/:id/work-options   { request, tools? }
 */
export function workOptionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/work-options', async (c) => {
    const projectId = c.req.param('id');
    const project = await ctx.store.getProject(projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const parsed = SuggestWorkRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const result = await suggestWork(
      {
        catalog: ctx.catalog,
        store: ctx.store,
        git: ctx.git,
        listSuggestedWork: (id) =>
          resolveSuggestedWork({ store: ctx.store, catalog: ctx.catalog }, id),
      },
      {
        request: parsed.data.request,
        projectId,
        ...(parsed.data.tools ? { tools: parsed.data.tools } : {}),
      },
    );
    return c.json(result);
  });

  return app;
}
