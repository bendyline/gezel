import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import type { RemoteReachability, RemoteStatus } from '../remotes/reachability.js';
import { createRemotesRegistry } from '../remotes/registry.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager, effectiveSessionModel } from './manager.js';

/**
 * A gezel can run on a paired server's model. When that server sleeps or this
 * device leaves its network, the gezel's work goes to this install's own
 * provider instead, and back once the server is reachable again.
 */

const FP = 'ab'.repeat(32);
const REMOTE_MODEL = `remote:${FP}/llama-cpp:qwen3.6-27b`;

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function fakeReachability(
  initial: RemoteStatus,
): RemoteReachability & { set(s: RemoteStatus): void } {
  let status = initial;
  return {
    set: (s) => {
      status = s;
    },
    status: () => status,
    snapshot: () => ({ status }),
    reportReachable: () => {
      status = 'online';
    },
    reportUnreachable: () => {
      status = 'offline';
    },
    check: async () => status,
    noteSighting: () => {},
  };
}

async function setup(status: RemoteStatus) {
  const home = await mkdtemp(join(tmpdir(), 'gezel-remote-fallback-'));
  const store = new Store({ home });
  await store.ensureLayout();
  // The install's own provider is a cloud one, so the fallback does not
  // depend on which on-device engine this test machine's platform gets.
  await store.writeConfig({ provider: 'openai', firstRunCompleted: true });
  const gezel = await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.updateGezelSettings(gezel.id, { provider: 'remote', model: REMOTE_MODEL });
  const remotes = await createRemotesRegistry({ home });
  await remotes.add({
    remoteId: FP,
    baseUrl: 'https://192.0.2.20:6229',
    displayName: 'Werkbank',
    token: 'token',
    pinnedIdentityKey: 'pem',
    pinnedIdentityFingerprint: FP,
    scopes: ['remote-inference'],
    pairedAt: Date.now(),
  });
  const reach = fakeReachability(status);
  const manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  manager.setRemotesRegistry(remotes);
  manager.setRemoteReachability(reach);
  cleanups.push(async () => {
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  return { manager, reach, gezelId: gezel.id };
}

describe('ChatManager — a paired server that comes and goes', () => {
  it('routes to the paired server while it is reachable or not yet tried', async () => {
    const { manager, reach, gezelId } = await setup('unknown');
    expect(await manager.providerForGezel(gezelId)).toBe('remote');
    reach.set('online');
    expect(await manager.providerForGezel(gezelId)).toBe('remote');
  });

  it("falls back to the install's own provider while the server is unreachable, and back after", async () => {
    const { manager, reach, gezelId } = await setup('offline');
    expect(await manager.providerForGezel(gezelId)).toBe('openai');
    reach.set('online');
    expect(await manager.providerForGezel(gezelId)).toBe('remote');
  });

  it('never hands the remote model id to the provider standing in for it', () => {
    const record = { providerName: 'openai' as const } as Pick<
      ChatSession,
      'providerName' | 'model' | 'modelSource' | 'nightShift'
    >;
    expect(
      effectiveSessionModel({
        record,
        frontmatterModel: REMOTE_MODEL,
        config: { defaultModel: { openai: 'gpt-5' } },
      }),
    ).toBe('gpt-5');
    expect(
      effectiveSessionModel({
        record: { ...record, providerName: 'remote' },
        frontmatterModel: REMOTE_MODEL,
        config: {},
      }),
    ).toBe(REMOTE_MODEL);
  });
});
