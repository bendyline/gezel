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

/**
 * A migrated gezel's role-based name is its plain title ("crew-lead"), but
 * models trained on older prompts and people used to the old crew still
 * type the Dutch one ("voorman"). Both must find the same gezel.
 */

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
  home = await mkdtemp(join(tmpdir(), 'gezel-renamed-roles-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
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

describe('resolving a gezel by a renamed role', () => {
  it('finds the crew lead by its old role-based name', async () => {
    const lead = await store.createGezel({ name: 'Maya', role: 'Voorman' });
    expect(lead.role).toBe('Crew Lead');
    expect(lead.roleBasedName).toBe('crew-lead');
    expect(await manager.resolveGezelIdRef('crew-lead')).toBe(lead.id);
    expect(await manager.resolveGezelIdRef('voorman')).toBe(lead.id);
    expect(await manager.resolveGezelIdRef('Voorman')).toBe(lead.id);
  });

  it('lets a gezel actually named after the old title win', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    const named = await store.createGezel({ name: 'Voorman', role: 'Developer' });
    expect(await manager.resolveGezelIdRef('voorman')).toBe(named.id);
  });
});
