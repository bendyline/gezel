import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';

/**
 * Chat event SSE endpoints.
 *
 *   GET /events/chat?session=<id>            — bare ChatEvent for a single
 *                                              session (terminates on `done`).
 *   GET /events/chat?gezel=&project=         — back-compat: resolves to the
 *                                              most recent session for that
 *                                              (gezel, project) pair.
 *   GET /events/chat/project?project=<id>    — ChatEventEnvelope for every
 *                                              session in a project. Lives
 *                                              forever; used by the
 *                                              interleaved project timeline.
 *   GET /events/chat/all                     — ChatEventEnvelope for every
 *                                              session anywhere. Used by the
 *                                              global Meester timeline.
 */
export function chatEventsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    let sessionId = c.req.query('session');
    if (!sessionId) {
      const gezelId = c.req.query('gezel');
      const projectId = c.req.query('project') ?? 'default';
      if (!gezelId) return c.json({ error: 'missing ?session=<id> or ?gezel=<id>' }, 400);
      const sessions = await ctx.chat.listSessions({ gezelId, projectId });
      const active = sessions.find((s) => !s.archived);
      if (!active) return c.json({ error: 'no active session' }, 404);
      sessionId = active.id;
    }

    const key = sessionId;
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.chatEvents.subscribe(key, async (event) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(event) });
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

  app.get('/project', async (c) => {
    const projectId = c.req.query('project');
    if (!projectId) return c.json({ error: 'missing ?project=<id>' }, 400);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.chatEvents.subscribeProject(projectId, async (envelope) => {
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

  app.get('/gezel', async (c) => {
    const gezelId = c.req.query('gezel');
    if (!gezelId) return c.json({ error: 'missing ?gezel=<id>' }, 400);
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.chatEvents.subscribeGezel(gezelId, async (envelope) => {
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

  app.get('/all', async (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.chatEvents.subscribeAll(async (envelope) => {
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

  return app;
}
