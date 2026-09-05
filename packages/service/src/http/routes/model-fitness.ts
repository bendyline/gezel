import { Hono } from 'hono';
import type { EngineContext } from '../engine-context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

/**
 * Model fitness (the proeve) — read persisted per-model fitness
 * records and trigger manual re-runs. The automatic post-install probe
 * fires server-side via `LlamaCppModelManager.onInstalled`; this
 * surface exists for the badge UI and the user's explicit "Run fitness
 * check" action.
 *
 * Mounted under `/api/model-fitness` from `http/server.ts`.
 */
export function modelFitnessRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  app.use('*', machineEngineProxy(ctx, '/api/model-fitness', '/v1/remote/manage/model-fitness'));

  app.get('/', async (c) => {
    const records = await ctx.modelFitness.list();
    return c.json({ records, probing: ctx.modelFitness.probingKeys() });
  });

  app.post('/:provider/:modelId/probe', async (c) => {
    const provider = c.req.param('provider');
    const modelId = c.req.param('modelId');
    if (provider !== 'llama-cpp' && provider !== 'ds4' && provider !== 'mlx') {
      return c.json({ error: `fitness probes are not supported for provider "${provider}"` }, 400);
    }
    const models =
      provider === 'ds4' ? ctx.ds4Models : provider === 'mlx' ? ctx.mlxModels : ctx.llamaCppModels;
    const installed = await models.resolveModel(modelId);
    if (!installed) {
      return c.json({ error: `model "${modelId}" is not available locally for ${provider}` }, 404);
    }
    ctx.modelFitness.scheduleProbe(provider, modelId, { trigger: 'manual' });
    return c.json({ started: true }, 202);
  });

  return app;
}
