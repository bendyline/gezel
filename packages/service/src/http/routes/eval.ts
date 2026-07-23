/**
 * Eval routes. Mounted under `/api/eval` from `http/server.ts`.
 *
 * Endpoints:
 *   - GET  /scenarios — list known eval scenarios (catalog metadata).
 *   - GET  /availability — { available: bool, reason?: string } so the
 *     UI can show a clear "in-app evals need dev mode" banner without
 *     trial-and-error spawning.
 *   - POST /run        — SSE-stream a trial. Body: { scenarioId, modelId,
 *     imageModelId?, timeoutMs? }. Events: spawned / log / done / error.
 *   - GET  /results    — list past trial outcomes from
 *     `<gezelHome>/eval-runs/`. Query: `scenario`, `limit`.
 */

import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { isEvalRunnerAvailable, listEvalResults, runEval } from '../../eval/runner.js';
import { EVAL_SCENARIOS, getScenarioManifest } from '../../eval/scenarios.js';
import type { ServiceContext } from '../context.js';

const RunRequestSchema = z.object({
  scenarioId: z.string().min(1),
  modelId: z.string().min(1),
  imageModelId: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

function evalRunsDir(ctx: ServiceContext): string {
  return join(ctx.home, 'eval-runs');
}

export function evalRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/scenarios', (c) => c.json({ scenarios: EVAL_SCENARIOS }));

  app.get('/availability', (c) =>
    c.json({
      available: isEvalRunnerAvailable(),
      reason: isEvalRunnerAvailable()
        ? null
        : 'eval harness not found on disk (packaged install). Run from the repo via `pnpm eval:run` for now.',
    }),
  );

  app.post('/run', async (c) => {
    const body = RunRequestSchema.parse(await c.req.json());
    const manifest = getScenarioManifest(body.scenarioId);
    if (!manifest) {
      return c.json({ error: `unknown scenarioId: ${body.scenarioId}` }, 404);
    }
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      c.req.raw.signal?.addEventListener('abort', () => ac.abort());

      // history: trial.started
      try {
        await ctx.history.log({
          kind: 'eval.trial.started',
          summary: `eval ${body.scenarioId} / ${body.modelId} started`,
          details: { ...body },
        });
      } catch {
        // history is best-effort; never block a run on it
      }

      const outcome = await runEval(
        {
          scenarioId: body.scenarioId,
          modelId: body.modelId,
          ...(body.imageModelId ? { imageModelId: body.imageModelId } : {}),
          ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        },
        {
          runsDir: evalRunsDir(ctx),
          signal: ac.signal,
          onEvent: async (event) => {
            await stream.writeSSE({ data: JSON.stringify(event) });
          },
        },
      );

      // history: trial.completed (or error)
      try {
        if (outcome) {
          await ctx.history.log({
            kind: 'eval.trial.completed',
            summary: `eval ${outcome.scenarioId}/${outcome.modelId} ${outcome.success ? 'PASSED' : 'FAILED'}`,
            details: { ...outcome },
          });
        }
      } catch {
        // history best-effort
      }
    });
  });

  app.get('/results', async (c) => {
    const scenario = c.req.query('scenario');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.max(1, Math.min(200, Number.parseInt(limitStr, 10))) : 50;
    const results = await listEvalResults({
      runsDir: evalRunsDir(ctx),
      limit,
      ...(scenario ? { scenarioId: scenario } : {}),
    });
    return c.json({ results });
  });

  return app;
}
