import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../fs/store.js';
import { createRemotesRegistry } from '../../remotes/registry.js';
import type { SecretKey, SecretStore } from '../../secrets/types.js';
import { ImageProviderManager } from './manager.js';
import { MockImageProvider } from './mock.js';

function fakeSecrets(): SecretStore {
  const map = new Map<string, string>();
  const keyOf = (k: SecretKey) =>
    k.kind === 'providerCredential'
      ? `pc:${k.name}`
      : k.kind === 'toolset'
        ? `ts:${k.toolsetId}:${k.fieldId}`
        : `k:${k.kind}`;
  return {
    backend: 'file',
    async get(key) {
      return map.get(keyOf(key)) ?? null;
    },
    async set(key, value) {
      map.set(keyOf(key), value);
    },
    async delete(key) {
      map.delete(keyOf(key));
    },
    async has(key) {
      return map.has(keyOf(key));
    },
    async listForToolset() {
      return [];
    },
  };
}

let home: string;
let store: Store;

async function attachMachineRemote(manager: ImageProviderManager): Promise<void> {
  const remotes = await createRemotesRegistry({ home });
  remotes.setEphemeral({
    remoteId: 'this-machine',
    baseUrl: 'https://127.0.0.1:6229',
    displayName: 'This machine',
    token: 'machine-token',
    pinnedIdentityKey: 'test-key',
    pinnedIdentityFingerprint: 'test-fingerprint',
    scopes: ['remote-inference', 'machine-models'],
    pairedAt: Date.now(),
    managed: 'machine-engine',
  });
  manager.setRemotes(remotes);
  manager.setMachineEngineRemoteResolver(() => 'this-machine');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-image-manager-'));
  store = new Store({ home });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ImageProviderManager', () => {
  it('returns the same provider across two reads (lazy + cached)', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    const p1 = await mgr.current();
    const p2 = await mgr.current();
    expect(p1).toBe(p2);
    expect(p1).toBeInstanceOf(MockImageProvider);
  });

  it('rebuilds after reset()', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    const p1 = await mgr.current();
    await mgr.reset();
    const p2 = await mgr.current();
    expect(p1).not.toBe(p2);
  });

  it('dedupes concurrent current() calls into one factory invocation', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    const [a, b, c] = await Promise.all([mgr.current(), mgr.current(), mgr.current()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('rebuilds with new config after reset (mock → sd-cpp via config switch)', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: {},
    });
    await store.writeConfig({ imageProvider: 'mock' });
    const p1 = await mgr.current();
    expect(p1.name).toBe('mock');
    await store.writeConfig({ imageProvider: 'sd-cpp' });
    await mgr.reset();
    const p2 = await mgr.current();
    expect(p2.name).toBe('sd-cpp');
  });

  it('shutdown clears the cached provider', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    const p1 = await mgr.current();
    await mgr.shutdown();
    const p2 = await mgr.current();
    expect(p1).not.toBe(p2);
  });

  it('delegates the default native provider to the machine broker', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: {},
    });
    await attachMachineRemote(mgr);

    expect(await mgr.usesMachineEngine()).toBe(true);
    expect((await mgr.current()).name).toBe('remote:This machine');
    expect((await mgr.providerForModel('sdxl-base-1.0')).name).toBe('remote:This machine');
  });

  it.each([
    ['openai', 'gpt-image-2'],
    ['google-ai', 'gemini-3.1-flash-image-preview'],
  ] as const)('keeps configured %s generation in the user daemon', async (imageProvider, model) => {
    await store.writeConfig({ imageProvider });
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: {},
    });
    await attachMachineRemote(mgr);

    expect(await mgr.usesMachineEngine()).toBe(false);
    expect((await mgr.current()).name).toBe(imageProvider);
    expect((await mgr.providerForModel(model)).name).toBe(imageProvider);
  });

  it('honors an explicit remote model even when the configured provider is cloud', async () => {
    await store.writeConfig({ imageProvider: 'openai' });
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: {},
    });
    await attachMachineRemote(mgr);

    expect((await mgr.providerForModel('remote:this-machine/sdxl-base-1.0')).name).toBe(
      'remote:This machine',
    );
  });

  it('keeps the effective mock provider local when a broker is present', async () => {
    const mgr = new ImageProviderManager({
      home,
      store,
      secrets: fakeSecrets(),
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    await attachMachineRemote(mgr);

    expect(await mgr.usesMachineEngine()).toBe(false);
    expect((await mgr.current()).name).toBe('mock');
  });
});
