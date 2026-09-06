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

let home: string;
let manager: ChatManager;
let mock: MockProvider;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-file-intent-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    home,
    events: new ChatEventBus(),
    memory: {
      save: async () => {},
      search: async () => [],
      searchAll: async () => [],
      reindex: async () => 0,
      writeSummary: async () => {},
      getRecent: async () => '',
    } as unknown as MemoryManager,
    getPort: () => 0,
    getToken: () => 'test-token',
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});
afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('per-message file intent delivery', () => {
  it('keeps structured repair intents distinct while queued nudges drain', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('started', 'first reply', 'second reply');
    const a = { kind: 'repair-file' as const, path: 'lib/worker.py' };
    const b = { kind: 'create-file' as const, path: 'reports/summary.rst' };
    // send claims the session synchronously, before provider/MCP startup.
    // Queue both nudges in this tick so cold-start speed cannot decide whether
    // they queue. Await every send before asserting, even if startup fails.
    const first = manager.send(session.id, 'start');
    const second = manager.send(session.id, 'continue with the repair', {
      nudge: true,
      fileTurnIntent: a,
    });
    const third = manager.send(session.id, 'create the requested output', {
      nudge: true,
      fileTurnIntent: b,
    });
    const queued = manager.listSessionQueue(session.id);
    await Promise.all([first, second, third]);
    expect(queued).toMatchObject([
      { text: 'continue with the repair', nudge: true },
      { text: 'create the requested output', nudge: true },
    ]);
    const sends = mock.calls.filter(
      (call) => call.kind === 'send' && call.sendOpts?.queue?.sessionId === session.id,
    );
    expect(sends.map((call) => call.sendOpts?.fileTurnIntent)).toEqual([undefined, a, b]);
    expect(manager.listSessionQueue(session.id)).toEqual([]);
  });
  it('preserves intent when the message takes the mention delivery path', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script('Done.');
    const fileTurnIntent = { kind: 'repair-file' as const, path: 'lib/parser.py' };
    await manager.sendWithMentions({
      primarySessionId: session.id,
      text: 'Continue the repair.',
      mentionGezelIds: ['ada'],
      fileTurnIntent,
    });
    const send = mock.calls.find(
      (call) => call.kind === 'send' && call.sendOpts?.queue?.sessionId === session.id,
    );
    expect(send?.sendOpts?.fileTurnIntent).toEqual(fileTurnIntent);
  });
});
