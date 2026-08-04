import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { cacheRoutes } from './cache.js';

function context(chat: Record<string, unknown>): ServiceContext {
  return { chat } as unknown as ServiceContext;
}

function adoptBroker(
  ctx: ServiceContext,
  proxy: NonNullable<ServiceContext['machineEngine']>['proxy'],
): void {
  ctx.machineEngine = {
    isConnected: () => true,
    isRequired: () => true,
    proxy,
    stop: async () => {},
  };
}

describe('/api/cache split ownership', () => {
  it('reads broker stats and translates tenant-namespaced session ids', async () => {
    const ctx = context({
      getCacheStats: () => {
        throw new Error('user-daemon cache stats must not win after adoption');
      },
    });
    adoptBroker(ctx, async (_request, source, target) => {
      expect([source, target]).toEqual(['/api/cache', '/v1/remote/manage/cache']);
      return Response.json({
        providers: [
          {
            providerName: 'mlx',
            warmSessionCount: 1,
            sessions: [
              {
                sessionId: 'dev:machine-engine-client:session-a',
                gezelId: 'dev:machine-engine-client:gezel-a',
              },
            ],
          },
        ],
      });
    });

    const response = await cacheRoutes(ctx).request('/stats');
    const body = (await response.json()) as {
      providers: Array<{ sessions: Array<{ sessionId: string; gezelId?: string }> }>;
    };
    expect(body.providers[0]?.sessions[0]).toMatchObject({
      sessionId: 'session-a',
      gezelId: 'gezel-a',
    });
  });

  it('keeps warm local so the user daemon prepares the remote payload', async () => {
    const warmed: string[] = [];
    const ctx = context({
      prewarmSession: async (sessionId: string) => {
        warmed.push(sessionId);
      },
    });
    adoptBroker(ctx, async () => {
      throw new Error('warm must not wholesale-proxy');
    });

    const response = await cacheRoutes(ctx).request('/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    });
    expect(response.status).toBe(202);
    expect(warmed).toEqual(['session-a']);
  });

  it('routes provider-wide clear to broker ownership', async () => {
    const ctx = context({
      invalidateProviderCache: () => {
        throw new Error('must not clear the retired local controller');
      },
    });
    let body = '';
    adoptBroker(ctx, async (request, source, target) => {
      body = await request.text();
      expect([source, target]).toEqual(['/api/cache', '/v1/remote/manage/cache']);
      return Response.json({ ok: true, provider: 'mlx' });
    });

    const response = await cacheRoutes(ctx).request('/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mlx' }),
    });
    expect(response.status).toBe(200);
    expect(body).toBe('{"provider":"mlx"}');
  });

  it('routes session eviction through the tenant-aware remote endpoint', async () => {
    const ctx = context({
      invalidateSessionCache: () => {
        throw new Error('raw user id must not be applied to the broker controller');
      },
    });
    let body = '';
    adoptBroker(ctx, async (request, source, target) => {
      body = await request.text();
      expect([source, target]).toEqual(['/api/cache/evict', '/v1/remote/cache/evict']);
      return Response.json({ ok: true, sessionId: 'session-a' });
    });

    const response = await cacheRoutes(ctx).request('/evict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    });
    expect(response.status).toBe(200);
    expect(body).toBe('{"sessionId":"session-a"}');
  });

  it('retains all cache operations locally without an adopted broker', async () => {
    const calls: string[] = [];
    const ctx = context({
      getCacheStats: () => [],
      invalidateSessionCache: (id: string) => calls.push(`evict:${id}`),
      invalidateProviderCache: (name: string) => calls.push(`clear:${name}`),
      prewarmSession: async (id: string) => calls.push(`warm:${id}`),
    });

    expect((await cacheRoutes(ctx).request('/stats')).status).toBe(200);
    await cacheRoutes(ctx).request('/evict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's' }),
    });
    await cacheRoutes(ctx).request('/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mlx' }),
    });
    await cacheRoutes(ctx).request('/warm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's' }),
    });

    expect(calls).toEqual(['evict:s', 'clear:mlx', 'warm:s']);
  });
});
