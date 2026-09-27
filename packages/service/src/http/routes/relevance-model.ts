import { RelevanceScoreRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';

/**
 * `/api/relevance-model` — the relevance check's status for Settings and the
 * evals, an explicit install, calibration scoring, and removal. Not a session
 * route: the scope guard denies new `/api/*` paths to session tokens.
 */
export function relevanceModelRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await ctx.relevance.status()));

  app.post('/install', async (c) => {
    const body = z
      .object({ modelId: z.string().min(1).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const setting = await ctx.relevance.setting();
    const modelId = body.modelId ?? setting.spec?.id;
    if (!modelId) return c.json({ error: 'no relevance model selected' }, 400);
    const result = await ctx.relevance.install(modelId);
    if (result.installed) return c.json(result);
    return c.json(result, result.started ? 202 : 409);
  });

  app.post('/score', async (c) => {
    const body = RelevanceScoreRequestSchema.parse(await c.req.json());
    const result = await ctx.relevance.score(body);
    return 'error' in result ? c.json(result, 409) : c.json(result);
  });

  app.delete('/models/:id', async (c) => {
    const removed = await ctx.relevance.remove(c.req.param('id'));
    return removed ? c.json({ ok: true }) : c.json({ error: 'unknown relevance model' }, 404);
  });

  return app;
}
