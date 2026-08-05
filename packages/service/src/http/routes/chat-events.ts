import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';

const log = createLogger('chat-events');

/**
 * Hono's SSE writer is stateful: two overlapping `writeSSE` calls can
 * interleave frame bytes or trip the stream's backpressure handling. Chat
 * events are published synchronously and local models can emit token + phase
 * events several times per second, so every route needs one ordered write
 * lane. Keep the helper transport-agnostic so the ordering contract is easy to
 * regression-test without booting a service.
 */
export function serializeSseWrites<T>(
  write: (frame: T) => Promise<void>,
): (frame: T) => Promise<void> {
  let tail = Promise.resolve();
  return (frame: T) => {
    const next = tail.then(() => write(frame));
    // Keep the lane usable long enough for the route's rejection handler to
    // close/unsubscribe it; callers still receive `next`'s original failure.
    tail = next.catch(() => undefined);
    return next;
  };
}

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
      let releaseClose: (() => void) | undefined;
      const closeSignal = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      let unsubscribe = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        releaseClose?.();
      };
      const write = serializeSseWrites((frame: { event?: string; data: string }) =>
        stream.writeSSE(frame),
      );
      unsubscribe = ctx.chatEvents.subscribe(key, (event) =>
        write({ data: JSON.stringify(event) })
          .then(() => {
            // This is a finite, single-turn stream. Return immediately after
            // the terminal frame so Chromium can reclaim the connection slot
            // before the next rapid send opens another session stream.
            if (event.type === 'done') close();
          })
          .catch(() => {
            // A write failure without a preceding abort means the socket died
            // under the client (daemon restart doesn't hit this path; a
            // dropped h2 connection or a vanished renderer does). Log it —
            // this is the server-side trace for a "network error" the
            // composer reports.
            if (!closed) log.info(`session=${key} stream write failed (client connection lost)`);
            close();
          }),
      );
      if (closed) unsubscribe();

      stream.onAbort(close);

      while (!closed) {
        await Promise.race([stream.sleep(1000), closeSignal]);
        if (closed) break;
        try {
          await write({ event: 'ping', data: '' });
        } catch {
          if (!closed) log.info(`session=${key} stream ping failed (client connection lost)`);
          close();
        }
      }
      close();
    });
  });

  app.get('/project', async (c) => {
    const projectId = c.req.query('project');
    if (!projectId) return c.json({ error: 'missing ?project=<id>' }, 400);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };
      const write = serializeSseWrites((frame: { event?: string; data: string }) =>
        stream.writeSSE(frame),
      );
      unsubscribe = ctx.chatEvents.subscribeProject(projectId, (envelope) =>
        write({ data: JSON.stringify(envelope) }).catch(() => close()),
      );

      stream.onAbort(close);

      while (!closed) {
        await stream.sleep(1000);
        if (closed) break;
        try {
          await write({ event: 'ping', data: '' });
        } catch {
          log.debug(`project=${projectId} envelope stream ping failed (client connection lost)`);
          close();
        }
      }
      close();
    });
  });

  app.get('/gezel', async (c) => {
    const gezelId = c.req.query('gezel');
    if (!gezelId) return c.json({ error: 'missing ?gezel=<id>' }, 400);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };
      const write = serializeSseWrites((frame: { event?: string; data: string }) =>
        stream.writeSSE(frame),
      );
      unsubscribe = ctx.chatEvents.subscribeGezel(gezelId, (envelope) =>
        write({ data: JSON.stringify(envelope) }).catch(() => close()),
      );

      stream.onAbort(close);

      while (!closed) {
        await stream.sleep(1000);
        if (closed) break;
        try {
          await write({ event: 'ping', data: '' });
        } catch {
          log.debug(`gezel=${gezelId} envelope stream ping failed (client connection lost)`);
          close();
        }
      }
      close();
    });
  });

  app.get('/all', async (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
      };
      const write = serializeSseWrites((frame: { event?: string; data: string }) =>
        stream.writeSSE(frame),
      );
      unsubscribe = ctx.chatEvents.subscribeAll((envelope) =>
        write({ data: JSON.stringify(envelope) }).catch(() => close()),
      );

      stream.onAbort(close);

      while (!closed) {
        await stream.sleep(1000);
        if (closed) break;
        try {
          await write({ event: 'ping', data: '' });
        } catch {
          log.debug('global envelope stream ping failed (client connection lost)');
          close();
        }
      }
      close();
    });
  });

  return app;
}
