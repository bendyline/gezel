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

import { totalmem } from 'node:os';
import { Hono } from 'hono';
import { defaultCacheBudgetMb } from '../../cache/budget.js';
import type { ServiceContext } from '../context.js';
import { usesMachineEngine } from './machine-engine-proxy.js';
import { sanitizeBrokerCacheStats } from './queues.js';

export function cacheRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/stats', async (c) => {
    if (usesMachineEngine(ctx)) {
      const upstream = await ctx.machineEngine!.proxy(
        c.req.raw,
        '/api/cache',
        '/v1/remote/manage/cache',
      );
      if (!upstream.ok) return upstream;
      const payload = await upstream.json().catch(() => null);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return c.json({ error: 'invalid_machine_cache_response' }, 502);
      }
      const providers = Array.isArray((payload as { providers?: unknown }).providers)
        ? sanitizeBrokerCacheStats((payload as { providers: unknown[] }).providers)
        : [];
      return c.json({ ...(payload as Record<string, unknown>), providers });
    }
    // Surface the RAM-aware suggestion + system memory alongside each
    // engine's live stats so the Settings slider can mark the auto
    // default and bound its track to physical RAM. Computed here at the
    // HTTP boundary (where we have `os`) to keep the controller pure.
    const systemRamBytes = totalmem();
    const defaultBudgetBytes = defaultCacheBudgetMb(systemRamBytes) * 1024 * 1024;
    const providers = ctx.chat
      .getCacheStats()
      .map((p) => ({ ...p, defaultBudgetBytes, systemRamBytes }));
    return c.json({ providers });
  });

  app.post('/evict', async (c) => {
    if (usesMachineEngine(ctx)) {
      // Session ids are user-owned here. The dedicated remote endpoint
      // namespaces the id using the authenticated broker tenant before it
      // reaches the engine cache controller.
      return ctx.machineEngine!.proxy(c.req.raw, '/api/cache/evict', '/v1/remote/cache/evict');
    }
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
    if (!sessionId) {
      return c.json({ error: 'body must include { sessionId: string }' }, 400);
    }
    ctx.chat.invalidateSessionCache(sessionId);
    return c.json({ ok: true, sessionId });
  });

  app.post('/clear', async (c) => {
    if (usesMachineEngine(ctx)) {
      return ctx.machineEngine!.proxy(c.req.raw, '/api/cache', '/v1/remote/manage/cache');
    }
    const body = (await c.req.json().catch(() => null)) as { provider?: unknown } | null;
    const provider = typeof body?.provider === 'string' ? body.provider : null;
    if (!provider) {
      return c.json({ error: 'body must include { provider: string }' }, 400);
    }
    ctx.chat.invalidateProviderCache(provider);
    return c.json({ ok: true, provider });
  });

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
