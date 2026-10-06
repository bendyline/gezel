import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import type { LLMSession, SessionOpts, WireTranscriptEntry } from '../providers/types.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * Restart continuity for local-engine sessions. A session rebuilt from saved
 * history renders a different prompt than the one the engine cached before the
 * restart (the replay dedupes, budgets and labels tool results), so the engine
 * re-prefills everything past the system prompt. The live session's own
 * transcript is checkpointed instead and, when the history still agrees,
 * reseeds the rebuilt session verbatim.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

// What the live MLX session actually sent: real tool arguments and the raw
// result — the shapes a rebuild from saved history cannot reproduce.
const LIVE: WireTranscriptEntry[] = [
  { role: 'user', content: 'Review the README.' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-1', name: 'read_file', arguments: '{"path":"README.md","startLine":1}' },
    ],
  },
  { role: 'tool', content: '# Project\nTwo stale links.', toolCallId: 'call-1' },
  { role: 'assistant', content: 'Two stale links in the README.' },
];

let home: string;
let store: Store;
const managers: ChatManager[] = [];

function managerWith(mock: MockProvider): ChatManager {
  const manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['mlx', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  managers.push(manager);
  return manager;
}

/** A mock MLX provider whose sessions expose a live transcript, like MlxSession does. */
function mlxMock(transcript: () => WireTranscriptEntry[] | undefined): {
  mock: MockProvider;
  opts: SessionOpts[];
} {
  const mock = new MockProvider({ name: 'mlx' });
  const opts: SessionOpts[] = [];
  const create = mock.createSession.bind(mock);
  mock.createSession = async (sessionOpts: SessionOpts): Promise<LLMSession> => {
    opts.push(sessionOpts);
    const session = await create(sessionOpts);
    return Object.assign(session, { getWireTranscript: transcript });
  };
  return { mock, opts };
}

async function waitForCheckpoint(gezelId: string, sessionId: string) {
  for (let i = 0; i < 100; i++) {
    const saved = await store.readSessionWireTranscript(gezelId, sessionId);
    if (saved) return saved;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no wire transcript checkpoint was written');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-wire-transcript-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.writeConfig({ provider: 'mlx' });
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.drainBackground();
    await manager.shutdown();
  }
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager wire-transcript checkpoints', () => {
  it('a session rebuilt after a restart is reseeded with the transcript the engine cached', async () => {
    const before = mlxMock(() => LIVE);
    const first = managerWith(before.mock);
    const record = await first.createSession({ gezelId: 'ada' });
    before.mock.script('Two stale links in the README.');
    await first.send(record.id, 'Review the README.');
    const checkpoint = await waitForCheckpoint('ada', record.id);
    expect(checkpoint).toMatchObject({ inTurn: false, providerName: 'mlx', transcript: LIVE });
    expect(checkpoint.basis.count).toBe(2);
    await first.shutdown();

    // A fresh daemon: nothing live, everything from disk.
    const after = mlxMock(() => undefined);
    const second = managerWith(after.mock);
    after.mock.script('Fixed both.');
    await second.send(record.id, 'Fix them.');
    expect(after.opts[0]?.priorMessages).toEqual(LIVE);
  });

  it('falls back to the rebuild from saved history when the history moved on without it', async () => {
    const before = mlxMock(() => LIVE);
    const first = managerWith(before.mock);
    const record = await first.createSession({ gezelId: 'ada' });
    before.mock.script('Two stale links in the README.');
    await first.send(record.id, 'Review the README.');
    await waitForCheckpoint('ada', record.id);
    // Another turn lands in the saved history that the checkpoint never saw.
    const saved = await store.getSession('ada', record.id);
    saved!.messages.push(
      { role: 'user', content: 'And the docs?', at: new Date().toISOString() },
      { role: 'assistant', content: 'Docs are fine.', at: new Date().toISOString() },
    );
    await store.writeSession(saved!);
    await first.shutdown();

    const after = mlxMock(() => undefined);
    const second = managerWith(after.mock);
    after.mock.script('ok');
    await second.send(record.id, 'Thanks.');
    const prior = after.opts[0]?.priorMessages ?? [];
    expect(prior).not.toEqual(LIVE);
    expect(prior.map((m) => m.content)).toContain('Docs are fine.');
  });

  it('removes the checkpoint with its session', async () => {
    const before = mlxMock(() => LIVE);
    const manager = managerWith(before.mock);
    const record = await manager.createSession({ gezelId: 'ada' });
    before.mock.script('Two stale links in the README.');
    await manager.send(record.id, 'Review the README.');
    await waitForCheckpoint('ada', record.id);
    await store.deleteSession('ada', record.id);
    expect(await store.readSessionWireTranscript('ada', record.id)).toBeNull();
  });
});
