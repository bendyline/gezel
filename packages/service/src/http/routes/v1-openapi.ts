import { GEZEL_VERSION } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';
import { buildOpenApiDoc } from '../openai-compat/openapi.js';

/**
 * `GET /v1/openapi.json` — serves the hand-authored OpenAPI 3.1
 * document for the public `/v1/*` surface. Useful for:
 *
 *   - Pointing a viewer (Swagger UI, Redocly) at the public contract.
 *   - Running codegen for a typed client in a non-TypeScript language.
 *   - Sanity-checking that a route's documented shape matches its
 *     implementation (Phase-6+ work could add automated drift checks).
 *
 * Unauthenticated so app authors browsing the surface don't need a
 * token in hand. The document doesn't carry any secret material.
 */
export function v1OpenApiRoutes(_ctx: ServiceContext): Hono {
  const app = new Hono();
  // Cache the doc per-process — the version is a constant, so building
  // once and serving the cached value avoids per-request allocation.
  const cached = buildOpenApiDoc(GEZEL_VERSION);
  app.get('/', (c) => c.json(cached));
  return app;
}
