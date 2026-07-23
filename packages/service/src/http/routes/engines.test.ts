import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { enginesRoutes } from './engines.js';

function makeApp(chat: {
  engineStatus: () => Promise<unknown>;
  reconcileEnginePool: (provider: string, target: Record<string, number>) => Promise<void>;
}): Hono {
  const app = new Hono();
  // Construct just enough of ServiceContext to wire the routes.
  const ctx = { chat } as unknown as Parameters<typeof enginesRoutes>[0];
  app.route('/api/engines', enginesRoutes(ctx));
  return app;
}

describe('engines routes', () => {
  it('GET /status returns the chat manager snapshot', async () => {
    const app = makeApp({
      engineStatus: async () => ({
        enforced: true,
        budgetBytes: 32 * 1024 ** 3,
        committedBytes: 10 * 1024 ** 3,
        entries: [{ key: 'mlx:gemma4-26b:0', residentBytes: 10 * 1024 ** 3 }],
      }),
      reconcileEnginePool: async () => {
        throw new Error('not called');
      },
    });
    const res = await app.request('/api/engines/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { committedBytes: number; entries: unknown[] };
    expect(body.committedBytes).toBe(10 * 1024 ** 3);
    expect(body.entries).toHaveLength(1);
  });

  it('GET /status falls through to enforced:false when no router', async () => {
    const app = makeApp({
      engineStatus: async () => null,
      reconcileEnginePool: async () => {},
    });
    const res = await app.request('/api/engines/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enforced: boolean; entries: unknown[] };
    expect(body.enforced).toBe(false);
    expect(body.entries).toEqual([]);
  });

  it('POST /reconcile rejects an invalid provider', async () => {
    const app = makeApp({
      engineStatus: async () => null,
      reconcileEnginePool: async () => {
        throw new Error('not called');
      },
    });
    const res = await app.request('/api/engines/reconcile', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openai', clones: { foo: 1 } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /reconcile rejects when clones is missing', async () => {
    const app = makeApp({
      engineStatus: async () => null,
      reconcileEnginePool: async () => {},
    });
    const res = await app.request('/api/engines/reconcile', {
      method: 'POST',
      body: JSON.stringify({ provider: 'mlx' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /reconcile drops out-of-range clone values silently', async () => {
    let captured: Record<string, number> | undefined;
    const app = makeApp({
      engineStatus: async () => ({
        enforced: true,
        budgetBytes: 0,
        committedBytes: 0,
        entries: [],
      }),
      reconcileEnginePool: async (_p, target) => {
        captured = target;
      },
    });
    const res = await app.request('/api/engines/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'mlx',
        clones: {
          ok: 2,
          negative: -1,
          tooMany: 99,
          notInteger: 1.5,
          string: 'a',
        },
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ ok: 2 });
  });

  it('POST /reconcile forwards a valid request and returns the updated snapshot', async () => {
    let captured: { provider: string; target: Record<string, number> } | undefined;
    const app = makeApp({
      engineStatus: async () => ({
        enforced: true,
        budgetBytes: 64 * 1024 ** 3,
        committedBytes: 20 * 1024 ** 3,
        entries: [{ key: 'mlx:gemma4-26b:0', residentBytes: 20 * 1024 ** 3 }],
      }),
      reconcileEnginePool: async (provider, target) => {
        captured = { provider, target };
      },
    });
    const res = await app.request('/api/engines/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'mlx',
        clones: { 'gemma4-26b': 2, 'qwen3.6': 1 },
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: { committedBytes: number } };
    expect(body.ok).toBe(true);
    expect(body.status.committedBytes).toBe(20 * 1024 ** 3);
    expect(captured).toEqual({
      provider: 'mlx',
      target: { 'gemma4-26b': 2, 'qwen3.6': 1 },
    });
  });
});
