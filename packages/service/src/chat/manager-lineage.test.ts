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
 * Durable delegation lineage — the contract documented on
 * SessionParentSchema (core/src/schemas/session-lineage.ts):
 *
 * - `session.parentSession` records which session OPENED the thread.
 *   It is retro-stamped first-parent-wins on the first delegated contact
 *   with an already-existing session (the shape that used to leave it
 *   null for whole eval runs) and never overwritten by later senders.
 * - `ChatMessage.from.sessionId`/`kind` is the per-edge ground truth for
 *   every individual delegated message, later senders included.
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
let events: ChatEventBus;
let mock: MockProvider;
let manager: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-lineage-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
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

async function waitForCondition(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

describe('delegation lineage', () => {
  it('retro-stamps parentSession on an existing session and keeps the first parent', async () => {
    await store.createGezel({ name: 'Maya', role: 'Voorman' });
    await store.createGezel({ name: 'Leo', role: 'Researcher' });
    // Maya's session exists BEFORE any delegation reaches it — the shape
    // that used to leave parentSession null for the life of the session.
    const mayaSession = await manager.createSession({ gezelId: 'maya' });
    expect(mayaSession.parentSession).toBeUndefined();
    const adaSession = await manager.createSession({ gezelId: 'ada' });
    mock.script('On it.');

    const res = await manager.messageGezel({
      fromGezelId: 'ada',
      fromSessionId: adaSession.id,
      toGezelIdOrName: 'maya',
      text: 'first contact',
    });
    expect(res.sessionId).toBe(mayaSession.id);
    await waitForCondition(async () => {
      const disk = await store.getSession('maya', mayaSession.id);
      return (disk?.messages.length ?? 0) >= 2;
    });
    const afterFirst = await store.getSession('maya', mayaSession.id);
    expect(afterFirst!.parentSession).toEqual({
      sessionId: adaSession.id,
      gezelId: 'ada',
      kind: 'delegation',
    });
    expect(afterFirst!.messages[0]?.from).toMatchObject({
      gezelId: 'ada',
      sessionId: adaSession.id,
      kind: 'delegation',
    });

    // A second sender is an edge, not a parent: from.sessionId records the
    // edge while parentSession keeps the first opener (first-parent-wins).
    const leoSession = await manager.createSession({ gezelId: 'leo' });
    mock.script('Understood.');
    await manager.messageGezel({
      fromGezelId: 'leo',
      fromSessionId: leoSession.id,
      toGezelIdOrName: 'maya',
      text: 'second contact',
    });
    await waitForCondition(async () => {
      const disk = await store.getSession('maya', mayaSession.id);
      return (disk?.messages.filter((m) => m.role === 'user').length ?? 0) >= 2;
    });
    const afterSecond = await store.getSession('maya', mayaSession.id);
    expect(afterSecond!.parentSession).toEqual({
      sessionId: adaSession.id,
      gezelId: 'ada',
      kind: 'delegation',
    });
    const leoMsg = afterSecond!.messages.find((m) => m.from?.gezelId === 'leo');
    expect(leoMsg?.from).toMatchObject({ sessionId: leoSession.id, kind: 'delegation' });
  });
});
