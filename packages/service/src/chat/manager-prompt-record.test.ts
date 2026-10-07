import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
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

describe('ChatManager prompt record', () => {
  let home: string;
  let store: Store;
  let history: HistoryManager;
  let mock: MockProvider;
  let debug: boolean;
  let manager: ChatManager;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-prompt-record-'));
    history = new HistoryManager(home);
    store = new Store({ home, history });
    await store.ensureLayout();
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.writeConfig({ provider: 'mlx' });
    mock = new MockProvider({ name: 'mlx' });
    debug = false;
    manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['mlx', mock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
      history,
      debug: { isEnabled: () => debug },
    });
  });

  afterEach(async () => {
    await manager.drainBackground();
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  async function compiledEvents() {
    await manager.drainBackground();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return (await history.listEvents()).filter((event) => event.kind === 'prompt.compiled');
  }

  it('logs the system prompt sizes once per distinct prompt, without its text', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Hello.');
    await manager.send(session.id, 'hi');
    mock.script('Hello again.');
    await manager.send(session.id, 'and again');

    const events = await compiledEvents();
    expect(events).toHaveLength(1);
    const details = events[0]?.details as Record<string, unknown>;
    expect(details.sessionId).toBe(session.id);
    expect(details.provider).toBe('mlx');
    expect(details.footprint).toBeTypeOf('string');
    expect(details.systemTokens).toBeGreaterThan(0);
    const sections = details.sections as Array<{ name: string; tokens: number }>;
    expect(sections.map((s) => s.name)).toContain('about (persona body)');
    expect(JSON.stringify(details)).not.toContain('The section below is your "about" document');
    await expect(readdir(join(home, 'logs', 'prompts'))).rejects.toThrow();
  });

  it('keeps the prompt text in debug mode', async () => {
    debug = true;
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Hello.');
    await manager.send(session.id, 'hi');
    await compiledEvents();

    const files = await readdir(join(home, 'logs', 'prompts', session.id));
    expect(files).toHaveLength(1);
  });
});
