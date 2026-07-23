import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { KnownEnsureError } from '../../models/ensure.js';
import type { ServiceContext } from '../context.js';

const EnsureRequestSchema = z.object({
  model: z.string().min(1, 'model is required'),
});

/**
 * `/v1/models/ensure` — "make this local model downloaded and ready to
 * serve."
 *
 *   POST /v1/models/ensure                    Body: `{model: "<backend>:<id>"}`.
 *                                             Returns either
 *                                             `{status:'ready', model_id}` or
 *                                             `{status:'downloading',
 *                                              model_id, job_id}`.
 *
 *   GET  /v1/models/ensure/:jobId              Snapshot of an in-flight or
 *                                             recently-completed install job.
 *                                             `events[]` carries everything
 *                                             that's been published so far —
 *                                             useful for callers that prefer
 *                                             polling to SSE.
 *
 *   GET  /v1/models/ensure/:jobId/events       SSE: progress + terminal events
 *                                             for an in-flight install. Each
 *                                             frame is `data: <JSON>` where
 *                                             the payload is the same shape
 *                                             as the polled snapshot's
 *                                             `events[]` entries.
 *
 * Auth: mounted under `bearerAuth + requireScope('openai')` like the
 * rest of `/v1/*`.
 */
export function v1ModelsEnsureRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const parsed = EnsureRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.ensureModel.ensure(parsed.model);
      if (result.status === 'ready') {
        return c.json({ status: 'ready', model_id: result.modelId });
      }
      return c.json(
        {
          status: 'downloading',
          model_id: result.modelId,
          job_id: result.jobId,
        },
        202,
      );
    } catch (err) {
      if (err instanceof KnownEnsureError) {
        const status =
          err.code === 'unknown_model'
            ? 404
            : err.code === 'no_source_for_backend'
              ? 400
              : err.code === 'ambiguous_model'
                ? 400
                : 400;
        return c.json(
          { error: { message: err.message, type: 'invalid_request_error', code: err.code } },
          status,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: 'server_error', code: 'ensure_failed' } }, 500);
    }
  });

  app.get('/:jobId', (c) => {
    const snapshot = ctx.ensureModel.getJob(c.req.param('jobId'));
    if (!snapshot) {
      return c.json(
        {
          error: { message: 'job not found', type: 'invalid_request_error', code: 'job_not_found' },
        },
        404,
      );
    }
    return c.json({
      job_id: snapshot.jobId,
      model_id: snapshot.modelId,
      status: snapshot.status,
      started_at: snapshot.startedAt,
      events: snapshot.events,
    });
  });

  app.get('/:jobId/events', (c) => {
    const jobId = c.req.param('jobId');
    const snapshot = ctx.ensureModel.getJob(jobId);
    if (!snapshot) {
      return c.json(
        {
          error: { message: 'job not found', type: 'invalid_request_error', code: 'job_not_found' },
        },
        404,
      );
    }
    return streamSSE(c, async (stream) => {
      let closed = false;
      // The orchestrator replays buffered events synchronously on
      // subscribe so the SSE client sees the full history before live
      // events. We forward each into the stream.
      const unsubscribe = ctx.ensureModel.subscribeJob(jobId, (event) => {
        void stream
          .writeSSE({ data: JSON.stringify(event) })
          .then(() => {
            if (event.type === 'done' || event.type === 'error') {
              closed = true;
            }
          })
          .catch(() => {
            closed = true;
          });
      });

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      while (!closed) {
        await stream.sleep(1000);
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          closed = true;
        }
      }
      unsubscribe();
    });
  });

  return app;
}
