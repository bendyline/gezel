import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../fs/store.js';
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
});
