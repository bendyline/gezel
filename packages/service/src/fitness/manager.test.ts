import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelFitnessRecord } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { PoolSnapshot } from '../providers/native/provider-pool.js';
import { ModelFitnessManager, type ModelFitnessManagerOptions } from './manager.js';

const GB = 1024 ** 3;

function record(overrides: Partial<ModelFitnessRecord> = {}): ModelFitnessRecord {
  const ok = { ok: true, detail: 'fine' };
  return {
    schemaVersion: 1,
    provider: 'llama-cpp',
    modelId: 'gemma4-e4b-q4',
    status: 'probed',
    admitted: true,
    genTokensPerSec: 20,
    createdAt: '2026-07-07T00:00:00.000Z',
    durationMs: 1000,
    trigger: 'manual',
    sha256: 'aaa',
    catalogVersion: '1.0.0',
    host: { totalRamBytes: 128 * GB, gpuVramBytes: null, source: 'test' },
    checks: { spawn: ok, toolRoundTrip: ok, throughput: ok, reasoningBudget: ok, contextFit: ok },
    ...overrides,
  };
}

let home: string;
let store: Store;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-fitness-'));
  store = new Store({ home });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeManager(overrides: Partial<ModelFitnessManagerOptions> = {}): ModelFitnessManager {
  return new ModelFitnessManager({
    store,
    runProbe: async (args) => record({ provider: args.provider, modelId: args.modelId }),
    resolveInstalled: async () => ({
      sha256: 'aaa',
      catalogVersion: '1.0.0',
      approxSizeBytes: 5 * GB,
    }),
    engineStatus: async () => null,
    currentMemory: async () => ({ totalRamBytes: 128 * GB, gpuVramBytes: null }),
    sleep: async () => {},
    ...overrides,
  });
}

/** Wait for the manager's serialized chain to drain. */
async function drained(mgr: ModelFitnessManager): Promise<void> {
  while (mgr.probingKeys().length > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ModelFitnessManager', () => {
  it('probes serialize: the second starts only after the first resolves', async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = makeManager({
      runProbe: async (args) => {
        events.push(`start:${args.modelId}`);
        if (args.modelId === 'a') await gate;
        events.push(`end:${args.modelId}`);
        return record({ modelId: args.modelId });
      },
    });
    mgr.scheduleProbe('llama-cpp', 'a', { trigger: 'manual' });
    mgr.scheduleProbe('llama-cpp', 'b', { trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['start:a']);
    release();
    await drained(mgr);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('dedupe: scheduling an already-pending key joins instead of re-running', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = makeManager({
      runProbe: async () => {
        runs += 1;
        await gate;
        return record();
      },
    });
    mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
    mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
    expect(mgr.probingKeys()).toEqual(['llama-cpp:gemma4-e4b-q4']);
    release();
    await drained(mgr);
    expect(runs).toBe(1);
  });

  it('persists the record and round-trips it through a real Store', async () => {
    const mgr = makeManager();
    mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
    await drained(mgr);
    const config = await store.readConfig();
    expect(config.modelFitness?.['llama-cpp:gemma4-e4b-q4']).toBeDefined();
    const resolved = await mgr.get('llama-cpp', 'gemma4-e4b-q4');
    expect(resolved?.record.admitted).toBe(true);
    expect(resolved?.stale).toBe(false);
    expect(resolved?.hardwareChanged).toBe(false);
  });

  describe('install-trigger headroom deferral', () => {
    // 92 committed + ceil(5 × 1.2) = 98 GB > the 96 GB budget — spawning
    // the probe target would force-evict the resident 27B.
    const fullPool: PoolSnapshot = {
      enforced: true,
      committedBytes: 92 * GB,
      budgetBytes: 96 * GB,
      systemRamBytes: 128 * GB,
      autoBudgetBytes: 96 * GB,
      overridden: false,
      pools: { kind: 'unified', vramBytes: 0, ramShareBytes: 96 * GB, fastBytes: 96 * GB },
      ramSpillover: { allowed: true, auto: true, overridden: false, coResidencyBytes: 96 * GB },
      entries: [
        {
          key: 'llama-cpp:qwen3.6-27b-q4:0',
          provider: 'llama-cpp',
          modelId: 'qwen3.6-27b-q4',
          replicaIdx: 0,
          residentBytes: 92 * GB,
          lastUsedAt: 0,
        } as PoolSnapshot['entries'][number],
      ],
    };

    it('defers when spawning would exceed the budget, persisting a deferred record', async () => {
      let runs = 0;
      const mgr = makeManager({
        engineStatus: async () => fullPool,
        runProbe: async () => {
          runs += 1;
          return record();
        },
        deferRetryMs: 1,
        deferBudgetMs: 3,
      });
      mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'install' });
      await drained(mgr);
      expect(runs).toBe(0);
      const resolved = await mgr.get('llama-cpp', 'gemma4-e4b-q4');
      expect(resolved?.record.status).toBe('deferred');
    });

    it('manual probes proceed despite no headroom', async () => {
      let runs = 0;
      const mgr = makeManager({
        engineStatus: async () => fullPool,
        runProbe: async () => {
          runs += 1;
          return record();
        },
      });
      mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
      await drained(mgr);
      expect(runs).toBe(1);
    });

    it('an already-resident model skips the deferral entirely', async () => {
      let runs = 0;
      const residentPool: PoolSnapshot = {
        ...fullPool,
        entries: [
          {
            ...fullPool.entries[0]!,
            modelId: 'gemma4-e4b-q4',
          } as PoolSnapshot['entries'][number],
        ],
      };
      const mgr = makeManager({
        engineStatus: async () => residentPool,
        runProbe: async () => {
          runs += 1;
          return record();
        },
      });
      mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'install' });
      await drained(mgr);
      expect(runs).toBe(1);
    });
  });

  it('staleness: sha or catalog-version drift marks the record stale', async () => {
    const mgr = makeManager({
      resolveInstalled: async () => ({
        sha256: 'bbb',
        catalogVersion: '1.0.0',
        approxSizeBytes: 5 * GB,
      }),
    });
    mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
    await drained(mgr);
    // The probe stub records sha 'aaa' (from `record()`); installed says 'bbb'.
    const resolved = await mgr.get('llama-cpp', 'gemma4-e4b-q4');
    expect(resolved?.stale).toBe(true);
  });

  it('staleness applies to mlx records too — a catalog-version bump invalidates', async () => {
    const mgr = makeManager({
      resolveInstalled: async () => ({ catalogVersion: '2.0.0', approxSizeBytes: 11 * GB }),
    });
    mgr.scheduleProbe('mlx', 'gemma4-12b-q4', { trigger: 'manual' });
    await drained(mgr);
    // The probe stub records catalogVersion '1.0.0'; installed says '2.0.0'.
    const resolved = await mgr.get('mlx', 'gemma4-12b-q4');
    expect(resolved?.stale).toBe(true);
  });

  it('a model no longer installed reads as stale', async () => {
    const mgr = makeManager();
    mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
    await drained(mgr);
    const gone = makeManager({ resolveInstalled: async () => null });
    const resolved = await gone.get('llama-cpp', 'gemma4-e4b-q4');
    expect(resolved?.stale).toBe(true);
  });

  it('hardware drift over 10% flags hardwareChanged without invalidating', async () => {
    const mgr = makeManager({
      currentMemory: async () => ({ totalRamBytes: 96 * GB, gpuVramBytes: null }),
    });
    mgr.scheduleProbe('llama-cpp', 'gemma4-e4b-q4', { trigger: 'manual' });
    await drained(mgr);
    // Record host says 128 GB (from `record()`), current says 96 GB — 25% drift.
    const resolved = await mgr.get('llama-cpp', 'gemma4-e4b-q4');
    expect(resolved?.hardwareChanged).toBe(true);
    expect(resolved?.stale).toBe(false);
  });

  it('a malformed persisted entry is skipped without nuking the others', async () => {
    await store.writeConfig({
      modelFitness: {
        'llama-cpp:good': record({ modelId: 'good' }),
        'llama-cpp:bad': { schemaVersion: 99, garbage: true },
      },
    });
    const mgr = makeManager();
    const all = await mgr.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.key).toBe('llama-cpp:good');
    expect(await mgr.get('llama-cpp', 'bad')).toBeNull();
  });

  it('a throwing probe never breaks the chain — the next probe still runs', async () => {
    let calls = 0;
    const mgr = makeManager({
      runProbe: async (args) => {
        calls += 1;
        if (args.modelId === 'boom') throw new Error('probe machinery exploded');
        return record({ modelId: args.modelId });
      },
    });
    mgr.scheduleProbe('llama-cpp', 'boom', { trigger: 'manual' });
    mgr.scheduleProbe('llama-cpp', 'fine', { trigger: 'manual' });
    await drained(mgr);
    expect(calls).toBe(2);
    expect((await mgr.get('llama-cpp', 'fine'))?.record.modelId).toBe('fine');
  });
});
