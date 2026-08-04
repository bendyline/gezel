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

function api(path: string): Promise<Response> {
  return userFetch(`${userBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${user.clientToken}` },
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

  it('lists machine-hosted native models through the existing local provider contract', async () => {
    const models = await api('/api/models?provider=llama-cpp&refresh=1');
    expect(models.status).toBe(200);
    await expect(models.json()).resolves.toMatchObject({ provider: 'llama-cpp', models: [] });
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
