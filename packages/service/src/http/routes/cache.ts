import { engineCacheRoutes } from './engine-cache.js';
/**
 * /api/cache — operator surface for the prompt-cache controller.
 *
 * Three endpoints:
 *
 *   GET  /api/cache/stats          → ProviderCacheStats[] (one per registered engine)
 *   POST /api/cache/evict          → drop a single session's cache (body: { sessionId })
 *   POST /api/cache/clear          → drop everything for a provider (body: { provider })
 *
 * Stats double as the data source for the EngineStatusPill popover —
 * already wired in there via the `/api/queues` extension. The dedicated
 * /api/cache surface exists for explicit operator workflows: "I want
 * to see what's warm right now" via curl, and "the engine is
 * misbehaving, drop everything" via Settings.
 */

import { Hono } from 'hono';

import type { ServiceContext } from '../context.js';

export function cacheRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.route('/', engineCacheRoutes(ctx));

  /**
   * Phase 4: pre-warm a session's prompt cache. Fires on UI session
   * open so the first message returns near-instantly instead of
   * paying full prefill. Returns 202 Accepted regardless of engine
   * outcome — warming is best-effort and we don't want the UI to
   * block on it.
   */
  app.post('/warm', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
    if (!sessionId) {
      return c.json({ error: 'body must include { sessionId: string }' }, 400);
    }
    // This always begins in the user daemon because only it can resolve the
    // persisted session, prompt bands, transcript, and tool surface. A remote
    // session forwards that prepared payload to the broker's inference-only
    // warm endpoint; an in-process native session uses its local adapter.
    // Don't await — fire-and-forget so the HTTP response returns fast.
    void ctx.chat.prewarmSession(sessionId);
    return c.json({ ok: true, sessionId }, 202);
  });

  return app;
}
