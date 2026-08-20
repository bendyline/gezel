/**
 * Machine broker knowledge surface (docs/service-boundaries.md,
 * `machine-knowledge-assets` scope — mounted ONLY on the machine-engine
 * role, under /v1/remote/manage/knowledge):
 *
 *   POST /ensure     { coordinate: TrustedKnowledgeCoordinate } → ready | error
 *   POST /status     { coordinate } → { installed }
 *   GET  /inventory  the public machine inventory
 *   POST /reclaim    { coordinate } → { removed }   (machine-wide, deliberate)
 *
 * Exactly four operations. No route here may ever return catalog CONTENT —
 * queries, chunks, and document reads live in the user daemon only. Inputs
 * are signed coordinates; arbitrary URLs and local paths are rejected by the
 * schema at this boundary.
 */

import { TrustedKnowledgeCoordinateSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { createKnowledgeAssetsBroker } from '../../machine-engine/knowledge-assets.js';

const CoordinateBodySchema = z.object({ coordinate: TrustedKnowledgeCoordinateSchema });

export function v1KnowledgeAssetsRoutes(): Hono {
  const app = new Hono();
  const broker = createKnowledgeAssetsBroker();

  app.post('/ensure', async (c) => {
    const { coordinate } = CoordinateBodySchema.parse(await c.req.json());
    const outcome = await broker.ensure(coordinate);
    if (outcome.status === 'ready') return c.json({ status: 'ready' });
    const status = outcome.code === 'not-found' ? 404 : outcome.code === 'unavailable' ? 503 : 422;
    return c.json({ status: 'error', code: outcome.code, error: outcome.error }, status);
  });

  app.post('/status', async (c) => {
    const { coordinate } = CoordinateBodySchema.parse(await c.req.json());
    return c.json(await broker.status(coordinate));
  });

  app.get('/inventory', async (c) => c.json(await broker.inventory()));

  app.post('/reclaim', async (c) => {
    const { coordinate } = CoordinateBodySchema.parse(await c.req.json());
    return c.json(await broker.reclaim(coordinate));
  });

  return app;
}
