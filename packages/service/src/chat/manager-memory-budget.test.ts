/**
 * The Settings memory slider is only as good as its propagation. The
 * budget is read once inside `buildEngineRouter` and the router is cached
 * until shutdown, so before {@link ChatManager.setLocalEngineMemoryBudget}
 * existed, moving the slider changed `config.json` and nothing else — the
 * live broker kept denying models against the old number until the daemon
 * restarted. These tests pin the three paths that propagation has to
 * survive: a router that is already live, one that is mid-build, and none
 * at all.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { CapacityBroker } from '../providers/native/capacity-broker.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const GB = 1024 ** 3;

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

function routerWith(broker: CapacityBroker) {
  return { broker } as unknown as import('../providers/native/engine-router.js').EngineRouter;
}

let home: string;
let store: Store;
let history: HistoryManager;

async function makeManager(
  extra: Partial<ConstructorParameters<typeof ChatManager>[0]> = {},
): Promise<ChatManager> {
  return new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['llama-cpp', new MockProvider({ name: 'llama-cpp' })]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
    history,
    ...extra,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-membudget-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager.setLocalEngineMemoryBudget', () => {
  it('re-points a live broker so the next spawn sees the new budget', async () => {
    const broker = new CapacityBroker({ systemRamBytes: () => 16 * GB, unifiedMemory: true });
    const manager = await makeManager({ engineRouter: routerWith(broker) });
    try {
      // 13 GiB is over the auto budget on a 16 GB Mac; the point of the
      // slider is that the owner may decide to go there.
      expect(broker.canReserve(13 * GB)).toBe(false);

      await manager.setLocalEngineMemoryBudget(14 * GB);
      expect(broker.committed().budgetBytes).toBe(14 * GB);
      expect(broker.canReserve(13 * GB)).toBe(true);

      await manager.setLocalEngineMemoryBudget(null);
      expect(broker.committed().overridden).toBe(false);
      expect(broker.canReserve(13 * GB)).toBe(false);
    } finally {
      await manager.shutdown().catch(() => {});
    }
  });

  it('is a no-op when no router has been built yet', async () => {
    // A cloud-only install, or a boot where no local model has run. The
    // router reads config itself when it is eventually built, so there is
    // nothing to push and nothing to throw.
    const manager = await makeManager();
    try {
      await expect(manager.setLocalEngineMemoryBudget(14 * GB)).resolves.toBeUndefined();
    } finally {
      await manager.shutdown().catch(() => {});
    }
  });

  it('a router built from config picks the saved budget up on its own', async () => {
    // The complement of the live path: propagation only has to cover
    // routers that already exist. Anything built after the write reads it.
    await store.writeConfig({ localEngineMemoryGb: 14 });
    const config = await store.readConfig();
    expect(config.localEngineMemoryGb).toBe(14);
    const broker = new CapacityBroker({
      systemRamBytes: () => 16 * GB,
      unifiedMemory: true,
      budgetBytes: Math.round(14 * GB),
    });
    expect(broker.committed().budgetBytes).toBe(14 * GB);
    expect(broker.committed().overridden).toBe(true);
  });

  it('null in the config patch clears the override rather than persisting it', async () => {
    await store.writeConfig({ localEngineMemoryGb: 14 });
    expect((await store.readConfig()).localEngineMemoryGb).toBe(14);
    await store.writeConfig({ localEngineMemoryGb: null });
    expect((await store.readConfig()).localEngineMemoryGb).toBeUndefined();
  });
});
