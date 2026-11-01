import type { AppEnsureEvent, ImageModelPullEvent } from '@bendyline/gezel';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  ActiveImagePull,
  ImageModelPullRegistry,
} from '../../providers/image/pull-registry.js';

function apiError(code: string, message: string) {
  return { error: { message, type: 'invalid_request_error', code } };
}

function ensureEvent(
  jobId: string,
  event: ImageModelPullEvent,
  totalBytes: number,
  qualified: (id: string) => string,
): AppEnsureEvent {
  const job = { jobId, modelId: qualified(jobId) };
  switch (event.type) {
    case 'progress':
      return {
        ...job,
        type: 'progress',
        bytesWritten: event.bytesWritten,
        totalBytes: event.totalBytes ?? totalBytes,
      };
    case 'retrying':
      return {
        ...job,
        type: 'retrying',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    case 'error':
      return { ...job, type: 'error', error: event.error };
    case 'done':
      return { ...job, type: 'done' };
  }
}

function pullStatus(pull: ActiveImagePull): 'running' | 'done' | 'error' {
  if (!pull.finished) return 'running';
  return pull.error ? 'error' : 'done';
}

/** One resumable download protocol, with separate registries for models and styles. */
export function registerImageEnsureRoutes(
  app: Hono,
  prefix: string,
  pulls: ImageModelPullRegistry,
  qualified: (id: string) => string,
): void {
  app.get(`${prefix}/:jobId`, (c) => {
    const pull = pulls.get(c.req.param('jobId'));
    if (!pull) return c.json(apiError('job_not_found', 'job not found'), 404);
    return c.json({
      job_id: pull.id,
      model_id: qualified(pull.id),
      status: pullStatus(pull),
      started_at: Date.parse(pull.startedAt),
      bytes_written: pull.bytesWritten,
      total_bytes: pull.totalBytes,
      ...(pull.error ? { error: pull.error } : {}),
    });
  });

  app.get(`${prefix}/:jobId/events`, (c) => {
    const jobId = c.req.param('jobId');
    const snapshot = pulls.get(jobId);
    if (!snapshot) return c.json(apiError('job_not_found', 'job not found'), 404);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let sawError = false;
      const unsubscribe = pulls.subscribe(jobId, (event) => {
        // A failed pull ends with an error and then its done; the error is terminal.
        if (sawError) return;
        if (event.type === 'error') sawError = true;
        const terminal = event.type === 'done' || event.type === 'error';
        void stream
          .writeSSE({
            data: JSON.stringify(ensureEvent(jobId, event, snapshot.totalBytes, qualified)),
          })
          .then(() => {
            if (terminal) closed = true;
          })
          .catch(() => {
            closed = true;
          });
      });
      if (!unsubscribe) return;
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

  app.delete(`${prefix}/:jobId`, (c) => {
    if (!pulls.cancel(c.req.param('jobId'))) {
      return c.json(apiError('job_not_found', 'No download in progress for that job'), 404);
    }
    return c.json({ cancelled: true });
  });
}
