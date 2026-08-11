import { describe, expect, it } from 'vitest';
import type { LLMProvider, LLMSession, ModelInfo, SessionOpts } from '../types.js';
import { CapacityBroker } from './capacity-broker.js';
import { makeEngineKey } from './engine-key.js';
import { EngineRouter, resolveLocalRoute } from './engine-router.js';
import { type ProviderBuilder, ProviderPool } from './provider-pool.js';

const GB = 1024 ** 3;

class FakeProvider implements LLMProvider {
  readonly name = 'mlx';
  constructor(public readonly label: string) {}
  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async createSession(_opts: SessionOpts): Promise<LLMSession> {
    throw new Error('unused');
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}

function mkBuilder(bytes: number): ProviderBuilder {
  return async ({ modelId, replicaIdx }) => ({
    provider: new FakeProvider(`${modelId}:${replicaIdx}`),
    residentBytes: bytes,
  });
}

function makeRouter(bytes = 10 * GB, budget = 64 * GB): EngineRouter {
  const broker = new CapacityBroker({ budgetBytes: budget });
  const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(bytes) } });
  return new EngineRouter({
    broker,
    pool,
    builders: { mlx: mkBuilder(bytes) },
    resolveResidentBytes: () => bytes,
  });
}

describe('EngineRouter', () => {
  it('bindForSession with no prior key spawns replica 0', async () => {
    const router = makeRouter();
    const { engineKey } = await router.bindForSession('mlx', 'gemma4-26b', {
      sessionId: 's1',
    });
    expect(engineKey).toBe(makeEngineKey('mlx', 'gemma4-26b', 0));
    expect(router.pool.has(engineKey)).toBe(true);
  });

  it('bindForSession respects an existing prior key when the replica is resident', async () => {
    const router = makeRouter();
    await router.ensure('mlx', 'gemma4-26b', 0);
    await router.ensure('mlx', 'gemma4-26b', 1);

    const prior = makeEngineKey('mlx', 'gemma4-26b', 1);
    const { engineKey } = await router.bindForSession(
      'mlx',
      'gemma4-26b',
      { sessionId: 's1' },
      prior,
    );
    expect(engineKey).toBe(prior);
  });

  it('bindForSession picks least-loaded replica when no prior key', async () => {
    const router = makeRouter();
    await router.ensure('mlx', 'gemma4-26b', 0);
    await router.ensure('mlx', 'gemma4-26b', 1);

    const loads = new Map<string, number>([
      [makeEngineKey('mlx', 'gemma4-26b', 0), 4],
      [makeEngineKey('mlx', 'gemma4-26b', 1), 1],
    ]);
    const { engineKey } = await router.bindForSession('mlx', 'gemma4-26b', {
      sessionId: 's-new',
      sessionsPerKey: loads,
    });
    expect(engineKey).toBe(makeEngineKey('mlx', 'gemma4-26b', 1));
  });

  it('a same-model bind reuses the resident replica instead of spawning a second engine (Metal-OOM guard)', async () => {
    // Budget fits exactly ONE copy of the model; a second copy would
    // blow it — the real-world failure was a background one-shot
    // spawning a parallel engine for an already-resident model and
    // exhausting GPU memory. The chat layer now routes those one-shots
    // through the pool (getProviderForModel / tryPooledProvider), which
    // bottoms out here. This proves that path is a cache hit.
    const router = makeRouter(10 * GB, 12 * GB);

    // Interactive session loads the model.
    const interactive = await router.bindForSession('mlx', 'gemma4-e4b-q4', {
      sessionId: 'interactive',
    });
    // Background one-shot for the SAME model: distinct synthetic session
    // id, no prior key — exactly the shape of a summarizer/about chore.
    const oneShot = await router.bindForSession('mlx', 'gemma4-e4b-q4', {
      sessionId: 'singleton:summary',
    });

    // Same engine key AND same live instance — one engine, not two.
    expect(oneShot.engineKey).toBe(interactive.engineKey);
    expect(oneShot.provider).toBe(interactive.provider);

    // Exactly one resident entry, one reservation — no second copy that
    // would have pushed committed past the budget into OOM territory.
    const snap = router.snapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.committedBytes).toBe(10 * GB);
  });

  it('bindForSession with a prior key on a different model rebinds', async () => {
    const router = makeRouter();
    const prior = makeEngineKey('mlx', 'old-model', 0);
    const { engineKey } = await router.bindForSession(
      'mlx',
      'gemma4-26b',
      { sessionId: 's1' },
      prior,
    );
    expect(engineKey).toBe(makeEngineKey('mlx', 'gemma4-26b', 0));
  });

  it('bindForSession with a prior key whose replica is gone re-spawns at the same idx', async () => {
    const router = makeRouter();
    await router.ensure('mlx', 'gemma4-26b', 2);
    await router.pool.evict(makeEngineKey('mlx', 'gemma4-26b', 2));
    const { engineKey } = await router.bindForSession(
      'mlx',
      'gemma4-26b',
      { sessionId: 's1' },
      makeEngineKey('mlx', 'gemma4-26b', 2),
    );
    expect(engineKey).toBe(makeEngineKey('mlx', 'gemma4-26b', 2));
    expect(router.pool.has(engineKey)).toBe(true);
  });

  it('reconcileClones spawns and evicts to match the target map', async () => {
    const router = makeRouter();
    await router.reconcileClones('mlx', { 'gemma4-26b': 2, 'qwen3.6': 1 });
    expect(router.pool.has(makeEngineKey('mlx', 'gemma4-26b', 0))).toBe(true);
    expect(router.pool.has(makeEngineKey('mlx', 'gemma4-26b', 1))).toBe(true);
    expect(router.pool.has(makeEngineKey('mlx', 'qwen3.6', 0))).toBe(true);
  });

  it('resolveBytes falls back to the broker estimator when catalog lookup misses', () => {
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({ broker, builders: { mlx: mkBuilder(5 * GB) } });
    const router = new EngineRouter({
      broker,
      pool,
      builders: { mlx: mkBuilder(5 * GB) },
      resolveResidentBytes: () => undefined,
      fallbackApproxBytes: 10 * GB,
    });
    // mlx multiplier is the measured 1.05.
    expect(router.resolveBytes('mlx', 'unknown')).toBe(Math.round(10 * GB * 1.05));
    expect(router.resolveBytes('llama-cpp', 'unknown')).toBe(Math.round(10 * GB * 1.2));
  });

  it('throws when no builder registered for a provider', async () => {
    const broker = new CapacityBroker({ budgetBytes: 32 * GB });
    const pool = new ProviderPool({ broker, builders: {} });
    const router = new EngineRouter({
      broker,
      pool,
      builders: {},
      resolveResidentBytes: () => 5 * GB,
    });
    await expect(router.ensure('mlx', 'a', 0)).rejects.toThrow(/no builder/);
  });
});

describe('resolveLocalRoute', () => {
  it('returns null for cloud providers', () => {
    expect(
      resolveLocalRoute({
        providerName: 'copilot',
        configDefaultModel: 'gpt-4',
      }),
    ).toBeNull();
  });

  it('prefers record.model > frontmatter > config default', () => {
    expect(
      resolveLocalRoute({
        providerName: 'mlx',
        recordModel: 'A',
        frontmatterModel: 'B',
        configDefaultModel: 'C',
      }),
    ).toEqual({ provider: 'mlx', modelId: 'A' });

    expect(
      resolveLocalRoute({
        providerName: 'mlx',
        frontmatterModel: 'B',
        configDefaultModel: 'C',
      }),
    ).toEqual({ provider: 'mlx', modelId: 'B' });

    expect(
      resolveLocalRoute({
        providerName: 'mlx',
        configDefaultModel: 'C',
      }),
    ).toEqual({ provider: 'mlx', modelId: 'C' });
  });

  it('returns null when no modelId is resolvable', () => {
    expect(resolveLocalRoute({ providerName: 'mlx' })).toBeNull();
  });
});
