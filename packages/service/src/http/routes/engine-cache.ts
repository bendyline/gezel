import { totalmem } from 'node:os';
import { Hono } from 'hono';
import { defaultCacheBudgetMb } from '../../cache/budget.js';
import type { EngineContext } from '../engine-context.js';
import { sanitizeBrokerCacheStats } from './engine-queues.js';
import { usesMachineEngine } from './machine-engine-proxy.js';

export function engineCacheRoutes(ctx: EngineContext): Hono {
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
  return app;
}
