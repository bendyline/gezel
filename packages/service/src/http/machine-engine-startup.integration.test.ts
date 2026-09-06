import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningEngineService, startService } from '../service.js';

// Construction is forbidden, even if an implementation later guards starts.
// Also prohibit importing the product composition root: role dispatch is first.
vi.mock('../product-service.js', () => {
  throw new Error('Engine imported product bootstrap');
});
vi.mock('../fs/store.js', () => ({
  Store: class {
    constructor() {
      throw new Error('Engine constructed Store');
    }
  },
}));
vi.mock('../chat/manager.js', () => ({
  ChatManager: class {
    constructor() {
      throw new Error('Engine constructed ChatManager');
    }
  },
}));
vi.mock('../memory/manager.js', () => ({
  MemoryManager: class {
    constructor() {
      throw new Error('Engine constructed MemoryManager');
    }
  },
}));
vi.mock('../tasks/manager.js', () => ({
  TaskManager: class {
    constructor() {
      throw new Error('Engine constructed TaskManager');
    }
  },
}));
vi.mock('../terminal/manager.js', () => ({
  TerminalManager: class {
    constructor() {
      throw new Error('Engine constructed TerminalManager');
    }
  },
}));
vi.mock('../channels/manager.js', () => ({
  ChannelManager: class {
    constructor() {
      throw new Error('Engine constructed ChannelManager');
    }
  },
}));
vi.mock('../index-store/content-index.js', () => ({
  ContentIndex: class {
    constructor() {
      throw new Error('Engine constructed ContentIndex');
    }
  },
}));
vi.mock('../tasks/scheduler.js', () => ({
  TaskScheduler: class {
    constructor() {
      throw new Error('Engine constructed TaskScheduler');
    }
  },
}));
vi.mock('../secrets/index.js', () => ({
  openSecretStore: () => {
    throw new Error('Engine opened credential store');
  },
}));

let home: string;
const running: RunningEngineService[] = [];
const temporaryHomes: string[] = [];
beforeEach(async () => {
  vi.stubEnv('GEZEL_MOCK_PROVIDER', '1');
  vi.stubEnv('GEZEL_SECRETS_BACKEND', 'file');
  home = await mkdtemp(join(tmpdir(), 'gezel-engine-startup-'));
  temporaryHomes.push(home);
});
afterEach(async () => {
  for (const service of running.splice(0).reverse()) await service.stop();
  for (const dir of temporaryHomes.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function start(dir = home, port?: number) {
  const service = await startService({
    home: dir,
    role: 'machine-engine',
    webUi: true,
    ...(port !== undefined ? { port } : {}),
  });
  running.push(service);
  return service;
}
async function assertNoProductState(service: RunningEngineService, dir: string) {
  const forbidden = [
    'projects',
    'gezels',
    'documents',
    'tasks',
    'index',
    'memories',
    'connectors',
    'channels',
    'secrets.enc',
    'secrets.key',
    'secrets.backend',
  ];
  const entries = await readdir(dir);
  expect(entries.filter((name) => forbidden.includes(name))).toEqual([]);
  for (const capability of [
    'secrets',
    'memory',
    'tasks',
    'taskRunner',
    'taskScheduler',
    'terminals',
    'channels',
    'contentIndex',
    'history',
    'chatEvents',
  ])
    expect(service.context).not.toHaveProperty(capability);
  expect(service.context.store).not.toHaveProperty('getProject');
  expect(service.context.chat).not.toHaveProperty('oneShotCompletion');
  expect(service.webUiToken).toBeNull();
}

describe('engine-only composition and lifecycle', () => {
  it('boots and restarts without constructing or persisting product state', async () => {
    const config = JSON.stringify({
      resetTemplatesOnStartup: true,
      provider: 'openai',
      externalFolders: { projects: join(home, 'outside-projects') },
    });
    await writeFile(join(home, 'config.json'), config);
    const first = await start();
    await assertNoProductState(first, home);
    const identity = first.context.deviceIdentity;
    const firstToken = first.clientToken;
    await first.stop();
    expect(await readdir(join(home, 'runtime'))).toEqual([]);
    const second = await start();
    expect(second.context.deviceIdentity).toEqual(identity);
    expect(second.clientToken).not.toBe(firstToken);
    expect(await readFile(join(home, 'config.json'), 'utf8')).toBe(config);
    await expect(stat(join(home, 'outside-projects'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (process.platform !== 'win32')
      expect((await stat(join(home, 'engine-identity-key.json'))).mode & 0o777).toBe(0o600);
    await second.stop();
    await assertNoProductState(second, home);
  });

  it('does not mount product execution routes even for its process-local root token', async () => {
    const service = await start();
    const http = service.cert ? createTrustingFetch({ cert: service.cert.certPem }) : fetch;
    const base = `${service.cert ? 'https' : 'http'}://127.0.0.1:${service.port}`;
    for (const path of [
      '/api/projects',
      '/api/credentials',
      '/api/terminals',
      '/v1/remote/manage/image-gen/generate',
      '/v1/remote/manage/video-gen/generate',
      '/v1/remote/manage/audio/transcribe',
      '/v1/remote/manage/audio/synthesize',
      '/v1/remote/manage/audio/synthesize-stream',
      '/v1/remote/manage/cache/warm',
    ]) {
      const response = await http(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${service.context.token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(response.status, path).toBe(404);
    }
    await assertNoProductState(service, home);
  });

  it('releases the home lock and listeners after startup fails', async () => {
    const occupying = await start();
    const otherHome = await mkdtemp(join(tmpdir(), 'gezel-engine-retry-'));
    temporaryHomes.push(otherHome);
    await expect(start(otherHome, occupying.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await readdir(join(otherHome, 'runtime'))).toEqual([]);
    const retry = await start(otherHome);
    await retry.stop();
    await assertNoProductState(retry, otherHome);
    expect(await readdir(join(otherHome, 'runtime'))).toEqual([]);
  });
});
