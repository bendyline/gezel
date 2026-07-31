import {
  DisableSuggestedWorkRequestSchema,
  DismissSuggestedWorkRequestSchema,
  EnableSuggestedWorkRequestSchema,
  type SuggestedWorkResponse,
  createLogger,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import {
  type SuggestedWorkDeps,
  disableSuggestedWork,
  dismissSuggestedWork,
  enableSuggestedWork,
} from '../../suggested-work/enable.js';
import { resolveSuggestedWork } from '../../suggested-work/resolve.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Suggested Night Work — the per-project toggle surface unioning role-
 * and project-type-recommended recurring craftbooks. See core
 * `schemas/suggested-work.ts` for the model and
 * `suggested-work/{resolve,enable}.ts` for the semantics.
 *
 *   GET  /api/projects/:id/suggested-work
 *   POST /api/projects/:id/suggested-work/enable   { key, params? }
 *   POST /api/projects/:id/suggested-work/disable  { key }
 *   POST /api/projects/:id/suggested-work/dismiss  { key, dismissed }
 */
export function suggestedWorkRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const deps: SuggestedWorkDeps = {
    store: ctx.store,
    catalog: ctx.catalog,
    tasks: ctx.tasks,
    chatEvents: ctx.chatEvents,
    history: ctx.history,
  };

  app.get('/:id/suggested-work', async (c) => {
    const projectId = c.req.param('id');
    const project = await ctx.store.getProject(projectId);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const items = await resolveSuggestedWork(deps, projectId);
    const response: SuggestedWorkResponse = { items };
    return c.json(response);
  });

  app.post('/:id/suggested-work/enable', async (c) => {
    const projectId = c.req.param('id');
    const parsed = EnableSuggestedWorkRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const result = await enableSuggestedWork(deps, { projectId, ...parsed.data });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[suggested-work] enable failed for ${projectId}/${parsed.data.key}: ${message}`);
      return c.json({ error: message }, message.startsWith('unknown suggested-work') ? 404 : 500);
    }
  });

  app.post('/:id/suggested-work/disable', async (c) => {
    const projectId = c.req.param('id');
    const parsed = DisableSuggestedWorkRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const item = await disableSuggestedWork(deps, { projectId, key: parsed.data.key });
      return c.json({ item });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[suggested-work] disable failed for ${projectId}/${parsed.data.key}: ${message}`);
      return c.json({ error: message }, message.startsWith('unknown suggested-work') ? 404 : 500);
    }
  });

  app.post('/:id/suggested-work/dismiss', async (c) => {
    const projectId = c.req.param('id');
    const parsed = DismissSuggestedWorkRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    await dismissSuggestedWork(deps, { projectId, ...parsed.data });
    return c.json({ ok: true });
  });

  return app;
}
