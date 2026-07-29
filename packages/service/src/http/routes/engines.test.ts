import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeEngineStatusResponseSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { NATIVE_ENGINE_RELEASE } from '../../engines/native-manifest.js';
import { enginesRoutes } from './engines.js';

function makeApp(
  chat: {
    engineStatus: () => Promise<unknown>;
    reconcileEnginePool: (provider: string, target: Record<string, number>) => Promise<void>;
  },
  extras: Record<string, unknown> = {},
): Hono {
  const app = new Hono();
  // Construct just enough of ServiceContext to wire the routes.
  const ctx = { chat, ...extras } as unknown as Parameters<typeof enginesRoutes>[0];
  app.route('/api/engines', enginesRoutes(ctx));
  return app;
}

describe('engines routes', () => {
  it('GET /binaries/status reports the pinned release and live executable paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-engine-status-'));
    const uvPath = join(dir, process.platform === 'win32' ? 'uv.exe' : 'uv');
    const prior = process.env.GEZEL_UV_BIN;
    await writeFile(uvPath, 'uv');
    process.env.GEZEL_UV_BIN = uvPath;
    try {
      const app = makeApp({
        engineStatus: async () => null,
        reconcileEnginePool: async () => {},
      });
      const res = await app.request('/api/engines/binaries/status');
      expect(res.status).toBe(200);
      const body = NativeEngineStatusResponseSchema.parse(await res.json());
      expect(body.release).toBe(NATIVE_ENGINE_RELEASE);
      expect(body.pinned).toBe(true);
      expect(body.engines.find((engine) => engine.name === 'uv')).toMatchObject({
        installed: true,
        path: uvPath,
      });
    } finally {
      if (prior === undefined) delete process.env.GEZEL_UV_BIN;
      else process.env.GEZEL_UV_BIN = prior;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshes a cached native consumer before reporting the install complete', async () => {
    let recognitionResets = 0;
    const app = makeApp(
      {
        engineStatus: async () => null,
        reconcileEnginePool: async () => {},
      },
      {
        engineBinaries: {
          ensure: () => ({
            key: 'llama-server:cuda',
            snapshot: {},
            alreadyRunning: false,
          }),
          get: () => ({ engine: 'llama-server' }),
          subscribe: (
            _key: string,
            listener: (event: {
              type: 'done';
              binPath: string;
              cached: boolean;
            }) => void,
          ) => {
            queueMicrotask(() =>
              listener({
                type: 'done',
                binPath: '/engines/llama-server',
                cached: false,
              }),
            );
            return () => {};
          },
        },
        recognition: {
          reset: async () => {
            recognitionResets += 1;
          },
        },
        imageProvider: { reset: async () => {} },
        stt: { reset: async () => {} },
      },
    );

    const res = await app.request('/api/engines/binaries/llama-server/ensure?variant=cuda', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"type":"done"');
    expect(recognitionResets).toBe(1);
  });

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
