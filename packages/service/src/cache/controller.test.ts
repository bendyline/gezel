import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheWarmMessage, EngineCacheAdapter, EngineCacheUsage } from './adapter.js';
import { SessionCacheController } from './controller.js';

/**
 * Mock adapter recording every interaction, with hooks for controlled
 * `reportUsage` outputs. Lets us assert eviction calls, exercise
 * reconcile-replaces-entries semantics, and simulate engines that
 * report different state than the controller estimated.
 */
class MockAdapter implements EngineCacheAdapter {
  readonly providerName: string;
  readonly evictCalls: string[][] = [];
  readonly buildCalls: string[] = [];
  readonly warmCalls: Array<{ sessionId: string; messages: readonly CacheWarmMessage[] }> = [];
  reportUsageImpl: () => Promise<readonly EngineCacheUsage[]> = async () => [];

  constructor(name = 'mlx') {
    this.providerName = name;
  }

  buildRequestExtras(sessionId: string): Record<string, unknown> {
    this.buildCalls.push(sessionId);
    return { cache_id: sessionId };
  }

  async evict(sessionIds: readonly string[]): Promise<void> {
    this.evictCalls.push([...sessionIds]);
  }

  async reportUsage(): Promise<readonly EngineCacheUsage[]> {
    return this.reportUsageImpl();
  }

  async warm(sessionId: string, messages: readonly CacheWarmMessage[]): Promise<void> {
    this.warmCalls.push({ sessionId, messages });
  }
}

let now = 1_700_000_000_000;
const fakeNow = () => now;

beforeEach(() => {
  now = 1_700_000_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionCacheController — registration + recording', () => {
  it('registers an adapter and records a turn', () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);

    ctrl.recordTurn({
      providerName: 'mlx',
      sessionId: 'sess-1',
      gezelId: 'yusuf',
      approxPromptTokens: 10_000,
      wasHit: false,
    });

    const stats = ctrl.getStats('mlx');
    expect(stats?.warmSessionCount).toBe(1);
    expect(stats?.sessions[0]?.sessionId).toBe('sess-1');
    expect(stats?.sessions[0]?.gezelId).toBe('yusuf');
    expect(stats?.sessions[0]?.tokenCount).toBe(10_000);
    expect(stats?.misses).toBe(1);
    expect(stats?.hits).toBe(0);
  });

  it('updates lastUsedAt and hit/miss counters across multiple turns on the same session', () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    ctrl.registerAdapter(new MockAdapter());

    ctrl.recordTurn({
      providerName: 'mlx',
      sessionId: 'sess-1',
      approxPromptTokens: 10_000,
      wasHit: false,
    });
    const firstStamp = ctrl.getStats('mlx')?.sessions[0]?.lastUsedAt;
    now += 5_000;
    ctrl.recordTurn({
      providerName: 'mlx',
      sessionId: 'sess-1',
      approxPromptTokens: 10_500,
      wasHit: true,
    });
    const stats = ctrl.getStats('mlx')!;
    expect(stats.sessions[0]?.lastUsedAt).toBe(firstStamp! + 5_000);
    expect(stats.sessions[0]?.tokenCount).toBe(10_500);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.recentHitRate).toBeCloseTo(0.5, 5);
  });

  it('returns null for unknown providers and empty stats with no turns', () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    expect(ctrl.getStats('mlx')).toBeNull();
    ctrl.registerAdapter(new MockAdapter());
    const empty = ctrl.getStats('mlx');
    expect(empty?.warmSessionCount).toBe(0);
    expect(empty?.recentHitRate).toBe(0);
  });
});

describe('SessionCacheController — invalidation', () => {
  it('drops the entry and notifies the adapter on invalidate(sessionId)', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 'sess-1', approxPromptTokens: 1_000 });
    ctrl.invalidate('sess-1');
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBe(0);
    // adapter eviction is fire-and-forget; await microtask flush
    await Promise.resolve();
    expect(adapter.evictCalls).toEqual([['sess-1']]);
  });

  it('clears all entries on invalidateProvider and resets hit/miss counters', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 'a', approxPromptTokens: 100, wasHit: true });
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 'b', approxPromptTokens: 100 });

    ctrl.invalidateProvider('mlx');
    const stats = ctrl.getStats('mlx')!;
    expect(stats.warmSessionCount).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    await Promise.resolve();
    // Adapter receives both session ids in one call.
    expect(adapter.evictCalls.length).toBe(1);
    expect(new Set(adapter.evictCalls[0])).toEqual(new Set(['a', 'b']));
  });

  it('invalidate is a no-op for sessions not in the cache (no spurious adapter call)', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    ctrl.invalidate('never-existed');
    await Promise.resolve();
    expect(adapter.evictCalls).toEqual([]);
  });
});

describe('SessionCacheController — budget enforcement (LRU eviction)', () => {
  it('evicts least-recently-used sessions when budget is exceeded', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    // At 100 KB/token estimate, 1 token = 100 KB. Budget of 450 KB lets
    // 4 entries (400 KB) fit comfortably under the high-watermark; the
    // 5th (500 KB) trips eviction with 360 KB target, so ≤ 3 survive.
    ctrl.setBudget('mlx', 450 * 1024);

    for (let i = 0; i < 4; i++) {
      now += 1000;
      ctrl.recordTurn({ providerName: 'mlx', sessionId: `s${i}`, approxPromptTokens: 1 });
    }
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBe(4);

    now += 1000;
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 's4', approxPromptTokens: 1 });
    await Promise.resolve();

    // Eviction target: 450 KB × 0.8 = 360 KB → 3 entries × 100 KB = 300 KB.
    const stats = ctrl.getStats('mlx')!;
    expect(stats.warmSessionCount).toBeLessThanOrEqual(3);
    // s4 (newest) and s3 must survive; s0 (oldest) is the first casualty.
    const remainingIds = new Set(stats.sessions.map((s) => s.sessionId));
    expect(remainingIds.has('s4')).toBe(true);
    expect(remainingIds.has('s3')).toBe(true);
    expect(remainingIds.has('s0')).toBe(false);
  });

  it('respects low-priority pinning — pinned sessions evicted last', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    // At 100 KB/token, 4 entries × 100 KB = 400 KB. Budget 400 KB +
    // a 5th entry trips eviction. With s0 pinned, LRU should walk
    // past it and evict an unpinned middle entry.
    ctrl.setBudget('mlx', 400 * 1024);

    ctrl.recordTurn({ providerName: 'mlx', sessionId: 's0', approxPromptTokens: 1 });
    ctrl.pin('s0', 'low');
    for (let i = 1; i < 5; i++) {
      now += 1000;
      ctrl.recordTurn({ providerName: 'mlx', sessionId: `s${i}`, approxPromptTokens: 1 });
    }
    await Promise.resolve();

    const stats = ctrl.getStats('mlx')!;
    const remainingIds = new Set(stats.sessions.map((s) => s.sessionId));
    expect(remainingIds.has('s0')).toBe(true); // pin survived
    // Newest entries also survive; one of the middle ones got evicted.
    expect(remainingIds.has('s4')).toBe(true);
  });

  it('lowering the budget mid-run triggers immediate eviction', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    // Generous budget — all sessions fit.
    ctrl.setBudget('mlx', 10 * 1024 * 1024);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      ctrl.recordTurn({ providerName: 'mlx', sessionId: `s${i}`, approxPromptTokens: 1 });
    }
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBe(5);

    // Tighten budget. At 100 KB/token, 5 entries × 100 KB = 500 KB.
    // Budget 250 KB + watermark 0.8 = 200 KB target → ≤ 2 entries.
    ctrl.setBudget('mlx', 250 * 1024);
    await Promise.resolve();
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBeLessThanOrEqual(2);
  });
});

describe('SessionCacheController — reconciliation against engine truth', () => {
  it('replaces tracked entries with adapter.reportUsage() output', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    // Controller estimates one session.
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 'sess-est', approxPromptTokens: 1_000 });

    // Engine reports a totally different picture — different session,
    // different size. After reconcile, controller should match engine.
    adapter.reportUsageImpl = async () => [
      { sessionId: 'sess-real', tokenCount: 5_000, estBytes: 50 * 1024 * 1024, lastUsedAt: now },
    ];
    await ctrl.reconcileProvider('mlx');

    const stats = ctrl.getStats('mlx')!;
    expect(stats.warmSessionCount).toBe(1);
    expect(stats.sessions[0]?.sessionId).toBe('sess-real');
    expect(stats.sessions[0]?.bytes).toBe(50 * 1024 * 1024);
  });

  it('preserves eviction priority across reconcile', async () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const adapter = new MockAdapter();
    ctrl.registerAdapter(adapter);
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 'pinned', approxPromptTokens: 1_000 });
    ctrl.pin('pinned', 'low');

    adapter.reportUsageImpl = async () => [
      { sessionId: 'pinned', tokenCount: 1_500, estBytes: 1_500_000, lastUsedAt: now },
    ];
    await ctrl.reconcileProvider('mlx');

    expect(ctrl.getStats('mlx')?.sessions[0]?.evictionPriority).toBe('low');
  });

  it('logs but swallows reportUsage errors (degrades gracefully)', async () => {
    const warn = vi.fn();
    const ctrl = new SessionCacheController({
      now: fakeNow,
      disableReconcileTimer: true,
      logger: { warn },
    });
    const adapter = new MockAdapter();
    adapter.reportUsageImpl = async () => {
      throw new Error('engine unreachable');
    };
    ctrl.registerAdapter(adapter);
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 's', approxPromptTokens: 100 });
    await ctrl.reconcileProvider('mlx');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reportUsage failed'));
    // Original entry unchanged.
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBe(1);
  });
});

describe('SessionCacheController — adapter swap on re-register', () => {
  it('replaces the adapter and clears tracked state', () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    const a = new MockAdapter();
    ctrl.registerAdapter(a);
    ctrl.recordTurn({ providerName: 'mlx', sessionId: 's1', approxPromptTokens: 1_000 });
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBe(1);

    // New adapter (same provider name) — supervisor restart scenario.
    const b = new MockAdapter();
    ctrl.registerAdapter(b);
    expect(ctrl.getStats('mlx')?.warmSessionCount).toBe(0);
  });
});

describe('SessionCacheController — getAllStats', () => {
  it('returns one entry per registered provider', () => {
    const ctrl = new SessionCacheController({ now: fakeNow, disableReconcileTimer: true });
    ctrl.registerAdapter(new MockAdapter('mlx'));
    ctrl.registerAdapter(new MockAdapter('llama-cpp'));
    const all = ctrl.getAllStats();
    expect(all.map((s) => s.providerName).sort()).toEqual(['llama-cpp', 'mlx']);
  });
});
