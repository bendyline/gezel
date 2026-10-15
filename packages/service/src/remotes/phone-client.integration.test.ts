import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import {
  createInsecureBootstrapFetch,
  createPinnedFetch,
} from '@bendyline/gezel-inference/internal/remotes/pinned-fetch';
import { type RemoteHttp, parseRemoteModelId, remoteChatFetch } from '@bendyline/gezel/remote';
import { PortableRemoteServers, type PortableRemotes } from '@bendyline/gezel/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

/**
 * A real daemon sharing its models on loopback, and the phone's client — the
 * portable runtime's `PortableRemoteServers` and `remoteChatFetch` — reaching
 * it the way the phone does, over a channel pinned to its certificate.
 */

let server: RunningService;
let home: string;
let remoteBase: string;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

function loopbackApi(svc: RunningService) {
  const fetchImpl = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  const base = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  return async (method: string, path: string) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${svc.clientToken}` },
    });
    return (await res.json()) as Record<string, unknown>;
  };
}

function memoryStore() {
  let value: PortableRemotes = { version: 1, servers: [] };
  return {
    readRemotes: async () => structuredClone(value),
    writeRemotes: async (next: PortableRemotes) => {
      value = structuredClone(next);
    },
    get value() {
      return value;
    },
  };
}

const http: RemoteHttp = {
  bootstrap: () => createInsecureBootstrapFetch(),
  pinned: (certPem) => createPinnedFetch(certPem),
};

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-phone-server-'));
  server = await startService({ home });
  const status = await server.context.remoteServing.reconfigure({
    enabled: true,
    bindAddress: '127.0.0.1',
    port: 0,
  });
  remoteBase = `https://127.0.0.1:${status.port}`;
}, 60_000);

afterAll(async () => {
  await server?.context.remoteServing.reconfigure({ enabled: false }).catch(() => undefined);
  await server?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 60_000);

describe('a phone using a server’s models', () => {
  const store = memoryStore();
  const phone = new PortableRemoteServers(store, { http, deviceName: () => 'Test Phone' });

  it('connects with the code the server shows', async () => {
    const { code } = await loopbackApi(server)('POST', '/api/remote-serving/pairing-code');
    const paired = await phone.pair({ baseUrl: remoteBase, code: String(code) });
    expect(paired).toMatchObject({
      remoteId: server.context.deviceIdentity!.fingerprint,
      status: 'online',
    });
    const record = server.context.tokenStore
      .list()
      .find((r) => r.appId === store.value.identity?.deviceId);
    expect(record).toMatchObject({ kind: 'device', appName: 'Test Phone' });
  });

  it('reads the server’s models and runs a turn on one', async () => {
    const remoteId = store.value.servers[0]!.remoteId;
    // The server lists its own engines' models; the mock provider runs
    // under `copilot`, which it serves but does not list.
    expect((await phone.models(remoteId)).status).toBe('online');
    const serverModel = parseRemoteModelId(`remote:${remoteId}/copilot:mock-fast`)!.modelId;
    const paired = store.value.servers[0]!;
    // The mock has no context window to report: the server is there, and the
    // turn goes ahead on the window it gave last (or a default).
    expect(await phone.admit(paired, serverModel)).toBeNull();
    expect(phone.status(remoteId)).toBe('online');

    const chat = remoteChatFetch({
      fetch: phone.fetchFor(paired),
      baseUrl: paired.baseUrl,
      token: paired.token,
      model: serverModel,
      serverName: paired.displayName,
    });
    const response = await chat('gezel-remote://server/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        stream: true,
        messages: [
          { role: 'system', content: 'You are a helpful gezel.' },
          { role: 'user', content: 'Say hello.' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/"content":"[^"]+"/);
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('notices the server going away', async () => {
    const remoteId = store.value.servers[0]!.remoteId;
    await server.context.remoteServing.reconfigure({ enabled: false });
    expect(await phone.check(remoteId, 0)).toBe('offline');
    expect((await phone.list())[0]?.status).toBe('offline');
  }, 30_000);
});
