import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
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

async function setupOllamaManager(opts: { numCtx: number; promptChars: () => number }) {
  const home = await mkdtemp(join(tmpdir(), 'gezel-compact-now-test-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  await store.writeConfig({ provider: 'ollama' });
  const events = new ChatEventBus();
  const mock = new MockProvider({ name: 'ollama' });
  mock.ollamaContextConfig = opts;
  const manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['ollama', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  return { home, store, events, manager, mock };
}

describe('ChatManager — manual context compaction', () => {
  it('compacts on demand from the context meter, off-turn', async () => {
    const { home, manager, events, mock, store } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => 400,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      for (let i = 0; i < 20; i++) {
        seeded!.messages.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i} with enough text to be worth summarizing`,
          at: new Date().toISOString(),
        });
      }
      seeded!.contextWindow = 1000;
      seeded!.contextAutoCompactRatio = 0.7;
      seeded!.contextEstimatedTokens = 640;
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      const eventTypes: string[] = [];
      events.subscribe(session.id, (event) => eventTypes.push(event.type));
      mock.script('- compacted bullet 1\n- compacted bullet 2');

      const result = await manager.compactSessionNow(session.id);

      expect(result.compacted).toBe(true);
      expect(result.removedCount).toBe(14);
      expect(eventTypes).toContain('context_compacted');
      const record = await store.getSession('ada', session.id);
      expect(record?.compactionCount).toBe(1);
      expect(
        record?.messages.filter((message) => message.synthetic === 'compaction-summary'),
      ).toHaveLength(1);
      expect(record?.contextEstimatedTokens).toBeUndefined();
      const [summary] = await store.listSessions({ gezelId: 'ada' });
      expect(summary?.transcriptTokens).toBeGreaterThan(0);
      expect(summary?.transcriptTokens).toBeLessThan(640);
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses a thread with nothing older to fold', async () => {
    const { home, manager, store } = await setupOllamaManager({
      numCtx: 1000,
      promptChars: () => 100,
    });
    try {
      const session = await manager.createSession({ gezelId: 'ada' });
      const seeded = await store.getSession('ada', session.id);
      seeded!.contextWindow = 1000;
      await store.writeSession(seeded!);
      await manager.reset(session.id);

      await expect(manager.compactSessionNow(session.id)).resolves.toEqual({
        compacted: false,
        reason: 'too-short',
      });
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    }
  });
});
