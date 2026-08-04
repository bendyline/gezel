import {
  GezmodelEngineSchema,
  SharedModelMigrationCandidatesResponseSchema,
  SharedModelMigrationRequestSchema,
  SharedModelMigrationResultSchema,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { SharedModelMigrationManager } from '../../models/shared-model-migration.js';
import type { ServiceContext } from '../context.js';
import { invalidateModelsCache } from './models.js';

/** User-owned model discovery and safe transfer into the machine shared store. */
export function modelMigrationRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const migrations = new SharedModelMigrationManager({
    home: ctx.home,
    catalog: ctx.catalog,
    llamaCpp: ctx.llamaCppModels,
    mlx: ctx.mlxModels,
    ds4: ctx.ds4Models,
    machineEngine: ctx.machineEngine,
  });

  app.get('/candidates', async (c) => {
    try {
      const rawEngine = c.req.query('engine');
      const engine = rawEngine ? GezmodelEngineSchema.parse(rawEngine) : undefined;
      return c.json(
        SharedModelMigrationCandidatesResponseSchema.parse({
          available: migrations.isAvailable(),
          candidates: await migrations.listCandidates(engine),
        }),
      );
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post('/move', async (c) => {
    try {
      const request = SharedModelMigrationRequestSchema.parse(await c.req.json());
      const result = SharedModelMigrationResultSchema.parse(await migrations.move(request));
      invalidateModelsCache(request.engine);
      return c.json(result);
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('not connected')
        ? 503
        : message.includes('already being')
          ? 409
          : 400;
      return c.json({ error: message }, status);
    }
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
