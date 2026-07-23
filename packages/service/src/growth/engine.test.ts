import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { MemoryManager } from '../memory/manager.js';
import { GrowthEngine } from './engine.js';

vi.mock('../memory/embeddings.js', () => {
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
