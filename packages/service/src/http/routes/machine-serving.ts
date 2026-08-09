/**
 * `/api/machine-serving/*` — the user daemon's window onto the machine
 * broker's LAN-serving administration (`/v1/remote/manage/serving/*`).
 * Follows the engines.ts delegation pattern: when a broker has been adopted,
 * every request is re-authenticated upstream with the bridge's
 * `machine-models` credential; with no broker the surface answers 503 so the
 * UI can fall back to the user daemon's own serving controls.
 */

import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

export function machineServingRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', machineEngineProxy(ctx, '/api/machine-serving', '/v1/remote/manage/serving'));
  app.all('*', (c) => c.json({ error: 'machine_engine_unavailable' }, 503));
  return app;
}
