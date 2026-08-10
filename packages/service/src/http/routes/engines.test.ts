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
    unloadIdleEngine?: (provider: string, modelId: string, replicaIdx: number) => Promise<boolean>;
    setLocalEngineMemoryBudget?: (bytes: number | null) => Promise<void>;
    setAllowRamSpillover?: (allow: boolean | null) => Promise<void>;
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

  it('POST /unload releases a specific idle model replica', async () => {
    const unloadCalls: Array<{ provider: string; modelId: string; replicaIdx: number }> = [];
    const app = makeApp({
      engineStatus: async () => null,
      reconcileEnginePool: async () => {},
      unloadIdleEngine: async (provider, modelId, replicaIdx) => {
        unloadCalls.push({ provider, modelId, replicaIdx });
        return true;
      },
    });
    const res = await app.request('/api/engines/unload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'llama-cpp', modelId: 'gemma4-4b-q4', replicaIdx: 0 }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(unloadCalls).toEqual([
      { provider: 'llama-cpp', modelId: 'gemma4-4b-q4', replicaIdx: 0 },
    ]);
  });

  it('reads and persists idle retention on the engine owner', async () => {
    let config: { localEngineIdleTimeoutMs?: number } = {};
    const resetCalls: Array<{ deferBusy?: boolean }> = [];
    const app = makeApp(
      {
        engineStatus: async () => null,
        reconcileEnginePool: async () => {},
        resetClient: async (opts: { deferBusy?: boolean }) => {
          resetCalls.push(opts);
        },
      } as Parameters<typeof makeApp>[0],
      {
        store: {
          readConfig: async () => config,
          writeConfig: async (patch: { localEngineIdleTimeoutMs: number }) => {
            config = { localEngineIdleTimeoutMs: patch.localEngineIdleTimeoutMs };
            return config;
          },
        },
      },
    );

    const initial = await app.request('/api/engines/retention');
    await expect(initial.json()).resolves.toEqual({ idleTimeoutMs: 300_000 });

    const update = await app.request('/api/engines/retention', {
      method: 'PUT',
      body: JSON.stringify({ idleTimeoutMs: 60_000 }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(update.json()).resolves.toEqual({ idleTimeoutMs: 60_000 });
    expect(config).toEqual({ localEngineIdleTimeoutMs: 60_000 });
    expect(resetCalls).toEqual([{ deferBusy: true }]);
  });

  it('persists memory policy on the engine owner and applies it live', async () => {
    const GiB = 1024 ** 3;
    let config: { localEngineMemoryGb?: number | null; allowRamSpillover?: boolean | null } = {};
    const budgetCalls: Array<number | null> = [];
    const spilloverCalls: Array<boolean | null> = [];
    const app = makeApp(
      {
        engineStatus: async () => null,
        reconcileEnginePool: async () => {},
        setLocalEngineMemoryBudget: async (bytes) => {
          budgetCalls.push(bytes);
        },
        setAllowRamSpillover: async (allow) => {
          spilloverCalls.push(allow);
        },
      },
      {
        store: {
          writeConfig: async (
            patch: Partial<{
              localEngineMemoryGb: number | null;
              allowRamSpillover: boolean | null;
            }>,
          ) => {
            config = { ...config, ...patch };
            return config;
          },
        },
      },
    );

    const budget = await app.request('/api/engines/memory-budget', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localEngineMemoryGb: 48 }),
    });
    expect(budget.status).toBe(200);
    await expect(budget.json()).resolves.toEqual({ localEngineMemoryGb: 48 });
    expect(budgetCalls).toEqual([48 * GiB]);
    expect(config.localEngineMemoryGb).toBe(48);

    const spillover = await app.request('/api/engines/ram-spillover', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowRamSpillover: true }),
    });
    expect(spillover.status).toBe(200);
    await expect(spillover.json()).resolves.toEqual({ allowRamSpillover: true });
    expect(spilloverCalls).toEqual([true]);
    expect(config.allowRamSpillover).toBe(true);
  });

  it('reads and persists the machine-owned llama.cpp context policy, resetting engines on change', async () => {
    let config: { llamaCppContextSizing?: 'adaptive' | 'model-max' } = {};
    const resetCalls: Array<{ deferBusy?: boolean }> = [];
    const app = makeApp(
      {
        engineStatus: async () => null,
        reconcileEnginePool: async () => {},
        // The policy governs launch args, so a change must tear idle
        // engines down (deferring busy ones) — otherwise it silently waits
        // for an idle-timeout nobody can see.
        resetClient: async (opts: { deferBusy?: boolean }) => {
          resetCalls.push(opts);
        },
      } as Parameters<typeof makeApp>[0],
      {
        store: {
          readConfig: async () => config,
          writeConfig: async (patch: { llamaCppContextSizing?: 'model-max' | null }) => {
            config =
              patch.llamaCppContextSizing === null
                ? {}
                : { llamaCppContextSizing: patch.llamaCppContextSizing };
            return config;
          },
        },
      },
    );

    const initial = await app.request('/api/engines/llama-cpp/context-sizing');
    await expect(initial.json()).resolves.toEqual({ policy: 'adaptive' });
    expect(resetCalls).toEqual([]);

    const setMaximum = await app.request('/api/engines/llama-cpp/context-sizing', {
      method: 'PUT',
      body: JSON.stringify({ policy: 'model-max' }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(setMaximum.json()).resolves.toEqual({ policy: 'model-max' });
    expect(config).toEqual({ llamaCppContextSizing: 'model-max' });
    expect(resetCalls).toEqual([{ deferBusy: true }]);

    const repeatMaximum = await app.request('/api/engines/llama-cpp/context-sizing', {
      method: 'PUT',
      body: JSON.stringify({ policy: 'model-max' }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(repeatMaximum.json()).resolves.toEqual({ policy: 'model-max' });
    expect(resetCalls).toHaveLength(1);

    const setAdaptive = await app.request('/api/engines/llama-cpp/context-sizing', {
      method: 'PUT',
      body: JSON.stringify({ policy: 'adaptive' }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(setAdaptive.json()).resolves.toEqual({ policy: 'adaptive' });
    expect(config).toEqual({});
    expect(resetCalls).toHaveLength(2);
  });

  it('reads and persists per-model context overrides, resetting engines on change', async () => {
    let config: { modelContextOverrides?: Record<string, number> } = {};
    const resetCalls: Array<{ deferBusy?: boolean }> = [];
    const app = makeApp(
      {
        engineStatus: async () => null,
        reconcileEnginePool: async () => {},
        resetClient: async (opts: { deferBusy?: boolean }) => {
          resetCalls.push(opts);
        },
      } as Parameters<typeof makeApp>[0],
      {
        store: {
          readConfig: async () => config,
          writeConfig: async (patch: {
            modelContextOverrides?: Record<string, number> | null;
          }) => {
            // Mirror Store.writeConfig: records replace wholesale, null clears.
            config =
              patch.modelContextOverrides === null
                ? {}
                : { modelContextOverrides: patch.modelContextOverrides };
            return config;
          },
        },
      },
    );

    const empty = await app.request('/api/engines/llama-cpp/model-context');
    await expect(empty.json()).resolves.toEqual({ overrides: {} });

    const set = await app.request('/api/engines/llama-cpp/model-context/qwen3.6-27b-q4', {
      method: 'PUT',
      body: JSON.stringify({ contextTokens: 98_304 }),
      headers: { 'content-type': 'application/json' },
    });
    await expect(set.json()).resolves.toEqual({
      modelId: 'qwen3.6-27b-q4',
      contextTokens: 98_304,
    });
    expect(config.modelContextOverrides).toEqual({ 'llama-cpp:qwen3.6-27b-q4': 98_304 });
    expect(resetCalls).toEqual([{ deferBusy: true }]);

    // Same value again — no engine churn.
    await app.request('/api/engines/llama-cpp/model-context/qwen3.6-27b-q4', {
      method: 'PUT',
      body: JSON.stringify({ contextTokens: 98_304 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(resetCalls).toHaveLength(1);

    // A second model (different engine) merges instead of replacing.
    await app.request('/api/engines/mlx/model-context/gemma4-e4b', {
      method: 'PUT',
      body: JSON.stringify({ contextTokens: 131_072 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(config.modelContextOverrides).toEqual({
      'llama-cpp:qwen3.6-27b-q4': 98_304,
      'mlx:gemma4-e4b': 131_072,
    });

    // The GET map is engine-filtered and keyed by bare model id.
    const llamaList = await app.request('/api/engines/llama-cpp/model-context');
    await expect(llamaList.json()).resolves.toEqual({
      overrides: { 'qwen3.6-27b-q4': 98_304 },
    });

    // Null clears one key; the record survives while others remain.
    await app.request('/api/engines/llama-cpp/model-context/qwen3.6-27b-q4', {
      method: 'PUT',
      body: JSON.stringify({ contextTokens: null }),
      headers: { 'content-type': 'application/json' },
    });
    expect(config.modelContextOverrides).toEqual({ 'mlx:gemma4-e4b': 131_072 });

    // Clearing the last key nulls the whole record off disk.
    await app.request('/api/engines/mlx/model-context/gemma4-e4b', {
      method: 'PUT',
      body: JSON.stringify({ contextTokens: null }),
      headers: { 'content-type': 'application/json' },
    });
    expect(config).toEqual({});

    // Bounds + engine validation.
    const tooSmall = await app.request('/api/engines/llama-cpp/model-context/m', {
      method: 'PUT',
      body: JSON.stringify({ contextTokens: 16_384 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(tooSmall.status).not.toBe(200);
    const badEngine = await app.request('/api/engines/openai/model-context');
    expect(badEngine.status).toBe(400);
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
