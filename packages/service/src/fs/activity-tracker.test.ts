import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { HistoryManager } from '../history/manager.js';
import { ActivityTracker } from './activity-tracker.js';
import { Store } from './store.js';

let home: string;
let store: Store;
let history: HistoryManager;
let chatEvents: ChatEventBus;
let tracker: ActivityTracker;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-activity-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  chatEvents = new ChatEventBus();
  tracker = new ActivityTracker({ store, history, chatEvents });
});

afterEach(async () => {
  await tracker.stop();
  await rm(home, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitForPersistedActivity(projectId: string, expectedAt?: string) {
  const deadline = Date.now() + 1_000;
  do {
    const activity = await store.readProjectActivity(projectId);
    if (activity && (!expectedAt || activity.lastActivityAt === expectedAt)) return activity;
    await settle();
  } while (Date.now() < deadline);
  return store.readProjectActivity(projectId);
}

describe('ActivityTracker', () => {
  it('stamps activity from project-scoped history events', async () => {
    const project = await store.createProject({ name: 'Vogelhuis' });
    tracker.start();
    await history.log({ kind: 'task.created', projectId: project.id, summary: 'Task made' });
    await settle();
    const at = await tracker.lastActivityAt(project.id);
    expect(at).not.toBeNull();
    // First stamp persists immediately (nothing on disk yet).
    expect(await waitForPersistedActivity(project.id)).not.toBeNull();
  });

  it('stamps activity from chat event envelopes', async () => {
    const project = await store.createProject({ name: 'Praat' });
    tracker.start();
    chatEvents.publish(
      { sessionId: 's1', gezelId: 'g1', projectId: project.id },
      { type: 'delta', content: 'hello' },
    );
    await settle();
    expect(await tracker.lastActivityAt(project.id)).not.toBeNull();
  });

  it('ignores its own ambient-generator events', async () => {
    const project = await store.createProject({ name: 'Stil' });
    tracker.start();
    await history.log({
      kind: 'meester.status.generated',
      projectId: project.id,
      summary: 'Status written',
    });
    await history.log({
      kind: 'project.digest.generated',
      projectId: project.id,
      summary: 'Digest written',
    });
    await settle();
    expect(await tracker.lastActivityAt(project.id)).toBeNull();
  });

  it('debounces disk writes until the stamp moves past the threshold', async () => {
    const project = await store.createProject({ name: 'Zaag' });
    const t0 = Date.parse('2026-07-18T10:00:00Z');
    const firstAt = new Date(t0).toISOString();
    tracker.stamp(project.id, t0);
    const first = await waitForPersistedActivity(project.id, firstAt);
    expect(first?.lastActivityAt).toBe(firstAt);

    // Two minutes later — in memory only, disk unchanged.
    tracker.stamp(project.id, t0 + 2 * 60_000);
    await settle();
    expect((await store.readProjectActivity(project.id))?.lastActivityAt).toBe(
      new Date(t0).toISOString(),
    );
    expect(await tracker.lastActivityAt(project.id)).toBe(new Date(t0 + 2 * 60_000).toISOString());

    // Past the 5-minute threshold — persisted.
    tracker.stamp(project.id, t0 + 6 * 60_000);
    const latestAt = new Date(t0 + 6 * 60_000).toISOString();
    expect((await waitForPersistedActivity(project.id, latestAt))?.lastActivityAt).toBe(latestAt);
  });

  it('flushes pending stamps on stop', async () => {
    const project = await store.createProject({ name: 'Klaar' });
    const t0 = Date.parse('2026-07-18T10:00:00Z');
    tracker.stamp(project.id, t0);
    await settle();
    tracker.stamp(project.id, t0 + 60_000);
    await tracker.stop();
    expect((await store.readProjectActivity(project.id))?.lastActivityAt).toBe(
      new Date(t0 + 60_000).toISOString(),
    );
  });

  it('never bumps project.updatedAt when persisting a stamp', async () => {
    const project = await store.createProject({ name: 'Meta' });
    const before = (await store.getProject(project.id))?.updatedAt;
    tracker.stamp(project.id, Date.now());
    await settle();
    expect((await store.getProject(project.id))?.updatedAt).toBe(before);
  });

  it('reads a stamp persisted by a previous process', async () => {
    const project = await store.createProject({ name: 'Oud' });
    await store.writeProjectActivity(project.id, {
      lastActivityAt: '2026-07-17T08:00:00.000Z',
    });
    const fresh = new ActivityTracker({ store, history, chatEvents });
    expect(await fresh.lastActivityAt(project.id)).toBe('2026-07-17T08:00:00.000Z');
    await fresh.stop();
  });
});
