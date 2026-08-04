import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let machine: RunningService;
let user: RunningService;
let machineHome: string;
let userHome: string;
let userBaseUrl: string;
let userFetch: typeof fetch;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  machineHome = await mkdtemp(join(tmpdir(), 'gezel-engine-home-'));
  userHome = await mkdtemp(join(tmpdir(), 'gezel-user-home-'));
  machine = await startService({ home: machineHome, role: 'machine-engine' });
  user = await startService({ home: userHome, role: 'user', machineEngineHome: machineHome });
  userBaseUrl = `${user.cert ? 'https' : 'http'}://127.0.0.1:${user.port}`;
  userFetch = user.cert ? createTrustingFetch({ cert: user.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await user?.stop();
  await machine?.stop();
  await Promise.all([
    rm(userHome, { recursive: true, force: true }).catch(() => undefined),
    rm(machineHome, { recursive: true, force: true }).catch(() => undefined),
  ]);
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
}, 30_000);

function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${user.clientToken}`);
  return userFetch(`${userBaseUrl}${path}`, {
    ...init,
    headers,
  });
}

describe('split user + machine services', () => {
  it('adopts the machine broker without persisting its rotating token', async () => {
    expect(user.context.machineEngine?.isConnected()).toBe(true);
    const response = await api('/api/remotes');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      remotes: [
        {
          remoteId: 'this-machine',
          displayName: 'This machine',
          managed: 'machine-engine',
          hasToken: true,
        },
      ],
    });

    const reloaded = await import('../remotes/registry.js').then(({ createRemotesRegistry }) =>
      createRemotesRegistry({ home: userHome }),
    );
    expect(reloaded.get('this-machine')).toBeNull();
  });

  it('keeps project APIs per-user while proxying engine management', async () => {
    expect((await api('/api/projects')).status).toBe(200);
    expect((await api('/api/engines/status')).status).toBe(200);
    expect((await api('/api/llama-cpp/models')).status).toBe(200);
    expect((await api('/api/image-gen/models')).status).toBe(200);
    expect((await api('/api/video-gen/models')).status).toBe(200);
    expect((await api('/api/audio/stt/models')).status).toBe(200);
    expect((await api('/api/model-fitness')).status).toBe(200);
  });

  it('merges split queue ownership and routes cache operations to the correct daemon', async () => {
    const userChat = user.context.chat;
    const machineChat = machine.context.chat;
    const originalUserProvider = userChat.getProviderIfReady;
    const originalMachineProvider = machineChat.getProviderIfReady;
    const originalUserQueued = userChat.listQueued;
    const originalUserCache = userChat.getCacheStats;
    const originalMachineCache = machineChat.getCacheStats;
    const originalUserWarm = userChat.prewarmSession;
    const originalUserClear = userChat.invalidateProviderCache;
    const originalMachineClear = machineChat.invalidateProviderCache;
    const originalUserEvict = userChat.invalidateSessionCache;
    const originalMachineEvict = machineChat.invalidateSessionCache;
    const originalUserCancel = userChat.cancelProviderQueueItem;
    const originalMachineCancel = machineChat.cancelProviderQueueItem;
    const warmed: string[] = [];
    const cleared: string[] = [];
    const evicted: string[] = [];
    const cancelled: Array<[string, number]> = [];
    const queueDescription = {
      running: 0,
      queuedInteractive: 1,
      queuedBackground: 0,
      ambientHeld: 0,
      concurrency: 1,
      interactiveConcurrency: 1,
      backgroundConcurrency: 1,
      active: [],
      pending: [
        {
          id: 7,
          lane: 'interactive' as const,
          sessionId: 'dev:machine-engine-client:native-session',
          waitedMs: 10,
        },
      ],
    };
    try {
      userChat.getProviderIfReady = ((name: string) =>
        name === 'openai'
          ? {
              queue: {
                describe: () => ({
                  ...queueDescription,
                  pending: [{ ...queueDescription.pending[0]!, id: 8, sessionId: 'cloud-session' }],
                }),
                snapshot: () => ({
                  running: 0,
                  queuedInteractive: 1,
                  queuedBackground: 0,
                }),
              },
            }
          : originalUserProvider.call(
              userChat,
              name as never,
            )) as typeof userChat.getProviderIfReady;
      machineChat.getProviderIfReady = ((name: string) =>
        name === 'llama-cpp'
          ? {
              queue: { describe: () => queueDescription },
              batch: { maxConcurrency: 1 },
            }
          : originalMachineProvider.call(
              machineChat,
              name as never,
            )) as typeof machineChat.getProviderIfReady;
      userChat.listQueued = (() => [
        { sessionId: 'user-ghost', depth: 1, nextPreview: 'local', entries: [] },
      ]) as typeof userChat.listQueued;
      const cacheBase = {
        totalBytes: 0,
        budgetBytes: 1024,
        warmSessionCount: 1,
        hits: 0,
        misses: 0,
        recentHitRate: 0,
        hitsBySource: { memory: 0, disk: 0, prefix: 0, fresh: 0 },
        gezels: [],
      };
      userChat.getCacheStats = () => [
        { ...cacheBase, providerName: 'user-local-stale', sessions: [] },
      ];
      machineChat.getCacheStats = (() => [
        {
          ...cacheBase,
          providerName: 'llama-cpp',
          sessions: [
            {
              sessionId: 'dev:machine-engine-client:native-session',
              gezelId: 'dev:machine-engine-client:gezel-a',
              tokenCount: 10,
              bytes: 100,
              lastUsedAt: 1,
              evictionPriority: 'normal',
            },
          ],
        },
      ]) as typeof machineChat.getCacheStats;
      userChat.prewarmSession = (async (sessionId: string) => {
        warmed.push(sessionId);
      }) as typeof userChat.prewarmSession;
      userChat.invalidateProviderCache = (() => {
        throw new Error('provider clear must not stay in the user daemon');
      }) as typeof userChat.invalidateProviderCache;
      machineChat.invalidateProviderCache = ((provider: string) => {
        cleared.push(provider);
      }) as typeof machineChat.invalidateProviderCache;
      userChat.invalidateSessionCache = (() => {
        throw new Error('session eviction must not stay in the user daemon');
      }) as typeof userChat.invalidateSessionCache;
      machineChat.invalidateSessionCache = ((sessionId: string) => {
        evicted.push(sessionId);
      }) as typeof machineChat.invalidateSessionCache;
      userChat.cancelProviderQueueItem = ((provider: string, id: number) => {
        cancelled.push([`user:${provider}`, id]);
        return true;
      }) as typeof userChat.cancelProviderQueueItem;
      machineChat.cancelProviderQueueItem = ((provider: string, id: number) => {
        cancelled.push([`machine:${provider}`, id]);
        return true;
      }) as typeof machineChat.cancelProviderQueueItem;

      const queues = await api('/api/queues');
      expect(queues.status).toBe(200);
      await expect(queues.json()).resolves.toMatchObject({
        providers: {
          openai: { pending: [{ id: 8, sessionId: 'cloud-session' }] },
          'llama-cpp': { pending: [{ id: 7, sessionId: 'native-session' }] },
        },
        sessions: [{ sessionId: 'user-ghost' }],
        cache: [
          {
            providerName: 'llama-cpp',
            sessions: [{ sessionId: 'native-session', gezelId: 'gezel-a' }],
          },
        ],
      });
      const cacheStats = await api('/api/cache/stats');
      expect(cacheStats.status).toBe(200);
      await expect(cacheStats.json()).resolves.toMatchObject({
        providers: [
          {
            providerName: 'llama-cpp',
            sessions: [{ sessionId: 'native-session', gezelId: 'gezel-a' }],
          },
        ],
      });

      expect((await api('/api/queues/llama-cpp/7', { method: 'DELETE' })).status).toBe(200);
      expect((await api('/api/queues/openai/8', { method: 'DELETE' })).status).toBe(200);
      expect(cancelled).toEqual([
        ['machine:llama-cpp', 7],
        ['user:openai', 8],
      ]);

      expect(
        (
          await api('/api/cache/warm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 'native-session' }),
          })
        ).status,
      ).toBe(202);
      expect(warmed).toEqual(['native-session']);

      expect(
        (
          await api('/api/cache/clear', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'llama-cpp' }),
          })
        ).status,
      ).toBe(200);
      expect(cleared).toEqual(['llama-cpp']);

      expect(
        (
          await api('/api/cache/evict', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 'native-session' }),
          })
        ).status,
      ).toBe(200);
      expect(evicted).toEqual(['dev:machine-engine-client:native-session']);
    } finally {
      userChat.getProviderIfReady = originalUserProvider;
      machineChat.getProviderIfReady = originalMachineProvider;
      userChat.listQueued = originalUserQueued;
      userChat.getCacheStats = originalUserCache;
      machineChat.getCacheStats = originalMachineCache;
      userChat.prewarmSession = originalUserWarm;
      userChat.invalidateProviderCache = originalUserClear;
      machineChat.invalidateProviderCache = originalMachineClear;
      userChat.invalidateSessionCache = originalUserEvict;
      machineChat.invalidateSessionCache = originalMachineEvict;
      userChat.cancelProviderQueueItem = originalUserCancel;
      machineChat.cancelProviderQueueItem = originalMachineCancel;
    }
  });

  it('runs the public ensure-model lifecycle in the shared broker', async () => {
    const jobId = '00000000-0000-4000-8000-000000000001';
    const getMachineJob = machine.context.ensureModel.getJob.bind(machine.context.ensureModel);
    machine.context.ensureModel.getJob = (requested) =>
      requested === jobId
        ? {
            jobId,
            modelId: 'llama-cpp:broker-owned',
            status: 'running',
            startedAt: 123,
            events: [],
          }
        : getMachineJob(requested);

    const response = await api(`/v1/models/ensure/${jobId}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      job_id: jobId,
      model_id: 'llama-cpp:broker-owned',
    });
  });

  it('refreshes machine-hosted models after a pull without reconnecting either daemon', async () => {
    const machineChat = machine.context.chat;
    const originalListModels = machineChat.listModelsForProvider;
    let installed = false;
    machineChat.listModelsForProvider = async (provider) =>
      provider === 'llama-cpp' && installed
        ? [{ id: 'newly-pulled.gguf', name: 'Newly pulled' }]
        : [];
    try {
      const before = await api('/api/models?provider=llama-cpp&refresh=1');
      expect(before.status).toBe(200);
      await expect(before.json()).resolves.toMatchObject({ provider: 'llama-cpp', models: [] });

      installed = true;
      const after = await api('/api/models?provider=llama-cpp&refresh=1');
      expect(after.status).toBe(200);
      await expect(after.json()).resolves.toMatchObject({
        provider: 'llama-cpp',
        models: [expect.objectContaining({ id: 'newly-pulled.gguf' })],
      });
    } finally {
      machineChat.listModelsForProvider = originalListModels;
    }
  });

  it('delegates native multimodal providers without moving artifact ownership', async () => {
    const providers = await Promise.all([
      user.context.imageProvider.current(),
      user.context.videoProvider.current(),
      user.context.stt.current(),
      user.context.tts.current(),
    ]);
    expect(providers.map((provider) => provider.name)).toEqual([
      // GEZEL_MOCK_PROVIDER is an effective non-native image provider, so it
      // stays in the user daemon. The other managers use their remote mocks as
      // stand-ins for heavyweight native execution in this integration suite.
      'mock',
      'remote:This machine',
      'remote:This machine',
      'remote:This machine',
    ]);
  });

  it('keeps cloud image selection and status in the user daemon', async () => {
    const mockFlag = process.env.GEZEL_MOCK_PROVIDER;
    delete process.env.GEZEL_MOCK_PROVIDER;
    await user.context.store.writeConfig({ imageProvider: 'openai' });
    await user.context.imageProvider.reset();
    try {
      expect(await user.context.imageProvider.usesMachineEngine()).toBe(false);
      expect((await user.context.imageProvider.current()).name).toBe('openai');

      const status = await api('/api/image-gen/engine-status');
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({
        engine: { provider: 'openai', kind: 'cloud', status: 'not-configured' },
      });

      const models = await api('/api/image-gen/models');
      expect(models.status).toBe(200);
      await expect(models.json()).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: 'gpt-image-2' })]),
      });
    } finally {
      if (mockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
      else process.env.GEZEL_MOCK_PROVIDER = mockFlag;
      await user.context.store.writeConfig({ imageProvider: 'sd-cpp' });
      await user.context.imageProvider.reset();
    }
  });
});
