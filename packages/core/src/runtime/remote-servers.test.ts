import { describe, expect, it } from 'vitest';
import { PortableRemoteServers, REMOTE_CERTIFICATE_REFUSED } from './remote-servers.js';
import {
  TEST_SERVER_BASE as BASE,
  fakeRemoteServer as fakeServer,
  memoryRemotesStore as memoryStore,
} from './remote-test-server.js';

type SigningKey = Parameters<typeof globalThis.crypto.subtle.sign>[1];

async function paired(now: () => number = Date.now) {
  const { server, http } = await fakeServer();
  const store = memoryStore();
  const remotes = new PortableRemoteServers(store, { http, deviceName: () => 'Phone' }, now);
  const info = await remotes.pair({ baseUrl: '192.168.1.20', code: '4821 0937' });
  return { server, store, remotes, info };
}

describe('PortableRemoteServers', () => {
  it('pairs with the code a server shows and remembers it', async () => {
    const { server, store, info } = await paired();
    expect(info).toMatchObject({
      remoteId: server.fingerprint,
      baseUrl: BASE,
      displayName: 'Werkbank',
      status: 'online',
    });
    expect(store.value.servers).toHaveLength(1);
    expect(store.value.servers[0]?.token).toBe('device-token');
    expect(store.value.identity?.deviceId).toBeTruthy();
  });

  it('saves nothing when the code is wrong', async () => {
    const { http } = await fakeServer();
    const store = memoryStore();
    const remotes = new PortableRemoteServers(store, { http, deviceName: () => 'Phone' });
    await expect(remotes.pair({ baseUrl: BASE, code: '11112222' })).rejects.toThrow();
    expect(store.value.servers).toHaveLength(0);
  });

  it("adopts a restarted server's certificate when its identity signed it", async () => {
    const { server, store, remotes, info } = await paired();
    await server.rotate();
    const result = await remotes.models(info.remoteId);
    expect(result.status).toBe('online');
    expect(result.models[0]?.id).toBe(`remote:${info.remoteId}/llama-cpp:qwen3.6-27b`);
    expect(store.value.servers[0]?.tlsCertPem).toBe(server.certPem);
  });

  it('refuses a certificate the pinned identity did not sign', async () => {
    const { server, store, remotes, info } = await paired();
    const pinnedCert = store.value.servers[0]?.tlsCertPem;
    const stranger = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as { privateKey: SigningKey };
    await server.rotate(stranger.privateKey);
    const server0 = (await store.readRemotes()).servers[0]!;
    await expect(remotes.fetchFor(server0)(`${BASE}/v1/identity`)).rejects.toMatchObject({
      code: REMOTE_CERTIFICATE_REFUSED,
    });
    expect(store.value.servers[0]?.tlsCertPem).toBe(pinnedCert);
    expect(info.status).toBe('online');
  });

  it('answers offline from memory, then probes again after a while', async () => {
    let t = 1_000_000;
    const { server, remotes, info } = await paired(() => t);
    const models = await remotes.models(info.remoteId);
    expect(models.models).toHaveLength(1);

    server.online = false;
    t += 61_000;
    expect(await remotes.check(info.remoteId)).toBe('offline');
    server.online = true;
    t += 5_000;
    expect(await remotes.check(info.remoteId)).toBe('offline');
    t += 11_000;
    expect(await remotes.check(info.remoteId)).toBe('online');
  });

  it('lists the models a server had while it is away', async () => {
    let t = 1_000_000;
    const { server, remotes, info } = await paired(() => t);
    await remotes.models(info.remoteId);
    server.online = false;
    t += 61_000;
    const away = await remotes.models(info.remoteId);
    expect(away.status).toBe('offline');
    expect(away.models.map((m) => m.name)).toEqual(['Qwen 3.6 27B']);
    expect((await remotes.list())[0]?.status).toBe('offline');
  });

  it('forgets a server and asks it to forget this device', async () => {
    const { server, store, remotes, info } = await paired();
    await remotes.forget(info.remoteId);
    expect(store.value.servers).toHaveLength(0);
    expect(server.deletes).toEqual([`/v1/apps/${store.value.identity?.deviceId}/token`]);
  });

  it('forgets a server that is away without waiting on it', async () => {
    const { server, store, remotes, info } = await paired();
    server.online = false;
    await remotes.forget(info.remoteId);
    expect(store.value.servers).toHaveLength(0);
  });
});
