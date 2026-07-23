/**
 * Unified cross-project search backing the titlebar search box.
 *
 *   - `POST /api/search`        — full unified search (catalog + content fan-out)
 *   - `GET  /api/search/quick`  — instant name-only quick-open (catalog only)
 *
 * Mounted under `/api/search`. Inherits bearer auth + the global ZodError→422
 * handler from `buildApp`.
 */

import { UnifiedSearchRequestSchema, type UnifiedSearchResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

export function searchRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = UnifiedSearchRequestSchema.parse(await c.req.json());
    const { results, truncated } = await ctx.search.search(body.query, {
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.maxResults ? { maxResults: body.maxResults } : {}),
    });
    const response: UnifiedSearchResponse = { results, truncated };
    return c.json(response);
  });

  app.get('/quick', async (c) => {
    const q = c.req.query('q') ?? '';
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const results = await ctx.search.quickOpen(
      q,
      limit && Number.isFinite(limit) ? limit : undefined,
    );
    const response: UnifiedSearchResponse = { results, truncated: false };
    return c.json(response);
  });

  return app;
}
