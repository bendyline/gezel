import {
  type ListTerminalThreadsResponse,
  type RunTerminalCommandRequest,
  RunTerminalCommandRequestSchema,
  type RunTerminalCommandResponse,
  type TerminalThread,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';

/**
 * Per-project terminal thread routes. Mounted at `/api/projects` so the
 * route patterns nest under `/:id/terminals/*`, matching the other
 * project-scoped route files.
 *
 *   GET    /:id/terminals           → list threads (summaries) for the project.
 *   GET    /:id/terminals/events    → SSE: TerminalEventEnvelope for every
 *                                      output / command emitted in this
 *                                      project. Lives forever.
 *   GET    /:id/terminals/:threadId → full thread (messages) for replay.
 *   POST   /:id/terminals/run       → run a command — returns
 *                                      { threadId, runId } immediately
 *                                      (202); output streams via the SSE
 *                                      events endpoint above.
 *   DELETE /:id/terminals/:threadId → soft-delete (archive).
 *
 * The events route lives next to the data routes (rather than under
 * `/events/*`) so the UI's project chat surface only needs one mount
 * prefix to read everything it cares about.
 */
export function terminalRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/terminals', async (c) => {
    const projectId = c.req.param('id');
    const summaries = await ctx.store.listTerminalThreads(projectId);
    const response: ListTerminalThreadsResponse = { threads: summaries };
    return c.json(response);
  });

  app.get('/:id/terminals/events', async (c) => {
    const projectId = c.req.param('id');
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.terminalEvents.subscribeProject(projectId, async (envelope) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(envelope) });
        } catch {
          /* stream closed */
        }
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

  app.get('/:id/terminals/:threadId', async (c) => {
    const projectId = c.req.param('id');
    const threadId = c.req.param('threadId');
    const thread = await ctx.store.getTerminalThread(projectId, threadId);
    if (!thread) return c.json({ error: 'not found' }, 404);
    return c.json(thread satisfies TerminalThread);
  });

  app.post('/:id/terminals/run', async (c) => {
    const projectId = c.req.param('id');
    let body: RunTerminalCommandRequest;
    try {
      body = RunTerminalCommandRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: 'invalid body', detail: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    const outcome = await ctx.terminals.enqueueRun(projectId, body.workingDir, body.input);
    if (outcome.resolution.kind === 'empty') {
      return c.json({ error: 'empty input' }, 400);
    }
    if (outcome.resolution.kind === 'parseError') {
      return c.json({ error: 'parse error', detail: outcome.resolution.message }, 400);
    }
    const response: RunTerminalCommandResponse = {
      threadId: outcome.threadId,
      runId: outcome.runId,
    };
    return c.json(response, 202);
  });

  app.post('/:id/terminals/runs/:runId/cancel', (c) => {
    const runId = c.req.param('runId');
    const cancelled = ctx.terminals.cancelRun(runId);
    if (!cancelled) {
      // Already complete or never existed — idempotent 404 so a
      // double-click on Stop or a stale UI doesn't error.
      return c.json({ error: 'run not active' }, 404);
    }
    return c.body(null, 204);
  });

  app.post('/:id/terminals/runs/:runId/input', async (c) => {
    const runId = c.req.param('runId');
    let body: { text: string };
    try {
      const parsed = await c.req.json();
      if (typeof parsed?.text !== 'string') {
        return c.json({ error: 'body must be { text: string }' }, 400);
      }
      body = { text: parsed.text };
    } catch (err) {
      return c.json(
        { error: 'invalid body', detail: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    // Reject pathologically long inputs to avoid blowing up the
    // shell's stdin buffer. 4KB is well past any plausible password
    // / Y-N answer / npm-init field.
    if (body.text.length > 4096) {
      return c.json({ error: 'input too long (max 4096 chars)' }, 413);
    }
    const sent = ctx.terminals.sendInput(runId, body.text);
    if (!sent) {
      return c.json({ error: 'run not active' }, 404);
    }
    return c.body(null, 204);
  });

  app.delete('/:id/terminals/:threadId', async (c) => {
    const projectId = c.req.param('id');
    const threadId = c.req.param('threadId');
    await ctx.store.deleteTerminalThread(projectId, threadId);
    return c.json({ ok: true });
  });

  return app;
}
