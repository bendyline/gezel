import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XP_WEIGHTS, countTaskWork } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskFilesStore } from '../fs/task-files-store.js';
import { HistoryManager } from '../history/manager.js';
import { MemoryManager } from '../memory/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { GrowthEngine } from './engine.js';
import { GrowthHistoryTally } from './history-tally.js';

vi.mock('@bendyline/gezel-inference/internal/memory/embeddings', () => {
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % vector.length]! += text.charCodeAt(i) / 255;
    }
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };

  class EmbeddingsDisabledError extends Error {
    readonly code = 'EMBEDDINGS_DISABLED';
  }

  return {
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => null,
    embed: async (text: string) => vectorFor(text),
    embedQuery: async (text: string) => vectorFor(text),
    embedBatch: async (texts: string[]) => texts.map(vectorFor),
  };
});

let home: string;
let store: Store;
let memory: MemoryManager;
let history: HistoryManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-growth-engine-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  memory = new MemoryManager(store);
  await store.createGezel({ name: 'Sprout' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

function engine(opts?: {
  klerkReply?: string;
  announce?: (gezelId: string, toLevel: number) => Promise<void>;
}): GrowthEngine {
  return new GrowthEngine({
    store,
    memory,
    history,
    oneShot: async () => opts?.klerkReply ?? 'NONE',
    ...(opts?.announce ? { announce: opts.announce } : {}),
  });
}

/** Seed N pref memories (6 XP each) directly — dedup isn't under test. */
async function seedPrefs(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.appendMemory('gezel', 'sprout', `Distinct preference number ${i}.`, 'pref');
  }
}

describe('GrowthEngine.refresh', () => {
  it('computes and persists signals without leveling below the threshold', async () => {
    await seedPrefs(5); // 30 XP < 100
    const state = await engine().refresh('sprout', { allowKlerk: false });
    expect(state.level).toBe(1);
    expect(state.xp).toBe(30);
    expect(state.pendingLevelUp).toBeUndefined();
    const persisted = await store.readGezelGrowth('sprout');
    expect(persisted.xp).toBe(30);
    expect(persisted.lastComputedAt).toBeTruthy();
  });

  it('creates a pending level-up, logs history, and announces on threshold crossing', async () => {
    await seedPrefs(17); // 102 XP ≥ 100
    const announced: Array<[string, number]> = [];
    const state = await engine({
      announce: async (id, lvl) => void announced.push([id, lvl]),
    }).refresh('sprout', { allowKlerk: false });

    expect(state.level).toBe(1); // level advances only on user resolution
    expect(state.pendingLevelUp?.toLevel).toBe(2);
    // allowKlerk=false → payout-only proposals.
    expect(state.pendingLevelUp?.proposals.map((p) => p.kind)).toEqual(['tuning', 'cosmetic']);
    expect(announced).toEqual([['sprout', 2]]);

    const events = await history.listEvents({ gezelId: 'sprout', kinds: ['gezel.level.up'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ toLevel: 2 });

    // Summary chip now carries the pending flag.
    const detail = await store.getGezel('sprout');
    expect(detail?.growth).toEqual({ level: 1, pending: true });
  });

  it('is idempotent — an existing pending is kept, not regenerated', async () => {
    await seedPrefs(17);
    const e = engine({ announce: async () => {} });
    const first = await e.refresh('sprout', { allowKlerk: false });
    const pendingIds = first.pendingLevelUp?.proposals.map((p) => p.id);

    await seedPrefs(5); // more XP arrives while pending
    const second = await e.refresh('sprout', { allowKlerk: false });
    expect(second.pendingLevelUp?.toLevel).toBe(2);
    expect(second.pendingLevelUp?.proposals.map((p) => p.id)).toEqual(pendingIds);
    expect(second.xp).toBeGreaterThan(first.xp); // XP still refreshes

    const events = await history.listEvents({ gezelId: 'sprout', kinds: ['gezel.level.up'] });
    expect(events).toHaveLength(1); // no duplicate announcement
  });

  it('ratchets: a shrunken corpus never lowers XP', async () => {
    await seedPrefs(17);
    await engine().refresh('sprout', { allowKlerk: false });
    // Simulate compaction wiping the daily files.
    const days = await store.listMemoryDays('gezel', 'sprout');
    for (const day of days) await store.deleteMemoryDay('gezel', 'sprout', day);
    const state = await engine().refresh('sprout', { allowKlerk: false });
    expect(state.signals.memoryXp).toBe(102);
  });

  it('credits a gezel for what it saved about the person, and no one else for it', async () => {
    await store.appendMemory('user', 'user', 'Prefers metric units.', 'pref', { gezel: 'sprout' });
    await store.appendMemory('user', 'user', 'Lives in Utrecht.', 'fact', {
      gezel: 'someone-else',
    });
    const state = await engine().refresh('sprout', { allowKlerk: false });
    expect(state.signals.memoryXp).toBe(6);
  });

  it('no-ops when growth is disabled', async () => {
    await store.writeConfig({ growth: { enabled: false } });
    await seedPrefs(17);
    const state = await engine().refresh('sprout', { allowKlerk: true });
    expect(state.xp).toBe(0);
    expect(state.pendingLevelUp).toBeUndefined();
  });

  it('includes Klerk trait proposals when allowed and evidence validates', async () => {
    await seedPrefs(17);
    const today = new Date().toISOString().slice(0, 10);
    const reply = [
      'PROPOSAL',
      'TITLE: Numbered preferences',
      'TRAIT: Keep stating distinct preferences clearly.',
      `EVIDENCE: ${today} :: Distinct preference number 3.`,
      'END',
    ].join('\n');
    const state = await engine({ klerkReply: reply }).refresh('sprout', { allowKlerk: true });
    expect(state.pendingLevelUp?.proposals.map((p) => p.kind)).toEqual([
      'trait',
      'tuning',
      'cosmetic',
    ]);
    const trait = state.pendingLevelUp?.proposals.find((p) => p.kind === 'trait');
    expect(trait?.kind === 'trait' && trait.evidence[0]?.day).toBe(today);
  });
});

// Task work and history counts are kept, not rescanned: a refresh after the
// first reads neither the task corpus nor the audit log.
describe('GrowthEngine live inputs', () => {
  const work = (gezelId: string) =>
    store.listAllTasks().then((all) => countTaskWork(all, gezelId));

  async function finishTask(tasks: TaskManager, title: string): Promise<void> {
    const task = await tasks.create('default', {
      title,
      assignee: { kind: 'gezel', gezelId: 'sprout' },
      steps: [{ name: 'Main', terminal: true }],
    });
    await tasks.completeStep('default', task.num, task.activeStepId!);
  }

  it('credits finished work and new events without re-reading old tasks or the log', async () => {
    const tasks = new TaskManager(store);
    await finishTask(tasks, 'First');
    await finishTask(tasks, 'Second');
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'lessons' });
    const e = engine();
    const first = await e.refresh('sprout', { allowKlerk: false, createPending: false });
    const before = await work('sprout');
    expect(before.completedTasks).toBe(2);
    expect(first.signals.taskXp).toBe(
      before.completedSteps * XP_WEIGHTS.stepCompleted + 2 * XP_WEIGHTS.taskCompleted,
    );
    expect(first.signals.lessonsXp).toBe(XP_WEIGHTS.lessonsUpdate);

    const scans = vi.spyOn(HistoryManager.prototype, 'iterateEvents');
    const reads = vi.spyOn(TaskFilesStore.prototype, 'readTask');
    await finishTask(tasks, 'Third');
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'again' });
    await history.log({ kind: 'gezel.message.delivered', gezelId: 'sprout', summary: 'sent' });
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'other', summary: 'not ours' });
    reads.mockClear();
    const second = await e.refresh('sprout', { allowKlerk: false, createPending: false });
    expect(scans).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    const after = await work('sprout');
    expect(after.completedTasks).toBe(3);
    expect(second.signals.taskXp).toBe(
      after.completedSteps * XP_WEIGHTS.stepCompleted + 3 * XP_WEIGHTS.taskCompleted,
    );
    expect(second.signals.lessonsXp).toBe(2 * XP_WEIGHTS.lessonsUpdate);
    expect(second.signals.consultXp).toBe(XP_WEIGHTS.consultationDelivered);
  });

  it('counts an event appended while the first pass runs exactly once', async () => {
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'old' });
    const tally = new GrowthHistoryTally(history);
    const iterate = history.iterateEvents.bind(history);
    vi.spyOn(history, 'iterateEvents').mockImplementation(async function* (opts) {
      // Append mid-pass: the pass may or may not reach it; either way it counts once.
      await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'mid' });
      yield* iterate(opts);
    });
    expect((await tally.countsFor('sprout')).lessonsUpdates).toBe(2);
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'late' });
    expect((await tally.countsFor('sprout')).lessonsUpdates).toBe(3);
  });

  it('rebuilds after a redaction removes events from a gezel', async () => {
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'one' });
    await history.log({ kind: 'memory.lessons-updated', gezelId: 'sprout', summary: 'two' });
    const tally = new GrowthHistoryTally(history);
    expect((await tally.countsFor('sprout')).lessonsUpdates).toBe(2);
    await history.redactEvents({ fields: ['identifiers'] });
    expect((await tally.countsFor('sprout')).lessonsUpdates).toBe(0);
  });
});
