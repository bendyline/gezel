import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * ChatManager.deliverReaction — the delivery half of project-type page
 * reactions: system-authored, from-less, background-lane, coalescable.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let mock: MockProvider;
let manager: ChatManager | undefined;
let previousMemoryExtractionSetting: string | undefined;

function buildManager(memory: MemoryManager = noopMemory): ChatManager {
  return new ChatManager({
    store,
    events: new ChatEventBus(),
    memory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
}

beforeEach(async () => {
  previousMemoryExtractionSetting = process.env.GEZEL_DISABLE_MEMORY_EXTRACTION;
  // Reaction delivery is the behavior under test. Keeping unrelated
  // post-turn extraction out of the background queue makes completion
  // deterministic and avoids exercising the deliberately minimal memory
  // stub below.
  process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = '1';
  home = await mkdtemp(join(tmpdir(), 'manager-reactions-'));
  store = new Store({ home });
  await store.ensureLayout();
  mock = new MockProvider({ name: 'copilot' });
});

afterEach(async () => {
  await manager?.drainBackground();
  await manager?.shutdown();
  manager = undefined;
  if (previousMemoryExtractionSetting === undefined) {
    delete process.env.GEZEL_DISABLE_MEMORY_EXTRACTION;
  } else {
    process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = previousMemoryExtractionSetting;
  }
  await rm(home, { recursive: true, force: true });
});

describe('deliverReaction', () => {
  it('returns null (and creates nothing) when engagement is off', async () => {
    await store.writeConfig({ aiEngagementMode: 'off' });
    manager = buildManager();
    const project = await store.createProject({ name: 'Off Game' });
    const gezel = await store.createGezel({ name: 'Speler', role: 'Damspeler' });

    const result = await manager.deliverReaction({
      projectId: project.id,
      gezelId: gezel.id,
      seed: '[Checkers page]: your move',
    });
    expect(result).toBeNull();
    expect(await store.listSessions({ gezelId: gezel.id })).toHaveLength(0);
  });

  it('delivers the seed into the live (gezel, project) session as a user-shaped turn', async () => {
    manager = buildManager();
    const project = await store.createProject({ name: 'Live Game' });
    const gezel = await store.createGezel({ name: 'Speler', role: 'Damspeler' });
    mock.script('On my way — nice move!');

    const result = await manager.deliverReaction({
      projectId: project.id,
      gezelId: gezel.id,
      seed: '[Checkers page]: your move on c3-d4',
    });
    expect(result).not.toBeNull();

    // deliverReaction intentionally returns after enqueueing its turn. Wait
    // on the manager's actual background-work contract instead of polling
    // disk with Vitest's short, load-sensitive default timeout.
    await manager.drainBackground();

    const record = await store.getSession(gezel.id, result!.sessionId);
    expect(record?.projectId).toBe(project.id);
    const seed = record?.messages.find((m) => m.role === 'user');
    expect(seed?.content).toBe('[Checkers page]: your move on c3-d4');
    const reply = record?.messages.find((m) => m.role === 'assistant');
    expect(reply?.content).toContain('nice move');
  });

  it('does not auto-recall for a hidden machine-authored reaction', async () => {
    const recallMemory = {
      ...noopMemory,
      hasIndex: vi.fn(() => true),
      embedQuery: vi.fn(async () => [0.1, 0.2]),
      searchVector: vi.fn(async () => []),
    } as unknown as MemoryManager;
    manager = buildManager(recallMemory);
    const project = await store.createProject({ name: 'Hidden Game' });
    const gezel = await store.createGezel({ name: 'Speler', role: 'Damspeler' });
    mock.script('Your move landed.');

    const result = await manager.deliverReaction({
      projectId: project.id,
      gezelId: gezel.id,
      seed: '[Checkers page]: your move on c3-d4',
      hidden: true,
    });
    expect(result).not.toBeNull();

    await manager.drainBackground();

    expect(recallMemory.embedQuery).not.toHaveBeenCalled();
    const record = await store.getSession(gezel.id, result!.sessionId);
    expect(record?.messages[0]).toMatchObject({
      role: 'user',
      hidden: true,
    });
    expect(record?.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Your move landed.',
    });
  });

  it('coalesces rapid reactions arriving while a turn is in flight into ONE merged turn', async () => {
    manager = buildManager();
    const project = await store.createProject({ name: 'Busy Game' });
    const gezel = await store.createGezel({ name: 'Speler', role: 'Damspeler' });

    // Hold the first turn in flight long enough for both reactions to land
    // on the pending queue, where the from-less coalescable bucket merges
    // them.
    mock.scriptSendDelay(400);
    mock.script('First reply', 'Merged reply');

    const first = await manager.deliverReaction({
      projectId: project.id,
      gezelId: gezel.id,
      seed: '[Checkers page]: opener',
    });
    expect(first).not.toBeNull();
    const second = await manager.deliverReaction({
      projectId: project.id,
      gezelId: gezel.id,
      seed: '[Checkers page]: move one',
    });
    const third = await manager.deliverReaction({
      projectId: project.id,
      gezelId: gezel.id,
      seed: '[Checkers page]: move two',
    });
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(third?.sessionId).toBe(first?.sessionId);

    await manager.drainBackground();

    const record = await store.getSession(gezel.id, first!.sessionId);
    const userMessages = record?.messages.filter((m) => m.role === 'user') ?? [];
    // Turn 1: the opener. Turn 2: the two queued reactions merged into one
    // user message (never three separate turns).
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]?.content).toContain('move one');
    expect(userMessages[1]?.content).toContain('move two');
    expect(record?.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });
});
