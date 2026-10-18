import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlamaCppQuarantineResponseSchema } from '@bendyline/gezel';
import { recordLlamaQuarantine } from '@bendyline/gezel/native';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enginesRoutes } from './engines.js';

const ENV = [
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_LLAMA_SERVER_BACKEND',
  'GEZEL_LLAMA_DETECTED_BACKEND',
  'GEZEL_LLAMA_QUARANTINED',
] as const;

let root: string;
let saved: Partial<Record<(typeof ENV)[number], string>>;
const build = (backend: string) =>
  join(root, 'native', `win32-x64-${backend}`, 'gezel-llama-server.exe');

function makeApp(config: Record<string, unknown> = {}) {
  const resetClient = vi.fn(async () => {});
  const ctx = {
    home: join(root, 'home'),
    store: { readConfig: async () => config },
    chat: { resetClient },
  } as unknown as Parameters<typeof enginesRoutes>[0];
  const app = new Hono();
  app.route('/api/engines', enginesRoutes(ctx));
  return { app, resetClient };
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  root = await mkdtemp(join(tmpdir(), 'gezel-engines-quarantine-'));
  for (const backend of ['vulkan', 'cpu']) {
    await mkdir(join(root, 'native', `win32-x64-${backend}`), { recursive: true });
    await writeFile(build(backend), `${backend} build`);
  }
  // The state a quarantine leaves behind: vulkan written down, cpu running.
  recordLlamaQuarantine(join(root, 'home'), {
    backend: 'vulkan',
    binaryPath: build('vulkan'),
    signal: 'exit:0xc0000005',
    reason: 'access violation before ready',
    crashes: 3,
  });
  process.env.GEZEL_LLAMA_SERVER_BIN = build('cpu');
  process.env.GEZEL_LLAMA_SERVER_BACKEND = 'cpu';
  process.env.GEZEL_LLAMA_DETECTED_BACKEND = 'vulkan';
  process.env.GEZEL_LLAMA_QUARANTINED = 'vulkan';
});

afterEach(async () => {
  for (const name of ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('llama-cpp quarantine routes', () => {
  it('lists the switched-off build and what runs instead', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/engines/llama-cpp/quarantine');
    expect(res.status).toBe(200);
    expect(LlamaCppQuarantineResponseSchema.parse(await res.json())).toMatchObject({
      entries: [{ backend: 'vulkan', crashes: 3 }],
      strikeThreshold: 3,
      running: 'cpu',
    });
  });

  it('turns the build back on and restarts idle engines onto it', async () => {
    const { app, resetClient } = makeApp();
    const res = await app.request('/api/engines/llama-cpp/quarantine/vulkan', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(LlamaCppQuarantineResponseSchema.parse(await res.json())).toMatchObject({
      entries: [],
      running: 'vulkan',
    });
    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(build('vulkan'));
    expect(process.env.GEZEL_LLAMA_QUARANTINED).toBeUndefined();
    expect(resetClient).toHaveBeenCalledWith({ deferBusy: true });
  });

  it('restarts nothing when a pin decides the backend', async () => {
    const { app, resetClient } = makeApp({ llamaCppBackendOverride: 'cpu' });
    const res = await app.request('/api/engines/llama-cpp/quarantine/vulkan', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('cpu');
    expect(resetClient).not.toHaveBeenCalled();
  });

  it('rejects a backend it does not know', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/engines/llama-cpp/quarantine/opencl', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});
