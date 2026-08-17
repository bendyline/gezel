import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMSession, ModelInfo, SessionOpts } from '../types.js';
import { CapacityBroker } from './capacity-broker.js';
import { makeEngineKey } from './engine-key.js';
import { type ProviderBuilder, ProviderPool, capacityDenialLogLine } from './provider-pool.js';

const GB = 1024 ** 3;

class FakeProvider implements LLMProvider {
  readonly name = 'mlx';
  shutdownCalls = 0;
  constructor(public readonly label: string) {}
  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
  async createSession(_opts: SessionOpts): Promise<LLMSession> {
    throw new Error('not used in tests');
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

function mkBuilder(bytes: number, modelWeightsBytes?: number): ProviderBuilder {
  return async ({ modelId, replicaIdx }) => ({
    provider: new FakeProvider(`${modelId}:${replicaIdx}`),
    residentBytes: bytes,
    ...(modelWeightsBytes !== undefined ? { modelWeightsBytes } : {}),
  });
}

/**
 * Fake with a controllable queue snapshot — flips the pool's busy
 * check. Mirrors how real providers expose `queue.snapshot()`.
 */
class BusyFakeProvider extends FakeProvider {
  busy = false;
  readonly queue = {
    snapshot: () => ({
      running: this.busy ? 1 : 0,
      queuedInteractive: 0,
      queuedBackground: 0,
    }),
  } as unknown as import('../queue.js').ProviderQueue;
}

function mkBusyBuilder(bytes: number, made: BusyFakeProvider[]): ProviderBuilder {
  return async ({ modelId, replicaIdx }) => {
    const p = new BusyFakeProvider(`${modelId}:${replicaIdx}`);
    made.push(p);
    return { provider: p, residentBytes: bytes };
  };
}

type Describe = ReturnType<import('../queue.js').ProviderQueue['describe']>;

function mkDesc(partial: Partial<Describe>): Describe {
  return {
    running: 0,
    runningInteractive: 0,
    runningBackground: 0,
    queuedInteractive: 0,
    queuedBackground: 0,
    ambientHeld: 0,
    concurrency: 1,
    interactiveConcurrency: 1,
    backgroundConcurrency: 1,
    active: [],
    pending: [],
    ...partial,
  };
}

/**
 * Fake exposing the richer `queue.describe()` (plus `batch`) that
 * {@link ProviderPool.queueSummaries} folds across replicas. `desc` and
 * `batchWidth` are mutable so a test can stage a running/queued state
 * after the replica is built — same pattern as {@link BusyFakeProvider}.
 */
class QueueFakeProvider extends FakeProvider {
  desc: Describe = mkDesc({});
  batchWidth = 1;
  readonly queue = {
    describe: () => this.desc,
    snapshot: () => ({
      running: this.desc.running,
      queuedInteractive: this.desc.queuedInteractive,
      queuedBackground: this.desc.queuedBackground,
    }),
    cancelPending: (id: number) => {
      const before = this.desc.pending.length;
      this.desc.pending = this.desc.pending.filter((p) => p.id !== id);
      return this.desc.pending.length < before;
    },
    movePending: (id: number, _direction: 'up' | 'down') =>
      this.desc.pending.some((p) => p.id === id),
  } as unknown as import('../queue.js').ProviderQueue;
  get batch(): import('../types.js').BatchCapability {
    return { maxConcurrency: this.batchWidth } as unknown as import('../types.js').BatchCapability;
  }
}

function mkQueueBuilder(bytes: number, made: QueueFakeProvider[]): ProviderBuilder {
  return async ({ modelId, replicaIdx }) => {
    const p = new QueueFakeProvider(`${modelId}:${replicaIdx}`);
    made.push(p);
    return { provider: p, residentBytes: bytes };
  };
}

class LaunchFakeProvider extends FakeProvider {
  engineLaunchSnapshot() {
    return {
      pid: 4242,
      startedAt: 1_700_000_000_000,
      diagnostics: { model: this.label, contextPerSlot: 65_536, slots: 1 },
    };
  }
}

describe('ProviderPool', () => {
  it('engineLaunchSnapshots() attributes live launches to provider + model, skipping engines without one', async () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({
      broker,
      builders: {
        mlx: async ({ modelId, replicaIdx }) => ({
          provider: new LaunchFakeProvider(`${modelId}:${replicaIdx}`),
          residentBytes: 10 * GB,
        }),
        'llama-cpp': mkBuilder(10 * GB),
      },
    });

    await pool.ensure('mlx', 'gemma4-26b', 0, 10 * GB);
    await pool.ensure('llama-cpp', 'qwen3.5-4b-q4', 0, 10 * GB);

    const snapshots = pool.engineLaunchSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      provider: 'mlx',
      modelId: 'gemma4-26b',
      snapshot: { pid: 4242, diagnostics: { contextPerSlot: 65_536 } },
    });
  });

  it('ensure() builds on miss and hits cache on second call', async () => {
    const builder = vi.fn(mkBuilder(10 * GB, 8 * GB));
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: builder } });

    const a = await pool.ensure('mlx', 'gemma4-26b', 0, 10 * GB);
    const b = await pool.ensure('mlx', 'gemma4-26b', 0, 10 * GB);
    expect(a).toBe(b);
    expect(pool.peekProvidersForModel('mlx', 'gemma4-26b')).toEqual([a]);
    expect(pool.peekProvidersForModel('mlx', 'other')).toEqual([]);
    expect(builder).toHaveBeenCalledTimes(1);
    const snapshot = pool.snapshot();
    expect(snapshot.committedBytes).toBe(10 * GB);
    expect(snapshot.entries[0]).toMatchObject({
      residentBytes: 10 * GB,
      modelWeightsBytes: 8 * GB,
    });
  });

  it('LRU-evicts the oldest entry when budget is exhausted', async () => {
    const t = { now: 1000 };
    const broker = new CapacityBroker({ budgetBytes: 25 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBuilder(10 * GB) },
      now: () => t.now,
    });

    await pool.ensure('mlx', 'a', 0, 10 * GB);
    t.now += 1000;
    await pool.ensure('mlx', 'b', 0, 10 * GB);
    // Touch 'a' so it stays warmer than 'b'.
    t.now += 1000;
    pool.touch(makeEngineKey('mlx', 'a', 0));
    t.now += 1000;
    // Now spawn 'c'. Budget = 25 GB, two 10 GB engines = 20 GB
    // committed; a third doesn't fit. LRU victim is 'b'.
    await pool.ensure('mlx', 'c', 0, 10 * GB);

    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'c', 0))).toBe(true);
  });

  it('serializes instead of spilling when a second model would leave the card', async () => {
    // 64 GB host / 32 GB card with spillover off: usable VRAM ~30.4 GB, so
    // 20 + 20 fits the BUDGET (68 GB) but not the card. The co-residency
    // rule must reach the pool as an eviction, not a hard denial — and it
    // must be the idle-victim path, since falling through to the busy path
    // is how this shows up as a torn-down in-flight turn.
    const t = { now: 1000 };
    const broker = new CapacityBroker({
      systemRamBytes: () => 64 * GB,
      gpuVramBytes: 32 * GB,
      unifiedMemory: false,
      allowRamSpillover: false,
    });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBuilder(20 * GB) },
      now: () => t.now,
    });

    await pool.ensure('mlx', 'a', 0, 20 * GB);
    t.now += 1000;
    await pool.ensure('mlx', 'b', 0, 20 * GB);

    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(true);
    expect(broker.committedBytes()).toBe(20 * GB);
  });

  it('keeps both models resident when spillover is allowed', async () => {
    const broker = new CapacityBroker({
      systemRamBytes: () => 64 * GB,
      gpuVramBytes: 32 * GB,
      unifiedMemory: false,
      allowRamSpillover: true,
    });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(20 * GB) } });

    await pool.ensure('mlx', 'a', 0, 20 * GB);
    await pool.ensure('mlx', 'b', 0, 20 * GB);

    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(true);
  });

  it('still loads a single model larger than the card with spillover off', async () => {
    const broker = new CapacityBroker({
      systemRamBytes: () => 64 * GB,
      gpuVramBytes: 32 * GB,
      unifiedMemory: false,
      allowRamSpillover: false,
    });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(40 * GB) } });

    await pool.ensure('mlx', 'big-moe', 0, 40 * GB);

    expect(pool.has(makeEngineKey('mlx', 'big-moe', 0))).toBe(true);
  });

  it('demand-weighted eviction keeps a frequently-hit model over a newer idle one', async () => {
    const t = { now: 1000 };
    const broker = new CapacityBroker({ budgetBytes: 25 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBuilder(10 * GB) },
      now: () => t.now,
    });

    // 'a' loaded first, then hit repeatedly → high recent demand (3 hits).
    await pool.ensure('mlx', 'a', 0, 10 * GB);
    t.now = 1100;
    pool.touch(makeEngineKey('mlx', 'a', 0));
    t.now = 1200;
    pool.touch(makeEngineKey('mlx', 'a', 0));
    // 'b' loaded LATER (newer lastUsedAt) but hit only once → low demand.
    t.now = 2000;
    await pool.ensure('mlx', 'b', 0, 10 * GB);

    // Spawn 'c' — one of a/b must be evicted. Pure-LRU would drop 'a' (older
    // lastUsedAt); demand-weighting drops the low-demand 'b' and keeps the
    // hot 'a'. This test fails under the old pure-oldest ordering.
    t.now = 2001;
    await pool.ensure('mlx', 'c', 0, 10 * GB);

    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'c', 0))).toBe(true);
  });

  it('release on broker happens after provider.shutdown', async () => {
    const broker = new CapacityBroker({ budgetBytes: 20 * GB });
    let shutdownAtCommitted = -1;
    const builder: ProviderBuilder = async ({ modelId, replicaIdx }) => {
      const p = new FakeProvider(`${modelId}:${replicaIdx}`);
      const origShutdown = p.shutdown.bind(p);
      p.shutdown = async () => {
        shutdownAtCommitted = broker.committedBytes();
        return origShutdown();
      };
      return { provider: p, residentBytes: 10 * GB };
    };
    const pool = new ProviderPool({ broker, builders: { mlx: builder } });
    await pool.ensure('mlx', 'x', 0, 10 * GB);
    await pool.evict(makeEngineKey('mlx', 'x', 0));
    // shutdown was observed while the broker still showed 10 GB committed.
    expect(shutdownAtCommitted).toBe(10 * GB);
    // After evict, broker is clear.
    expect(broker.committedBytes()).toBe(0);
  });

  it('unloadIdle() immediately releases an idle model', async () => {
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 20 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
    });
    const key = makeEngineKey('mlx', 'idle-model', 0);
    await pool.ensure('mlx', 'idle-model', 0, 10 * GB);

    await expect(pool.unloadIdle(key)).resolves.toBe(true);
    expect(pool.has(key)).toBe(false);
    expect(made[0]?.shutdownCalls).toBe(1);
    expect(broker.committedBytes()).toBe(0);
  });

  it('unloadIdle() refuses a model that became busy', async () => {
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 20 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
    });
    const key = makeEngineKey('mlx', 'busy-model', 0);
    await pool.ensure('mlx', 'busy-model', 0, 10 * GB);
    made[0]!.busy = true;

    await expect(pool.unloadIdle(key)).rejects.toThrow(/currently serving requests/);
    expect(pool.has(key)).toBe(true);
    expect(made[0]?.shutdownCalls).toBe(0);
    expect(broker.committedBytes()).toBe(10 * GB);
  });

  it('releaseIdle() frees idle models and leaves a busy one streaming', async () => {
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 60 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
    });
    await pool.ensure('mlx', 'idle-a', 0, 10 * GB);
    await pool.ensure('mlx', 'mid-turn', 0, 10 * GB);
    await pool.ensure('mlx', 'idle-b', 0, 10 * GB);
    const busyKey = makeEngineKey('mlx', 'mid-turn', 0);
    made[1]!.busy = true;

    const stillResident = await pool.releaseIdle();

    expect(stillResident).toEqual([busyKey]);
    expect(pool.has(makeEngineKey('mlx', 'idle-a', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'idle-b', 0))).toBe(false);
    expect(pool.has(busyKey)).toBe(true);
    // The turn on the busy engine is untouched — that is the whole point.
    expect(made[1]?.shutdownCalls).toBe(0);
    expect(broker.committedBytes()).toBe(10 * GB);
  });

  it('parallel ensure() on the same key collapses to a single build', async () => {
    let buildCount = 0;
    const builder: ProviderBuilder = async ({ modelId, replicaIdx }) => {
      buildCount += 1;
      // Force a real microtask gap so two awaits actually overlap.
      await new Promise((r) => setTimeout(r, 5));
      return { provider: new FakeProvider(`${modelId}:${replicaIdx}`), residentBytes: 4 * GB };
    };
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: builder } });
    const [a, b, c] = await Promise.all([
      pool.ensure('mlx', 'q', 0, 4 * GB),
      pool.ensure('mlx', 'q', 0, 4 * GB),
      pool.ensure('mlx', 'q', 0, 4 * GB),
    ]);
    expect(buildCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('denies (without building) a model larger than the whole budget, with a friendly message', async () => {
    const broker = new CapacityBroker({ budgetBytes: 10 * GB });
    const builder = vi.fn(mkBuilder(14 * GB));
    const pool = new ProviderPool({ broker, builders: { mlx: builder } });

    const err = await pool.ensure('mlx', 'gemma4-12b-q4', 0, 14 * GB).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // Human-readable: names the model, uses GB, and points at a fix.
    expect(err?.message).toContain('gemma4-12b-q4');
    expect(err?.message).toMatch(/14\.0 GB/);
    expect(err?.message).toMatch(/raise the memory budget in Settings/);
    // No raw byte dump.
    expect(err?.message).not.toMatch(/\d{10}/);
    // Pre-flight denial: the model was never built/spawned.
    expect(builder).not.toHaveBeenCalled();
    expect(pool.has(makeEngineKey('mlx', 'gemma4-12b-q4', 0))).toBe(false);
  });

  it('capacityDenialLogLine matches the eval-harness regexes as-written', () => {
    const broker = new CapacityBroker({ budgetBytes: 10 * GB });
    const line = capacityDenialLogLine('llama-cpp:big-model:0', broker.denialReason(14 * GB));
    // Copied verbatim from evals/src/runner.ts readCapacityDenialFromLog —
    // the strictest of the three eval-side regexes.
    expect(line).toMatch(
      /capacity broker denied [^\n]+: budget exhausted: would commit \d+ against \d+/,
    );
    // The looser classifier/preflight shape (evals/src/failure-class.ts,
    // evals/src/preflight.ts).
    expect(line).toMatch(/capacity broker denied [^\n]*budget exhausted/);
  });

  it('logs the denial line at the pre-check deny site while still throwing user prose', async () => {
    const broker = new CapacityBroker({ budgetBytes: 10 * GB });
    const builder = vi.fn(mkBuilder(14 * GB));
    const pool = new ProviderPool({ broker, builders: { mlx: builder } });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(pool.ensure('mlx', 'big-model', 0, 14 * GB)).rejects.toThrow(
        /raise the memory budget in Settings/,
      );
      const logged = write.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toMatch(
        /capacity broker denied mlx:big-model:0: budget exhausted: would commit \d+ against \d+/,
      );
    } finally {
      write.mockRestore();
    }
  });

  it('logs the denial line at the reserve-race deny site (builder outgrows the estimate)', async () => {
    // Pre-flight estimate fits (5 GB < 10 GB budget) but the builder's
    // actual working set (14 GB) can never be reserved — the second
    // reserve after makeRoom fails and must log before throwing.
    const broker = new CapacityBroker({ budgetBytes: 10 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(14 * GB) } });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(pool.ensure('mlx', 'grower', 0, 5 * GB)).rejects.toThrow(
        /raise the memory budget in Settings/,
      );
      const logged = write.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toMatch(
        /capacity broker denied mlx:grower:0: budget exhausted: would commit \d+ against \d+/,
      );
    } finally {
      write.mockRestore();
    }
  });

  it('evicts multiple idle victims concurrently to make room for a big model', async () => {
    // Instrument shutdown to record peak concurrency. If makeRoom evicts
    // serially, peak stays at 1; the parallel idle-batch path drives it
    // above 1.
    let active = 0;
    let peak = 0;
    const builder: ProviderBuilder = async ({ modelId, replicaIdx }) => {
      const p = new FakeProvider(`${modelId}:${replicaIdx}`);
      p.shutdown = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
      };
      return { provider: p, residentBytes: modelId === 'big' ? 30 * GB : 10 * GB };
    };
    const t = { now: 1000 };
    const broker = new CapacityBroker({ budgetBytes: 35 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: builder }, now: () => t.now });

    // Three idle 10 GB models = 30 GB committed (fits under 35).
    await pool.ensure('mlx', 'a', 0, 10 * GB);
    t.now += 1;
    await pool.ensure('mlx', 'b', 0, 10 * GB);
    t.now += 1;
    await pool.ensure('mlx', 'c', 0, 10 * GB);

    // A 30 GB model needs 25 GB freed (30 + 30 - 35) → evict all three
    // idle victims. They should tear down in parallel, not serially.
    t.now += 1;
    await pool.ensure('mlx', 'big', 0, 30 * GB);

    expect(peak).toBeGreaterThan(1);
    expect(pool.has(makeEngineKey('mlx', 'big', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'c', 0))).toBe(false);
    expect(broker.committedBytes()).toBe(30 * GB);
  });

  it('evicts only as many idle victims as needed to fit', async () => {
    const t = { now: 1000 };
    const broker = new CapacityBroker({ budgetBytes: 35 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBuilder(10 * GB) },
      now: () => t.now,
    });
    await pool.ensure('mlx', 'a', 0, 10 * GB);
    t.now += 1;
    await pool.ensure('mlx', 'b', 0, 10 * GB);
    t.now += 1;
    await pool.ensure('mlx', 'c', 0, 10 * GB);
    // A 10 GB model needs just 5 GB freed (30 + 10 - 35) → evict only
    // the single oldest idle victim ('a'), leaving 'b' and 'c' resident.
    t.now += 1;
    await pool.ensure('mlx', 'd', 0, 10 * GB);
    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'c', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'd', 0))).toBe(true);
  });

  it('throws when no builder is registered for a provider', async () => {
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({ broker, builders: {} });
    await expect(pool.ensure('mlx', 'a', 0, 1 * GB)).rejects.toThrow(/no ProviderBuilder/);
  });

  it('shutdown evicts every entry', async () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(5 * GB) } });
    await pool.ensure('mlx', 'a', 0, 5 * GB);
    await pool.ensure('mlx', 'b', 0, 5 * GB);
    await pool.ensure('mlx', 'c', 0, 5 * GB);
    expect(pool.snapshot().entries).toHaveLength(3);
    await pool.shutdown();
    expect(pool.snapshot().entries).toHaveLength(0);
    expect(broker.committedBytes()).toBe(0);
  });

  it('reconcile spawns missing replicas up to clone count', async () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(10 * GB) } });
    await pool.reconcile([{ provider: 'mlx', modelId: 'gemma4-26b', clones: 2 }], () => 10 * GB);
    expect(pool.has(makeEngineKey('mlx', 'gemma4-26b', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'gemma4-26b', 1))).toBe(true);
    expect(pool.existingReplicas('mlx', 'gemma4-26b')).toEqual([0, 1]);
  });

  it('reconcile evicts replicas above the new clone count', async () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(10 * GB) } });
    await pool.ensure('mlx', 'gemma4-26b', 0, 10 * GB);
    await pool.ensure('mlx', 'gemma4-26b', 1, 10 * GB);
    await pool.ensure('mlx', 'gemma4-26b', 2, 10 * GB);
    await pool.reconcile([{ provider: 'mlx', modelId: 'gemma4-26b', clones: 1 }], () => 10 * GB);
    expect(pool.existingReplicas('mlx', 'gemma4-26b')).toEqual([0]);
    expect(broker.committedBytes()).toBe(10 * GB);
  });

  it('reconcile leaves models not enumerated in target alone', async () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(5 * GB) } });
    await pool.ensure('mlx', 'qwen3.6', 0, 5 * GB);
    await pool.reconcile([{ provider: 'mlx', modelId: 'gemma4-26b', clones: 1 }], () => 5 * GB);
    expect(pool.has(makeEngineKey('mlx', 'qwen3.6', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'gemma4-26b', 0))).toBe(true);
  });

  it('reconcile is best-effort under capacity pressure', async () => {
    // Budget allows only 1 clone of 30 GB.
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(30 * GB) } });
    await pool.reconcile([{ provider: 'mlx', modelId: 'gemma4-26b', clones: 2 }], () => 30 * GB);
    // One spawns; the second triggers LRU eviction of the first
    // (only candidate), then spawns. Net result: 1 resident, idx 1
    // (the latest spawn won). The pool is best-effort about
    // pre-spawning when capacity is tight.
    expect(pool.existingReplicas('mlx', 'gemma4-26b').length).toBe(1);
    expect(broker.committedBytes()).toBe(30 * GB);
  });

  it('pickReplicaForBind returns least-loaded existing replica', async () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(10 * GB) } });
    await pool.ensure('mlx', 'g', 0, 10 * GB);
    await pool.ensure('mlx', 'g', 1, 10 * GB);

    const loads = new Map<string, number>([
      [makeEngineKey('mlx', 'g', 0), 3],
      [makeEngineKey('mlx', 'g', 1), 1],
    ]);
    expect(pool.pickReplicaForBind('mlx', 'g', loads)).toBe(1);
  });

  it('pickReplicaForBind returns 0 when no replicas exist', () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(10 * GB) } });
    expect(pool.pickReplicaForBind('mlx', 'g', new Map())).toBe(0);
  });

  it('makeRoom prefers an idle victim over an older busy one', async () => {
    const t = { now: 1000 };
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 25 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      now: () => t.now,
    });

    await pool.ensure('mlx', 'a', 0, 10 * GB); // oldest…
    made[0]!.busy = true; // …but mid-turn
    t.now += 1000;
    await pool.ensure('mlx', 'b', 0, 10 * GB); // newer and idle
    t.now += 1000;
    await pool.ensure('mlx', 'c', 0, 10 * GB); // needs room

    // Strict LRU would kill busy 'a'; busy-aware selection kills idle 'b'.
    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(true);
    expect(pool.has(makeEngineKey('mlx', 'b', 0))).toBe(false);
    expect(pool.has(makeEngineKey('mlx', 'c', 0))).toBe(true);
  });

  it('evict on a busy entry drains, then completes once the queue empties', async () => {
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      // Each drain poll "finishes" the in-flight turn.
      sleep: async () => {
        made[0]!.busy = false;
      },
    });
    await pool.ensure('mlx', 'a', 0, 10 * GB);
    made[0]!.busy = true;

    await pool.evict(makeEngineKey('mlx', 'a', 0));
    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(false);
    expect(made[0]!.shutdownCalls).toBe(1);
    expect(broker.committedBytes()).toBe(0);
  });

  it('evict on a busy entry throws after the drain cap, leaving the engine resident', async () => {
    const t = { now: 1000 };
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      now: () => t.now,
      drainWaitMs: 30_000,
      sleep: async () => {
        t.now += 31_000; // blow past the cap; turn never finishes
      },
    });
    await pool.ensure('mlx', 'a', 0, 10 * GB);
    made[0]!.busy = true;

    await expect(pool.evict(makeEngineKey('mlx', 'a', 0))).rejects.toMatchObject({
      code: 'engine-busy',
      message: expect.stringMatching(/busy/),
    });
    // Engine untouched: still resident, never shut down, capacity kept.
    expect(pool.has(makeEngineKey('mlx', 'a', 0))).toBe(true);
    expect(made[0]!.shutdownCalls).toBe(0);
    expect(broker.committedBytes()).toBe(10 * GB);
    // Draining flag cleared so the entry serves hits again.
    expect(pool.snapshot().entries[0]!.draining).toBe(false);
  });

  it('ensure on a draining key waits for the eviction, then rebuilds fresh', async () => {
    const made: BusyFakeProvider[] = [];
    let releaseDrain!: () => void;
    const gate = new Promise<void>((r) => {
      releaseDrain = r;
    });
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      sleep: () => gate,
    });
    const key = makeEngineKey('mlx', 'a', 0);
    const original = await pool.ensure('mlx', 'a', 0, 10 * GB);
    made[0]!.busy = true;

    const evicting = pool.evict(key); // parks in the drain loop
    await new Promise((r) => setTimeout(r, 5));
    const reEnsure = pool.ensure('mlx', 'a', 0, 10 * GB); // must NOT hand out the draining entry

    made[0]!.busy = false;
    releaseDrain();
    await evicting;
    const rebuilt = await reEnsure;

    expect(rebuilt).not.toBe(original);
    expect(made).toHaveLength(2);
    expect(pool.has(key)).toBe(true);
  });

  it('shutdown force-evicts busy entries without draining', async () => {
    const made: BusyFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      sleep: async () => {
        throw new Error('shutdown must not enter the drain loop');
      },
    });
    await pool.ensure('mlx', 'a', 0, 10 * GB);
    made[0]!.busy = true;

    await pool.shutdown();
    expect(pool.snapshot().entries).toHaveLength(0);
    expect(made[0]!.shutdownCalls).toBe(1);
    expect(broker.committedBytes()).toBe(0);
  });

  it('broker retirement drains background work without a deadline and blocks new ensures', async () => {
    const made: BusyFakeProvider[] = [];
    let releaseDrain!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      sleep: () => gate,
    });
    await pool.ensure('mlx', 'background-model', 0, 10 * GB);
    made[0]!.busy = true;

    const retirement = pool.retire();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(made[0]!.shutdownCalls).toBe(0);
    await expect(pool.ensure('mlx', 'other-model', 0, 10 * GB)).rejects.toThrow(/retired/);

    made[0]!.busy = false;
    releaseDrain();
    await retirement;

    expect(made[0]!.shutdownCalls).toBe(1);
    expect(pool.snapshot().entries).toHaveLength(0);
    expect(broker.committedBytes()).toBe(0);
  });

  it('does not rebuild an ensure that was parked on a drain when retirement begins', async () => {
    const made: BusyFakeProvider[] = [];
    let releaseDrain!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      sleep: () => gate,
    });
    const key = makeEngineKey('mlx', 'adopting-model', 0);
    await pool.ensure('mlx', 'adopting-model', 0, 10 * GB);
    made[0]!.busy = true;

    const evicting = pool.evict(key);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const parkedEnsure = pool.ensure('mlx', 'adopting-model', 0, 10 * GB);
    const retirement = pool.retire();

    made[0]!.busy = false;
    releaseDrain();
    await evicting;
    await expect(parkedEnsure).rejects.toThrow(/retired/);
    await retirement;

    expect(made).toHaveLength(1);
    expect(pool.snapshot().entries).toHaveLength(0);
  });

  it('pickReplicaForBind skips draining replicas', async () => {
    const made: BusyFakeProvider[] = [];
    let releaseDrain!: () => void;
    const gate = new Promise<void>((r) => {
      releaseDrain = r;
    });
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBusyBuilder(10 * GB, made) },
      sleep: () => gate,
    });
    await pool.ensure('mlx', 'g', 0, 10 * GB);
    await pool.ensure('mlx', 'g', 1, 10 * GB);
    made[0]!.busy = true;
    const evicting = pool.evict(makeEngineKey('mlx', 'g', 0)); // replica 0 now draining
    await new Promise((r) => setTimeout(r, 5));

    // Replica 0 is less loaded but draining — bind must pick 1.
    const loads = new Map<string, number>([
      [makeEngineKey('mlx', 'g', 0), 0],
      [makeEngineKey('mlx', 'g', 1), 5],
    ]);
    expect(pool.pickReplicaForBind('mlx', 'g', loads)).toBe(1);

    made[0]!.busy = false;
    releaseDrain();
    await evicting;
  });

  it('queueSummaries folds running/queued + job labels across a providers replicas', async () => {
    const made: QueueFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { 'llama-cpp': mkQueueBuilder(5 * GB, made) },
    });
    await pool.ensure('llama-cpp', 'qwen', 0, 5 * GB);
    await pool.ensure('llama-cpp', 'qwen', 1, 5 * GB);

    // Replica 0 is decoding a background one-shot (the digest case that
    // read "Idle"); replica 1 has two more background jobs queued behind it.
    made[0]!.desc = mkDesc({
      running: 1,
      active: [{ job: 'digest · client-project', runningForMs: 1200 }],
    });
    made[0]!.batchWidth = 3;
    made[1]!.desc = mkDesc({
      queuedBackground: 2,
      pending: [{ id: 7, lane: 'background', job: 'memory', waitedMs: 300 }],
    });
    made[1]!.batchWidth = 3;

    const s = pool.queueSummaries().get('llama-cpp')!;
    expect(s.running).toBe(1);
    expect(s.queuedBackground).toBe(2);
    // Summed across the two resident replicas (3 + 3).
    expect(s.maxConcurrency).toBe(6);
    expect(s.active.map((a) => a.job)).toEqual(['digest · client-project']);
    expect(s.pending.map((p) => p.job)).toEqual(['memory']);
  });

  it('queueSummaries returns an empty map for an empty pool', () => {
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({ broker, builders: {} });
    expect(pool.queueSummaries().size).toBe(0);
  });

  it('cancelPendingQueueItem cancels on the replica that holds the id', async () => {
    const made: QueueFakeProvider[] = [];
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { 'llama-cpp': mkQueueBuilder(5 * GB, made) },
    });
    await pool.ensure('llama-cpp', 'qwen', 0, 5 * GB);
    await pool.ensure('llama-cpp', 'qwen', 1, 5 * GB);
    made[1]!.desc = mkDesc({
      queuedBackground: 1,
      pending: [{ id: 7, lane: 'background', job: 'memory', waitedMs: 300 }],
    });

    expect(pool.cancelPendingQueueItem('llama-cpp', 7)).toBe(true);
    expect(made[1]!.desc.pending).toHaveLength(0);
    // A second cancel of the same id finds nothing on any replica.
    expect(pool.cancelPendingQueueItem('llama-cpp', 7)).toBe(false);
    // A different provider name never matches these llama-cpp replicas.
    made[1]!.desc = mkDesc({ pending: [{ id: 9, lane: 'background', waitedMs: 10 }] });
    expect(pool.cancelPendingQueueItem('mlx', 9)).toBe(false);
    expect(pool.movePendingQueueItem('llama-cpp', 9, 'up')).toBe(true);
  });

  it('onChange fires on spawn and evict', async () => {
    const events: number[] = [];
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkBuilder(5 * GB) },
      onChange: (s) => events.push(s.entries.length),
    });
    await pool.ensure('mlx', 'a', 0, 5 * GB);
    await pool.ensure('mlx', 'b', 0, 5 * GB);
    await pool.evict(makeEngineKey('mlx', 'a', 0));
    expect(events).toEqual([1, 2, 1]);
  });

  // A builder that reports how many loads overlap — the observable the GPU
  // load serializer controls. macOS's IOGPUMemory "prepare count underflow"
  // is a refcount race two concurrent GPU maps can trip; serializing keeps
  // maxOverlap at 1.
  function mkOverlapBuilder(
    bytes: number,
    state: { active: number; maxOverlap: number },
  ): ProviderBuilder {
    return async ({ modelId, replicaIdx }) => {
      state.active += 1;
      state.maxOverlap = Math.max(state.maxOverlap, state.active);
      await new Promise((r) => setTimeout(r, 15));
      state.active -= 1;
      return { provider: new FakeProvider(`${modelId}:${replicaIdx}`), residentBytes: bytes };
    };
  }

  it('serializes GPU model loads (never two builders overlap) when enabled', async () => {
    const state = { active: 0, maxOverlap: 0 };
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkOverlapBuilder(5 * GB, state) },
      serializeGpuLoads: true,
    });
    await Promise.all([
      pool.ensure('mlx', 'model-a', 0, 5 * GB),
      pool.ensure('mlx', 'model-b', 0, 5 * GB),
    ]);
    expect(state.maxOverlap).toBe(1);
  });

  it('loads concurrently when serialization is disabled (proves the flag matters)', async () => {
    const state = { active: 0, maxOverlap: 0 };
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const pool = new ProviderPool({
      broker,
      builders: { mlx: mkOverlapBuilder(5 * GB, state) },
      serializeGpuLoads: false,
    });
    await Promise.all([
      pool.ensure('mlx', 'model-a', 0, 5 * GB),
      pool.ensure('mlx', 'model-b', 0, 5 * GB),
    ]);
    expect(state.maxOverlap).toBe(2);
  });

  it('a failed serialized load does not wedge the chain', async () => {
    let calls = 0;
    const broker = new CapacityBroker({ budgetBytes: 64 * GB });
    const builder: ProviderBuilder = async ({ modelId, replicaIdx }) => {
      calls += 1;
      if (calls === 1) throw new Error('first load fails');
      return { provider: new FakeProvider(`${modelId}:${replicaIdx}`), residentBytes: 5 * GB };
    };
    const pool = new ProviderPool({ broker, builders: { mlx: builder }, serializeGpuLoads: true });
    await expect(pool.ensure('mlx', 'boom', 0, 5 * GB)).rejects.toThrow('first load fails');
    // The next load still proceeds — the chain wasn't left rejected.
    const p = await pool.ensure('mlx', 'ok', 0, 5 * GB);
    expect(p).toBeDefined();
  });
});
