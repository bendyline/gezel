import { MolenCheckRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { MOLEN_CHECK_UNAVAILABLE, checkMolenDocument } from '../../molen/documents.js';
import type { ServiceContext } from '../context.js';

/**
 * `POST /api/projects/:id/molen/check` — check a Molen document (film, game
 * or data-only scene) and return what blocks it or what it is. Pure data in,
 * data out: it reads no file and runs nothing, so a gezel's session token
 * may call it for its own project (the MCP write tools and `validate` do).
 * 503 when this install lacks the optional `@bendyline/molen-stage`; the
 * write tools then say nothing and `validate` reports the check as skipped.
 */
export function molenRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/molen/check', async (c) => {
    const parsed = MolenCheckRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'expected { document }' }, 400);
    const project = await ctx.store.getProject(c.req.param('id')).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const result = await checkMolenDocument(parsed.data.document);
    if (!result) return c.json({ error: MOLEN_CHECK_UNAVAILABLE }, 503);
    return c.json(result);
  });

  return app;
}
