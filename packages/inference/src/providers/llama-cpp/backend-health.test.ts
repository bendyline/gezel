import { LlamaCppBackendHealthResponseSchema } from '@bendyline/gezel';
import { LLAMA_CUDA_BLOCKER_ENV } from '@bendyline/gezel/native';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enginesRoutes } from '../../http/routes/engines.js';
import {
  __resetLlamaBackendHealthForTest,
  llamaBackendHealthView,
  noteGpuStartup,
  noteHostOutOfMemory,
} from './backend-health.js';

const ENV = ['GEZEL_LLAMA_SERVER_BACKEND', LLAMA_CUDA_BLOCKER_ENV] as const;
let saved: Partial<Record<(typeof ENV)[number], string>>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  __resetLlamaBackendHealthForTest();
});

afterEach(() => {
  for (const name of ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetLlamaBackendHealthForTest();
});

describe('llama backend health', () => {
  it('answers an empty object when nothing is wrong', () => {
    expect(llamaBackendHealthView()).toEqual({});
  });

  it('reports the CUDA build discovery passed over, and the build running instead', () => {
    process.env.GEZEL_LLAMA_SERVER_BACKEND = 'vulkan';
    process.env[LLAMA_CUDA_BLOCKER_ENV] = JSON.stringify({
      kind: 'driver-too-old',
      installed: '570.86.10',
      required: '580.65.06',
      detail: 'NVIDIA driver 570.86.10 is older than 580.65.06',
    });
    expect(llamaBackendHealthView()).toMatchObject({
      running: 'vulkan',
      cudaBlocker: { kind: 'driver-too-old', required: '580.65.06' },
    });
  });

  it('reports a GPU build that started without its GPU until a start finds it', () => {
    process.env.GEZEL_LLAMA_SERVER_BACKEND = 'cuda';
    noteGpuStartup({ backend: 'cuda', reason: 'not-loaded' }, new Date('2026-10-17T10:00:00Z'));
    expect(llamaBackendHealthView().gpuUnused).toEqual({
      backend: 'cuda',
      reason: 'not-loaded',
      at: '2026-10-17T10:00:00.000Z',
    });
    noteGpuStartup(null);
    expect(llamaBackendHealthView().gpuUnused).toBeUndefined();
  });

  it('drops a verdict about a build the process has since moved off', () => {
    process.env.GEZEL_LLAMA_SERVER_BACKEND = 'cuda';
    noteGpuStartup({ backend: 'cuda', reason: 'init-failed', detail: 'x' });
    process.env.GEZEL_LLAMA_SERVER_BACKEND = 'cpu';
    expect(llamaBackendHealthView().gpuUnused).toBeUndefined();
  });

  it('counts out-of-memory kills and keeps the latest', () => {
    noteHostOutOfMemory({ model: 'a', whileStarting: true }, new Date('2026-10-17T10:00:00Z'));
    noteHostOutOfMemory({ model: 'b', whileStarting: false }, new Date('2026-10-17T11:00:00Z'));
    expect(llamaBackendHealthView().outOfMemory).toEqual({
      count: 2,
      at: '2026-10-17T11:00:00.000Z',
      model: 'b',
      whileStarting: false,
    });
  });

  it('serves the view over the engines route in the published shape', async () => {
    process.env.GEZEL_LLAMA_SERVER_BACKEND = 'vulkan';
    noteGpuStartup({ backend: 'vulkan', reason: 'no-devices' });
    noteHostOutOfMemory({ whileStarting: true });
    const app = new Hono();
    const ctx = { home: '/nonexistent' } as unknown as Parameters<typeof enginesRoutes>[0];
    app.route('/api/engines', enginesRoutes(ctx));
    const res = await app.request('/api/engines/llama-cpp/backend-health');
    expect(res.status).toBe(200);
    expect(LlamaCppBackendHealthResponseSchema.parse(await res.json())).toMatchObject({
      running: 'vulkan',
      gpuUnused: { backend: 'vulkan', reason: 'no-devices' },
      outOfMemory: { count: 1, whileStarting: true },
    });
  });
});
