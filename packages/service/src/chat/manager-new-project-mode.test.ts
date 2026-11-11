import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let manager: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-new-project-mode-'));
  store = new Store({ home });
  await store.ensureLayout();
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', new MockProvider({ name: 'copilot' })]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

// A new project's shape follows the strategy the install's default model
// works best under: a crew for stepwise, one gezel alone otherwise.
describe('ChatManager.newProjectMode', () => {
  it('is one gezel alone for a default model that works best with one owner', async () => {
    await store.writeConfig({ provider: 'copilot' });
    await expect(manager.newProjectMode()).resolves.toBe('solo');
    await store.writeConfig({ provider: 'llama-cpp' });
    await expect(manager.newProjectMode()).resolves.toBe('solo');
  });

  it("is a crew when the person's settings say stepwise", async () => {
    await store.writeConfig({ provider: 'copilot', generalistMode: 'off' });
    await expect(manager.newProjectMode()).resolves.toBe('crew');
    await store.writeConfig({ provider: 'copilot', taskStrategy: 'stepwise' });
    await expect(manager.newProjectMode()).resolves.toBe('crew');
    await store.writeConfig({
      provider: 'copilot',
      taskStrategy: 'outcome',
      generalistMode: 'off',
    });
    await expect(manager.newProjectMode()).resolves.toBe('solo');
  });
});
