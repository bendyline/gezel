import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';

/**
 * Routes for the system-toolset bootstrap:
 *
 *   GET  /api/system-toolsets/status           — current status snapshot
 *   GET  /api/system-toolsets/status/stream    — SSE stream of transitions
 *
 * The UI's Home screen HealthPanel polls `/status` once on mount, then
 * subscribes to `/status/stream` for subsequent transitions.
 */
export function systemToolsetRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/status', (c) => c.json(ctx.systemStatus.current));

  app.get('/status/stream', async (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.systemStatus.subscribe((status) => {
        if (closed) return;
        void stream.writeSSE({ data: JSON.stringify(status) }).catch(() => {
          /* stream closed */
        });
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(5000);
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
