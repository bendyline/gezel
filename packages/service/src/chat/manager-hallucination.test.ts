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
 * The hallucination detector + system prompt rules don't *prevent*
 * fabrication on a small local model — they catch it after the fact.
 * The user-facing payoff is the warning banner attached to the bubble.
 *
 * Before this fix, the warning was published as a streaming event but
 * dropped when the streaming slot was replaced by the persisted
 * `ChatMessage`. Reload (or even just turn-completion) erased the only
 * signal that the previous response was a lie. This test guards
 * against regressing back into that silent state.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

describe('ChatManager — hallucinated tool-use detector wiring', () => {
  let home: string;
  let store: Store;
  let events: ChatEventBus;
  let manager: ChatManager;
  let mock: MockProvider;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-halluc-'));
    store = new Store({ home });
    await store.ensureLayout();
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createProject({ name: 'Default' });
    // Pin the gezel to a local provider — the detector only fires for
    // local providers, so cloud-routed tests stay quiet.
    await store.writeConfig({ provider: 'mlx' });
    events = new ChatEventBus();
    mock = new MockProvider({ name: 'mlx' });
    manager = new ChatManager({
      store,
      events,
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['mlx', mock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
  });

  afterEach(async () => {
    await manager.drainBackground();
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  it('attaches a persistent warning to the assistant message when the model fabricates tool use', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    // The verbatim Yusuf-the-Meester pattern — past-tense action
    // verb + multiple bracket placeholders, no real tool call.
    mock.script(
      'I have successfully loaded the page and taken a snapshot.\n\nGlobal Focus: Major developments in [Region X] regarding [Topic Y] dominated international coverage.\n\nDomestic Politics: Key legislative debates are underway concerning [Policy Z].',
    );
    await manager.send(session.id, 'summarize the news');

    const disk = await store.getSession('ada', session.id);
    expect(disk).toBeTruthy();
    const assistantMsg = disk!.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg!.warnings).toBeDefined();
    expect(assistantMsg!.warnings!.length).toBeGreaterThan(0);
    expect(assistantMsg!.warnings![0]).toMatch(/fabricated|placeholder|navigated/i);
  });

  it('does not attach a warning when the assistant reply is clean', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script("Hello! I'm Ada. How can I help you today?");
    await manager.send(session.id, 'hi');

    const disk = await store.getSession('ada', session.id);
    const assistantMsg = disk!.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg!.warnings).toBeUndefined();
  });
});
