/**
 * Machine broker knowledge surface (docs/service-boundaries.md,
 * `machine-knowledge-assets` scope — mounted ONLY on the machine-engine
 * role, under /v1/remote/manage/knowledge):
 *
 *   POST /ensure         { coordinate: TrustedKnowledgeCoordinate } → ready | error
 *   POST /ensure-stream  { coordinate } → SSE of install events (attaches to a running install)
 *   POST /cancel         { coordinate } → { aborted }
 *   POST /status         { coordinate } → { installed }
 *   GET  /inventory      the public machine inventory
 *   POST /reclaim        { coordinate } → { removed }   (machine-wide, deliberate)
 *
 * Exactly six operations. No route here may ever return catalog CONTENT —
 * queries, chunks, and document reads live in the user daemon only. Inputs
 * are trusted coordinates; arbitrary URLs and local paths are rejected by the
 * schema at this boundary. Installs are background jobs: a disconnected
 * stream never abandons a download, and cancel is the explicit verb.
 */

import { TrustedKnowledgeCoordinateSchema } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  type EnsureErrorCode,
  createKnowledgeAssetsBroker,
} from '../../machine-engine/knowledge-assets.js';
import { subscribeToInstallSse } from './install-sse.js';

const CoordinateBodySchema = z.object({ coordinate: TrustedKnowledgeCoordinateSchema });

const ERROR_STATUS: Record<EnsureErrorCode, 404 | 409 | 422 | 503> = {
  'not-found': 404,
  unavailable: 503,
  'digest-mismatch': 422,
  invalid: 422,
  cancelled: 409,
};

export function v1KnowledgeAssetsRoutes(deps: { catalog?: CatalogService } = {}): Hono {
  const app = new Hono();
  const broker = createKnowledgeAssetsBroker(
    process.env,
    deps.catalog ? { catalog: deps.catalog } : {},
  );

  app.post('/ensure', async (c) => {
    const { coordinate } = CoordinateBodySchema.parse(await c.req.json());
    const outcome = await broker.ensure(coordinate);
    if (outcome.status === 'ready') return c.json({ status: 'ready' });
    return c.json(
      { status: 'error', code: outcome.code, error: outcome.error },
      ERROR_STATUS[outcome.code],
    );
  });

  app.post('/ensure-stream', async (c) => {
    const { coordinate } = CoordinateBodySchema.parse(await c.req.json());
    if (!broker.available()) {
      return c.json(
        { status: 'error', code: 'unavailable', error: 'shared asset store not configured' },
        503,
      );
    }
    const { key } = broker.startStream(coordinate);
    return streamSSE(c, (stream) => subscribeToInstallSse(broker.installs, key, stream));
  });

  app.post('/cancel', async (c) => {
    const { coordinate } = CoordinateBodySchema.parse(await c.req.json());
    return c.json({ aborted: broker.cancel(coordinate) });
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
