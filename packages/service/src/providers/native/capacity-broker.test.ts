import { describe, expect, it } from 'vitest';
import {
  CapacityBroker,
  autoDetectBudgetBytes,
  defaultLocalEngineSlots,
  estimatePerSlotKvBytes,
  formatCapacityDenial,
  llamaCppSlotCeiling,
  localEngineKvBudgetBytes,
  localEngineSlotCeiling,
} from './capacity-broker.js';

const GB = 1024 ** 3;

describe('CapacityBroker', () => {
  it('grants reservations under budget', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    expect(b.canReserve(20 * GB)).toBe(true);
    expect(b.reserve('mlx:a:0', 20 * GB).granted).toBe(true);
    expect(b.committedBytes()).toBe(20 * GB);
  });

  it('denies a reservation that would exceed budget', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    b.reserve('mlx:a:0', 20 * GB);
    expect(b.canReserve(20 * GB)).toBe(false);
    const r = b.reserve('mlx:b:0', 20 * GB);
    expect(r.granted).toBe(false);
    expect(r.reason).toMatch(/budget exhausted/);
    // The prior reservation must be intact.
    expect(b.committedBytes()).toBe(20 * GB);
  });

  it('denialReason is the single machine-shaped denial string', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    b.reserve('mlx:a:0', 20 * GB);
    expect(b.denialReason(20 * GB)).toBe(
      `budget exhausted: would commit ${40 * GB} against ${32 * GB}`,
    );
    // reserve()'s reason comes from the same helper — one source of truth.
    const r = b.reserve('mlx:b:0', 20 * GB);
    expect(r.granted).toBe(false);
    expect(r.reason).toBe(b.denialReason(20 * GB));
    // priorBytes excludes an existing reservation being replaced.
    expect(b.denialReason(30 * GB, 20 * GB)).toBe(
      `budget exhausted: would commit ${30 * GB} against ${32 * GB}`,
    );
  });

  it('release frees the reservation', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    b.reserve('mlx:a:0', 20 * GB);
    b.release('mlx:a:0');
    expect(b.committedBytes()).toBe(0);
    expect(b.canReserve(20 * GB)).toBe(true);
  });

  it('release on unknown key is a no-op', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    b.reserve('mlx:a:0', 10 * GB);
    b.release('mlx:b:0');
    expect(b.committedBytes()).toBe(10 * GB);
  });

  it('re-reserving the same key replaces the prior bytes when it fits', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    b.reserve('mlx:a:0', 10 * GB);
    const r = b.reserve('mlx:a:0', 25 * GB);
    expect(r.granted).toBe(true);
    expect(b.committedBytes()).toBe(25 * GB);
  });

  it('re-reserving the same key denies an enlargement that no longer fits', () => {
    const b = new CapacityBroker({ budgetBytes: 32 * GB });
    b.reserve('mlx:a:0', 10 * GB);
    b.reserve('mlx:b:0', 18 * GB);
    const r = b.reserve('mlx:a:0', 20 * GB);
    expect(r.granted).toBe(false);
    expect(b.committedBytes()).toBe(28 * GB); // unchanged
  });

  it('unenforced budget (sub-1GB or 0) accepts anything', () => {
    const b = new CapacityBroker({ budgetBytes: 0 });
    expect(b.reserve('mlx:huge:0', 500 * GB).granted).toBe(true);
    expect(b.committed().enforced).toBe(false);
  });

  it('committed() returns sorted byKey snapshot', () => {
    const b = new CapacityBroker({ budgetBytes: 96 * GB });
    b.reserve('mlx:small:0', 4 * GB);
    b.reserve('mlx:big:0', 30 * GB);
    b.reserve('mlx:mid:0', 12 * GB);
    const snap = b.committed();
    expect(snap.byKey.map((e) => e.key)).toEqual(['mlx:big:0', 'mlx:mid:0', 'mlx:small:0']);
    expect(snap.committedBytes).toBe(46 * GB);
    expect(snap.budgetBytes).toBe(96 * GB);
  });

  it('auto-detect: 60% on ordinary machines, 80% on workstation machines, capped at 96GB', () => {
    expect(autoDetectBudgetBytes(16 * GB)).toBe(Math.floor(16 * GB * 0.6));
    expect(autoDetectBudgetBytes(64 * GB)).toBe(Math.floor(64 * GB * 0.6));
    expect(autoDetectBudgetBytes(96 * GB)).toBe(Math.floor(96 * GB * 0.8));
    // 128 GB × 0.8 = 102.4 GB → cap of 96 GB applies.
    expect(autoDetectBudgetBytes(128 * GB)).toBe(96 * GB);
    // Larger hosts keep the same default cap unless explicitly overridden.
    expect(autoDetectBudgetBytes(192 * GB)).toBe(96 * GB);
    expect(autoDetectBudgetBytes(512 * GB)).toBe(96 * GB);
  });

  it('auto-detect kicks in when budgetBytes is omitted', () => {
    const b = new CapacityBroker({ systemRamBytes: () => 64 * GB });
    expect(b.committed().budgetBytes).toBe(Math.floor(64 * GB * 0.6));
    expect(b.committed().enforced).toBe(true);
  });

  it('committed() reports the system RAM the budget was derived from', () => {
    const b = new CapacityBroker({ systemRamBytes: () => 16 * GB });
    expect(b.committed().systemRamBytes).toBe(16 * GB);
  });

  it('formatCapacityDenial produces a human-readable, actionable message', () => {
    // The real-world case from the bug report: gemma 12b q4 on a 16 GB Mac.
    const msg = formatCapacityDenial({
      modelLabel: 'gemma4-12b-q4',
      requestedBytes: 14326180192,
      budgetBytes: 10307921510,
      committedBytes: 0,
      systemRamBytes: 16 * GB,
    });
    expect(msg).toContain('gemma4-12b-q4');
    expect(msg).toMatch(/13\.3 GB/); // ~14.3e9 bytes → 13.3 GiB
    expect(msg).toMatch(/9\.6 GB/); // budget ~10.3e9 bytes → 9.6 GiB
    expect(msg).toMatch(/16\.0 GB/); // machine RAM
    expect(msg).toMatch(/60%/); // budget fraction of RAM
    expect(msg).toMatch(/GEZEL_CAPACITY_BUDGET_GB/);
    expect(msg).not.toMatch(/\d{10}/); // no raw byte dump
  });

  it('formatCapacityDenial mentions freeing other models when budget is partly held', () => {
    const msg = formatCapacityDenial({
      modelLabel: 'big-model',
      requestedBytes: 20 * GB,
      budgetBytes: 30 * GB,
      committedBytes: 18 * GB,
      systemRamBytes: 64 * GB,
    });
    expect(msg).toMatch(/Other models are currently using 18\.0 GB/);
  });

  it('estimateResidentBytes uses the right multiplier per engine', () => {
    expect(CapacityBroker.estimateResidentBytes('llama-cpp', 10 * GB)).toBe(
      Math.round(10 * GB * 1.2),
    );
    expect(CapacityBroker.estimateResidentBytes('mlx', 10 * GB)).toBe(Math.round(10 * GB * 1.3));
  });

  it('estimateResidentBytes caps ds4 at the streaming working set, not the weight size', () => {
    // ds4 streams MoE experts from SSD, so a huge model's resident footprint
    // is bounded by the expert-cache budget (~48 GiB), NOT its on-disk size —
    // otherwise an 87 GB DeepSeek-V4 GGUF would be told it can't fit a 64 GB box.
    expect(CapacityBroker.estimateResidentBytes('ds4', 87 * GB)).toBe(48 * GB);
    // Below the cap, the (small) weight size is returned verbatim — no multiplier.
    expect(CapacityBroker.estimateResidentBytes('ds4', 10 * GB)).toBe(10 * GB);
  });
});

describe('defaultLocalEngineSlots — RAM-tier demand default', () => {
  it('scales with total system RAM, capped at 4', () => {
    expect(defaultLocalEngineSlots(8 * GB)).toBe(1);
    expect(defaultLocalEngineSlots(15 * GB)).toBe(1);
    expect(defaultLocalEngineSlots(16 * GB)).toBe(2);
    expect(defaultLocalEngineSlots(31 * GB)).toBe(2);
    expect(defaultLocalEngineSlots(32 * GB)).toBe(3);
    expect(defaultLocalEngineSlots(63 * GB)).toBe(3);
    expect(defaultLocalEngineSlots(64 * GB)).toBe(4);
    expect(defaultLocalEngineSlots(128 * GB)).toBe(4);
  });
});

describe('estimatePerSlotKvBytes', () => {
  it('lands near the measured Gemma-26B anchor (~2 GB), biased conservative-high', () => {
    // Anchor (from the manager comment): 26B Q4_K_M (~15 GB on-disk) at 65K
    // ctx with q8_0 KV ≈ ~2 GB resident.
    const est = estimatePerSlotKvBytes({
      perTurnCtxTokens: 65_536,
      weightsBytes: 15 * GB,
      kvCacheType: 'q8_0',
    });
    expect(est).toBeGreaterThan(1.5 * GB);
    expect(est).toBeLessThan(4 * GB);
  });

  it('scales down with cheaper KV quant', () => {
    const base = { perTurnCtxTokens: 65_536, weightsBytes: 15 * GB };
    const f16 = estimatePerSlotKvBytes({ ...base, kvCacheType: 'f16' });
    const q8 = estimatePerSlotKvBytes({ ...base, kvCacheType: 'q8_0' });
    const q4 = estimatePerSlotKvBytes({ ...base, kvCacheType: 'q4_0' });
    expect(q4).toBeLessThan(q8);
    expect(q8).toBeLessThan(f16);
  });

  it('clamps the per-token rate so tiny stays > 0 and giant weights plateau', () => {
    const tiny = estimatePerSlotKvBytes({ perTurnCtxTokens: 1000, weightsBytes: 0.1 * GB });
    expect(tiny).toBeGreaterThan(0);
    // Above ~82 GB on-disk the per-token f16 rate hits its ceiling, so two
    // very different giant weight sizes produce the same per-slot estimate.
    const huge = estimatePerSlotKvBytes({ perTurnCtxTokens: 1000, weightsBytes: 500 * GB });
    const at100 = estimatePerSlotKvBytes({ perTurnCtxTokens: 1000, weightsBytes: 100 * GB });
    expect(huge).toBe(at100);
  });

  it('grows linearly with context length', () => {
    const a = estimatePerSlotKvBytes({ perTurnCtxTokens: 16_384, weightsBytes: 15 * GB });
    const b = estimatePerSlotKvBytes({ perTurnCtxTokens: 32_768, weightsBytes: 15 * GB });
    expect(Math.abs(b - a * 2)).toBeLessThanOrEqual(1); // exact 2× modulo rounding
  });
});

describe('llamaCppSlotCeiling', () => {
  it('fits one 65K q4_0-KV slot for a 120B-class model inside 110 GB', () => {
    // Nemotron Super is the tighter of the downloaded 120B+ cases by the
    // conservative fallback: 86,051,079,584 bytes of weights × 1.2 resident
    // multiplier. The remaining budget still covers a 65K q4_0 KV slot plus
    // the broker's 20% compute-headroom reserve.
    const weightsBytes = 86_051_079_584;
    const budgetBytes = 110 * GB;
    const kvBytes = estimatePerSlotKvBytes({
      perTurnCtxTokens: 65_536,
      weightsBytes,
      kvCacheType: 'q4_0',
    });
    const freeForKv = localEngineKvBudgetBytes({
      engine: 'llama-cpp',
      budgetBytes,
      weightsBytes,
    });

    expect(kvBytes).toBeLessThan(freeForKv * 0.8);
    expect(
      llamaCppSlotCeiling({
        budgetBytes,
        weightsBytes,
        perTurnCtxTokens: 65_536,
        kvCacheType: 'q4_0',
      }),
    ).toBe(1);
  });

  it('collapses to a small count when a big model nearly fills the budget', () => {
    const n = llamaCppSlotCeiling({
      budgetBytes: 96 * GB,
      weightsBytes: 60 * GB,
      perTurnCtxTokens: 65_536,
      kvCacheType: 'q8_0',
    });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
  });

  it('allows many slots for a small model on a big budget', () => {
    const n = llamaCppSlotCeiling({
      budgetBytes: 96 * GB,
      weightsBytes: 5 * GB,
      perTurnCtxTokens: 16_384,
      kvCacheType: 'q8_0',
    });
    expect(n).toBeGreaterThanOrEqual(8);
  });

  it('never returns below 1 even when the model exceeds the budget', () => {
    expect(
      llamaCppSlotCeiling({ budgetBytes: 8 * GB, weightsBytes: 40 * GB, perTurnCtxTokens: 65_536 }),
    ).toBe(1);
  });

  it('subtracts co-resident commitments', () => {
    const base = {
      budgetBytes: 96 * GB,
      weightsBytes: 10 * GB,
      perTurnCtxTokens: 16_384,
      kvCacheType: 'q8_0',
    };
    const alone = llamaCppSlotCeiling(base);
    const crowded = llamaCppSlotCeiling({ ...base, committedOtherBytes: 70 * GB });
    expect(crowded).toBeLessThan(alone);
  });
});

describe('localEngineKvBudgetBytes', () => {
  it('leaves less headroom for MLX than llama-cpp (heavier working set)', () => {
    const base = { budgetBytes: 96 * GB, weightsBytes: 28 * GB };
    const mlx = localEngineKvBudgetBytes({ engine: 'mlx', ...base });
    const llama = localEngineKvBudgetBytes({ engine: 'llama-cpp', ...base });
    expect(mlx).toBeLessThan(llama);
    expect(mlx).toBe(96 * GB - Math.round(28 * GB * 1.3));
  });

  it('goes negative when the model overflows the budget', () => {
    expect(
      localEngineKvBudgetBytes({ engine: 'mlx', budgetBytes: 8 * GB, weightsBytes: 40 * GB }),
    ).toBeLessThan(0);
  });
});

describe('localEngineSlotCeiling', () => {
  it('llamaCppSlotCeiling is the engine="llama-cpp" specialization', () => {
    const opts = {
      budgetBytes: 96 * GB,
      weightsBytes: 20 * GB,
      perTurnCtxTokens: 32_768,
      kvCacheType: 'q8_0',
    };
    expect(llamaCppSlotCeiling(opts)).toBe(
      localEngineSlotCeiling({ engine: 'llama-cpp', ...opts }),
    );
  });

  it('f16 KV (MLX default) admits no more slots than a q8 discount would', () => {
    const base = {
      engine: 'mlx' as const,
      budgetBytes: 96 * GB,
      weightsBytes: 30 * GB,
      perTurnCtxTokens: 32_768,
    };
    const f16 = localEngineSlotCeiling({ ...base, kvCacheType: 'f16' });
    const q8 = localEngineSlotCeiling({ ...base, kvCacheType: 'q8_0' });
    expect(f16).toBeLessThanOrEqual(q8);
  });

  it('MLX runs fewer-or-equal slots than llama-cpp for the same model', () => {
    const base = {
      budgetBytes: 96 * GB,
      weightsBytes: 30 * GB,
      perTurnCtxTokens: 32_768,
      kvCacheType: 'f16',
    };
    const mlx = localEngineSlotCeiling({ engine: 'mlx', ...base });
    const llama = localEngineSlotCeiling({ engine: 'llama-cpp', ...base });
    expect(mlx).toBeLessThanOrEqual(llama);
  });

  it('regression: the 27B-q8-on-64GB config that OOMed Metal yields serial (1 slot)', () => {
    // qwen3.6-27b-q8: ~28 GB weights, 64 GB machine, f16 KV, 32K ctx. Before
    // the MLX slot ceiling this used defaultLocalEngineSlots()=4 → a width-4
    // engine gate → three co-resident sessions + a prefill aborted Metal
    // (SIGABRT — the "Python quit unexpectedly" crash). Must collapse to serial.
    const n = localEngineSlotCeiling({
      engine: 'mlx',
      budgetBytes: autoDetectBudgetBytes(64 * GB),
      weightsBytes: 28 * GB,
      perTurnCtxTokens: 32_768,
      kvCacheType: 'f16',
    });
    expect(n).toBe(1);
  });

  it('still allows real batching for a small model on a big machine', () => {
    const n = localEngineSlotCeiling({
      engine: 'mlx',
      budgetBytes: autoDetectBudgetBytes(64 * GB),
      weightsBytes: 4 * GB,
      perTurnCtxTokens: 8_192,
      kvCacheType: 'f16',
    });
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
