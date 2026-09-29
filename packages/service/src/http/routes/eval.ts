/**
 * Eval routes, mounted under `/api/eval` from `http/server.ts`.
 *
 *   GET  /catalog              harness registry: scenarios, suites, providers (`?refresh=1`)
 *   GET  /targets              runnable (provider, model) pairs + image models + environment
 *   GET  /jobs                 recent jobs, newest first
 *   POST /jobs                 queue a job (EvalJobSpec) → EvalJob
 *   GET  /jobs/:id             one job
 *   POST /jobs/:id/cancel      stop a queued or running job
 *   GET  /jobs/:id/stream      SSE: snapshot, then live log lines and job updates
 *   GET  /trials               indexed trials (`?scenario=&model=&provider=&job=&limit=`)
 *   GET  /trials/:id           one trial: rubric, postmortem, log tail, artifacts
 *
 * Deprecated, kept for published-client compatibility (`@bendyline/gezel-client`
 * `listEvalScenarios`, `getEvalAvailability`, `listEvalResults`, `runEval`):
 *   GET /scenarios, GET /availability, GET /results, POST /run.
 */

import {
  type EvalCatalog,
  type EvalJob,
  EvalJobSpecSchema,
  type EvalJobStreamEvent,
  type EvalTrialSummary,
} from '@bendyline/gezel/eval';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { EvalService } from '../../eval/service.js';
import type { ServiceContext } from '../context.js';

const TRIAL_LIST_MAX = 2000;
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
/** Idle SSE streams still write something this often (proxies, sleep-throttled timers). */
const KEEPALIVE_MS = 15_000;

/** Sleep that a subscriber callback can cut short. */
function createWaker(): { wake: () => void; sleep: (ms: number) => Promise<void> } {
  let pending: (() => void) | null = null;
  return {
    wake: () => pending?.(),
    sleep: (ms) =>
      new Promise<void>((resolveSleep) => {
        const done = () => {
          clearTimeout(timer);
          pending = null;
          resolveSleep();
        };
        const timer = setTimeout(done, ms);
        pending = done;
      }),
  };
}

/** Every id in a job spec must name something the harness can actually run. */
function validateSpecAgainstCatalog(
  spec: z.infer<typeof EvalJobSpecSchema>,
  catalog: EvalCatalog,
): string | null {
  const scenarioIds = new Set(catalog.scenarios.map((s) => s.id));
  if (spec.suiteId) {
    const suite = catalog.suites.find((s) => s.id === spec.suiteId);
    if (!suite) return `unknown suite: ${spec.suiteId}`;
    const members = new Set(suite.scenarioIds);
    const outside = (spec.scenarioIds ?? []).filter((id) => !members.has(id));
    if (outside.length > 0) return `not in suite "${suite.id}": ${outside.join(', ')}`;
  }
  const unknown = (spec.scenarioIds ?? []).filter((id) => !scenarioIds.has(id));
  if (unknown.length > 0) return `unknown scenarios: ${unknown.join(', ')}`;
  return null;
}

async function requireService(ctx: ServiceContext): Promise<EvalService> {
  await ctx.evals.jobs.init();
  return ctx.evals;
}

export function evalRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/catalog', async (c) => {
    try {
      const catalog = await ctx.evals.catalog.get({ refresh: c.req.query('refresh') === '1' });
      return c.json(catalog);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.get('/targets', async (c) => {
    try {
      const [targets, imageModels, environment] = await Promise.all([
        ctx.evals.targets.list(),
        ctx.evals.targets.imageModels(),
        ctx.evals.targets.environment(),
      ]);
      return c.json({ targets, imageModels, environment });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.get('/jobs', async (c) => {
    const evals = await requireService(ctx);
    return c.json({ jobs: await evals.jobs.list() });
  });

  app.post('/jobs', async (c) => {
    const parsed = EvalJobSpecSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    }
    const evals = await requireService(ctx);
    let catalog: EvalCatalog;
    try {
      catalog = await evals.catalog.get();
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
    const invalid = validateSpecAgainstCatalog(parsed.data, catalog);
    if (invalid) return c.json({ error: invalid }, 400);
    try {
      return c.json(await evals.jobs.create(parsed.data), 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.get('/jobs/:id', async (c) => {
    const job = await (await requireService(ctx)).jobs.get(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404);
  });

  app.post('/jobs/:id/cancel', async (c) => {
    const job = await (await requireService(ctx)).jobs.cancel(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404);
  });

  app.get('/jobs/:id/stream', async (c) => {
    const evals = await requireService(ctx);
    const id = c.req.param('id');
    if (!(await evals.jobs.get(id))) return c.json({ error: 'job not found' }, 404);
    return streamSSE(c, async (stream) => {
      const queue: EvalJobStreamEvent[] = [];
      const waker = createWaker();
      let closed = false;
      const close = () => {
        closed = true;
        waker.wake();
      };
      stream.onAbort(close);
      c.req.raw.signal?.addEventListener('abort', close);
      const unsubscribe = evals.jobs.subscribe(id, (event) => {
        queue.push(event);
        waker.wake();
      });
      try {
        let ended = false;
        while (!closed && !ended) {
          while (queue.length > 0) {
            const event = queue.shift();
            if (!event) continue;
            await stream.writeSSE({ data: JSON.stringify(event) });
            // A finished job has nothing more to say; end the stream after it.
            if (event.type !== 'log' && TERMINAL_JOB_STATUSES.has(event.job.status)) ended = true;
          }
          if (ended) break;
          await waker.sleep(KEEPALIVE_MS);
          if (!closed && queue.length === 0) await stream.write(': keepalive\n\n');
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.get('/trials', async (c) => {
    const evals = await requireService(ctx);
    const scenario = c.req.query('scenario');
    const model = c.req.query('model');
    const provider = c.req.query('provider');
    const job = c.req.query('job');
    const limitStr = c.req.query('limit');
    const limit = limitStr
      ? Math.max(1, Math.min(TRIAL_LIST_MAX, Number.parseInt(limitStr, 10) || 1))
      : 500;
    const all = (await evals.results.list()).map((entry) => entry.summary);
    const filtered = all.filter(
      (t) =>
        (!scenario || t.scenarioId === scenario) &&
        (!model || t.modelId === model) &&
        (!provider || t.provider === provider) &&
        (!job || t.jobId === job),
    );
    return c.json({ trials: filtered.slice(0, limit), total: filtered.length });
  });

  app.get('/trials/:id', async (c) => {
    const detail = await (await requireService(ctx)).results.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'trial not found' }, 404);
  });

  // ── Deprecated compatibility surface ────────────────────────────────

  app.get('/availability', (c) => {
    const available = ctx.evals.harness() !== null;
    return c.json({
      available,
      reason: available ? null : 'This install is missing its eval harness; reinstall gezel.',
    });
  });

  app.get('/scenarios', async (c) => {
    try {
      const catalog = await ctx.evals.catalog.get();
      const defaultModel =
        catalog.providers.find((p) => p.id === catalog.defaultProvider)?.defaultModelId ?? '';
      return c.json({
        scenarios: catalog.scenarios
          .filter((s) => s.kind === 'scenario')
          .map((s) => ({
            id: s.id,
            name: s.id,
            description: s.description,
            capabilityAxis: s.suites.join(', '),
            defaultModel,
            ...(s.defaultImageModelId ? { defaultImageModel: s.defaultImageModelId } : {}),
            timeoutMs: s.timeoutMs,
            anchored: s.anchored,
          })),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.get('/results', async (c) => {
    const evals = await requireService(ctx);
    const scenario = c.req.query('scenario');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? Math.max(1, Math.min(200, Number.parseInt(limitStr, 10) || 1)) : 50;
    const results = (await evals.results.list())
      .map((entry) => entry.summary)
      .filter((t) => t.success !== undefined && (!scenario || t.scenarioId === scenario))
      .slice(0, limit)
      .map(legacyOutcome);
    return c.json({ results });
  });

  const RunRequestSchema = z.object({
    scenarioId: z.string().min(1),
    modelId: z.string().min(1),
    imageModelId: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  });

  /** One scenario, one trial, streamed in the old event shape. */
  app.post('/run', async (c) => {
    const body = RunRequestSchema.parse(await c.req.json());
    const evals = await requireService(ctx);
    const [catalog, targets] = await Promise.all([evals.catalog.get(), evals.targets.list()]);
    if (!catalog.scenarios.some((s) => s.id === body.scenarioId)) {
      return c.json({ error: `unknown scenarioId: ${body.scenarioId}` }, 404);
    }
    const target =
      targets.find(
        (t) => t.available && t.modelId === body.modelId && t.provider === catalog.defaultProvider,
      ) ?? targets.find((t) => t.available && t.modelId === body.modelId);
    const job = await evals.jobs.create({
      scenarioIds: [body.scenarioId],
      count: 1,
      targets: [
        {
          provider: target?.provider ?? catalog.defaultProvider,
          modelId: body.modelId,
        },
      ],
      ...(body.imageModelId ? { imageModelId: body.imageModelId } : {}),
      ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
    });
    return streamSSE(c, async (stream) => {
      let spawned = false;
      let finished: EvalJob | null = null;
      const waker = createWaker();
      const pending: string[] = [];
      const unsubscribe = evals.jobs.subscribe(job.id, (event) => {
        if (event.type === 'log') pending.push(JSON.stringify({ type: 'log', line: event.line }));
        const current = event.type === 'log' ? null : event.job;
        const trial = current?.targets[0]?.currentTrial;
        if (trial && !spawned) {
          spawned = true;
          pending.push(JSON.stringify({ type: 'spawned', trialId: trial.trialId }));
        }
        if (current && TERMINAL_JOB_STATUSES.has(current.status)) {
          finished = current;
        }
        waker.wake();
      });
      c.req.raw.signal?.addEventListener('abort', () => void evals.jobs.cancel(job.id));
      try {
        while (true) {
          while (pending.length > 0) await stream.writeSSE({ data: pending.shift() ?? '' });
          if (finished) break;
          await waker.sleep(KEEPALIVE_MS);
        }
        const done = finished as EvalJob | null;
        const trial = (await evals.results.list())
          .map((entry) => entry.summary)
          .find((t) => t.jobId === job.id && t.success !== undefined);
        if (trial) {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'done', result: legacyOutcome(trial) }),
          });
        } else {
          const error =
            done?.error ?? done?.targets[0]?.error ?? 'the trial did not produce a result';
          await stream.writeSSE({ data: JSON.stringify({ type: 'error', error }) });
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  return app;
}

function legacyOutcome(trial: EvalTrialSummary) {
  return {
    trialId: trial.trialId,
    scenarioId: trial.scenarioId,
    modelId: trial.modelId,
    startedAt: trial.startedAt,
    finishedAt: trial.finishedAt ?? trial.startedAt,
    durationMs: trial.durationMs ?? 0,
    success: trial.success === true,
    reason: trial.reason ?? '',
    ...(trial.failureMode ? { failureMode: trial.failureMode } : {}),
    runDir: trial.runDir,
  };
}
