import { describe, expect, it } from 'vitest';
import {
  degradeMoeOffloadDecision,
  estimateExactPerSlotKvBytesF16,
  estimateKvReserveBytes,
  estimateWindowedKvLinearization,
  fitsSwaFullInFastMemory,
  planMoeOffload,
} from './offload-planner.js';

const GiB = 1024 ** 3;

describe('planMoeOffload', () => {
  it('does nothing when there is no GPU', () => {
    const d = planMoeOffload({ isMoE: true, residentBytes: 40 * GiB, vramBytes: 0 });
    expect(d.cpuMoe).toBeUndefined();
    expect(d.nGpuLayers).toBeUndefined();
    expect(d.reason).toMatch(/no GPU/i);
  });

  it('leaves dense models to the engine (--fit / -ngl auto)', () => {
    const d = planMoeOffload({ isMoE: false, residentBytes: 40 * GiB, vramBytes: 12 * GiB });
    expect(d).toEqual({});
  });

  it('does not offload a MoE that fits VRAM', () => {
    const d = planMoeOffload({ isMoE: true, residentBytes: 8 * GiB, vramBytes: 24 * GiB });
    expect(d.cpuMoe).toBeUndefined();
    expect(d.reason).toMatch(/fits VRAM/i);
  });

  it('streams experts from RAM for a big MoE on a small GPU', () => {
    // 35B-A3B ~ 24 GiB resident on a 12 GiB card.
    const d = planMoeOffload({ isMoE: true, residentBytes: 24 * GiB, vramBytes: 12 * GiB });
    expect(d.cpuMoe).toBe(true);
    expect(d.nGpuLayers).toBe(-1);
    expect(d.reason).toMatch(/cpu-moe/i);
  });

  it('respects the margin at the fit boundary', () => {
    // resident 10 GiB, vram 12 GiB, margin 1 GiB → 10+1 ≤ 12 → fits.
    expect(
      planMoeOffload({ isMoE: true, residentBytes: 10 * GiB, vramBytes: 12 * GiB }).cpuMoe,
    ).toBeUndefined();
    // resident 11.5 GiB → 11.5+1 > 12 → offload.
    expect(
      planMoeOffload({ isMoE: true, residentBytes: 11.5 * GiB, vramBytes: 12 * GiB }).cpuMoe,
    ).toBe(true);
    // custom margin widens the "won't fit" zone.
    expect(
      planMoeOffload({
        isMoE: true,
        residentBytes: 10 * GiB,
        vramBytes: 12 * GiB,
        marginBytes: 3 * GiB,
      }).cpuMoe,
    ).toBe(true);
  });
});

describe('planMoeOffload — exact tensor split (graduated)', () => {
  // 40 expert layers of 0.5 GiB each (20 GiB of experts) + 2 GiB residue.
  const layers = Array.from({ length: 40 }, () => 0.5 * GiB);
  const split = { nonExpertBytes: 2 * GiB, expertBytesByLayer: layers };
  const base = {
    isMoE: true,
    residentBytes: 26 * GiB,
    split,
    blockCount: 40,
    marginBytes: 1 * GiB,
  };
  // The planner's flat compute-buffer reserve, mirrored here so the
  // arithmetic in each case is visible.
  const compute = 0.5 * GiB;

  it('keeps the expert-layer suffix that fits beside the residue (--n-cpu-moe N)', () => {
    // 12 GiB card: budget = 12 − 1 (margin) − 0.5 (compute) − 0.5 (kv) − 2
    // (residue) = 8 GiB → 16 layers of 0.5 GiB on the GPU, 24 pinned to CPU.
    const d = planMoeOffload({ ...base, vramBytes: 12 * GiB, kvReserveBytes: 0.5 * GiB });
    expect(d.nCpuMoe).toBe(24);
    expect(d.nGpuLayers).toBe(-1);
    expect(d.cpuMoe).toBeUndefined();
    expect(d.reason).toMatch(/16\/40 layers/);
  });

  it('falls to --cpu-moe with -ngl all when no expert layer fits', () => {
    // 4 GiB card: budget = 4 − 1 − 0.5 − 0 − 2 = 0.5 GiB < one 0.5+ layer? No:
    // exactly one 0.5 GiB layer fits — tighten with kv to leave less than one.
    const d = planMoeOffload({ ...base, vramBytes: 4 * GiB, kvReserveBytes: 0.25 * GiB });
    expect(d.cpuMoe).toBe(true);
    expect(d.nGpuLayers).toBe(-1);
  });

  it('drops the -ngl pin when even the non-expert residue busts VRAM', () => {
    // 3 GiB card: residue 2 + margin 1 + compute 0.5 > 3 → the engine must be
    // free to spill whole layers; a hard `-ngl all` is exactly the v2 OOM.
    const d = planMoeOffload({ ...base, vramBytes: 3 * GiB });
    expect(d.cpuMoe).toBe(true);
    expect(d.nGpuLayers).toBeUndefined();
    expect(d.reason).toMatch(/left to the engine/i);
  });

  it('takes full GPU residency when weights + reserves fit after all', () => {
    // 26 GiB card: 22 GiB of weights + 1.5 GiB reserves ≤ 26 — the coarse
    // resident×1.2 estimate would have offloaded; the exact sums say no need.
    const d = planMoeOffload({ ...base, vramBytes: 26 * GiB });
    expect(d).toMatchObject({ reason: expect.stringMatching(/full GPU residency/i) });
    expect(d.cpuMoe).toBeUndefined();
    expect(d.nCpuMoe).toBeUndefined();
  });

  it('budgets weights-only when no KV estimate is available', () => {
    // Same 12 GiB card without kv: budget = 8.5 GiB → 17 layers on GPU.
    const d = planMoeOffload({ ...base, vramBytes: 12 * GiB });
    expect(d.nCpuMoe).toBe(23);
    void compute;
  });
});

describe('degradeMoeOffloadDecision — the OOM ladder', () => {
  it('escalates a partial split to all-experts-in-RAM', () => {
    const d = degradeMoeOffloadDecision({ nGpuLayers: -1, nCpuMoe: 24 });
    expect(d).toMatchObject({ nGpuLayers: -1, cpuMoe: true });
  });

  it('unpins the GPU layer count after all-experts-in-RAM still OOMs', () => {
    const d = degradeMoeOffloadDecision({ nGpuLayers: -1, cpuMoe: true });
    expect(d).toMatchObject({ cpuMoe: true });
    expect(d?.nGpuLayers).toBeUndefined();
  });

  it('stops once the engine already owns the layer split', () => {
    expect(degradeMoeOffloadDecision({ cpuMoe: true })).toBeNull();
  });

  it('has nothing to degrade for dense / empty decisions', () => {
    expect(degradeMoeOffloadDecision({})).toBeNull();
    expect(degradeMoeOffloadDecision(undefined)).toBeNull();
    expect(degradeMoeOffloadDecision({ reason: 'fits' })).toBeNull();
  });
});

describe('estimateKvReserveBytes', () => {
  const dims = {
    blockCount: 40,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: 8,
    ctxTokens: 16384,
  };

  it('computes full-attention KV bytes from header dims (f16)', () => {
    // 40 layers × 16384 ctx × 8 kv-heads × (128+128) dims × 2 B.
    expect(estimateKvReserveBytes({ ...dims, kvCacheType: 'f16' })).toBe(40 * 16384 * 8 * 256 * 2);
  });

  it('honors explicit key/value lengths over embd/heads', () => {
    expect(
      estimateKvReserveBytes({ ...dims, keyLength: 192, valueLength: 128, kvCacheType: 'f16' }),
    ).toBe(40 * 16384 * 8 * (192 + 128) * 2);
  });

  it('scales by the quantized cache type', () => {
    expect(estimateKvReserveBytes({ ...dims, kvCacheType: 'q8_0' })).toBe(
      Math.round(40 * 16384 * 8 * 256 * (34 / 32)),
    );
  });

  it('prices Gemma 4 E4B from its scalar heads, SWA dims, and 18 shared KV layers', () => {
    const e4b = {
      blockCount: 42,
      headCountKv: 2,
      sharedKvLayers: 18,
      slidingWindowPattern: Array.from({ length: 42 }, (_, i) => (i + 1) % 6 !== 0),
      keyLength: 512,
      valueLength: 512,
      keyLengthSwa: 256,
      valueLengthSwa: 256,
      ctxTokens: 2 * 65_536,
      kvCacheType: 'f16',
    };
    // Only the first 24 layers own cache tensors: 20 SWA × 256+256 dims
    // plus 4 global × 512+512 dims, across two 64K slots = exactly 7 GiB.
    expect(estimateKvReserveBytes(e4b)).toBe(7 * GiB);
  });

  it('returns undefined when the header lacks the needed dims', () => {
    expect(estimateKvReserveBytes({ ctxTokens: 16384 })).toBeUndefined();
    expect(estimateKvReserveBytes({ ...dims, headCountKv: undefined })).toBeUndefined();
    expect(
      estimateKvReserveBytes({ blockCount: 40, headCountKv: 8, ctxTokens: 16384 }),
    ).toBeUndefined();
  });
});

describe('estimateWindowedKvLinearization', () => {
  // gemma4-31b's real header: 60 layers in a 5:1 SWA:global pattern,
  // SWA layers 16 heads × 256+256 dims, global layers 4 heads × 512+512.
  // The windowed cache is what the engine allocates when `--swa-full` is
  // declined — pricing it with full-attention math (~105 GB at 65536)
  // instead of this (~7.9 GB) is exactly the over-clamp that granted
  // 19–56K windows on a 65536 request (2026-08-04 gemma4-26b sweep).
  const gemma31b = {
    blockCount: 60,
    headCountKvPerLayer: Array.from({ length: 60 }, (_, i) => ((i + 1) % 6 === 0 ? 4 : 16)),
    slidingWindow: 1024,
    slidingWindowPattern: Array.from({ length: 60 }, (_, i) => (i + 1) % 6 !== 0),
    keyLength: 512,
    valueLength: 512,
    keyLengthSwa: 256,
    valueLengthSwa: 256,
  };

  it('prices gemma4-31b: global layers scale, SWA layers are a fixed reservation', () => {
    const w = estimateWindowedKvLinearization({ ...gemma31b, kvCacheType: 'f16' });
    // 10 global layers × 4 heads × (512+512) dims × 2 bytes.
    expect(w?.bytesPerToken).toBe(10 * 4 * 1024 * 2);
    // 50 SWA layers × 16 heads × (256+256) dims × 2 bytes × (1024 window + 2048 ubatch margin).
    expect(w?.fixedBytes).toBe(50 * 16 * 512 * 2 * (1024 + 2048));
  });

  it('undercuts the full-attention estimate by an order of magnitude at 64K', () => {
    const w = estimateWindowedKvLinearization({ ...gemma31b, kvCacheType: 'f16' });
    const windowedTotal = (w?.fixedBytes ?? 0) + (w?.bytesPerToken ?? 0) * 65_536;
    const fullTotal = estimateKvReserveBytes({
      blockCount: 60,
      headCountKv: 14,
      keyLength: 512,
      valueLength: 512,
      ctxTokens: 65_536,
      kvCacheType: 'f16',
    });
    expect(windowedTotal).toBeLessThan((fullTotal ?? 0) / 10);
  });

  it('accepts scalar KV heads and falls back to global dims when swa dims are absent (e4b shape)', () => {
    const w = estimateWindowedKvLinearization({
      blockCount: 6,
      headCountKv: 2,
      slidingWindow: 512,
      slidingWindowPattern: [true, true, true, true, true, false],
      keyLength: 512,
      valueLength: 512,
      kvCacheType: 'f16',
    });
    expect(w?.bytesPerToken).toBe(1 * 2 * 1024 * 2);
    expect(w?.fixedBytes).toBe(5 * 2 * 1024 * 2 * (512 + 2048));
  });

  it('excludes E4B shared layers from both global and windowed SWA cache terms', () => {
    const w = estimateWindowedKvLinearization({
      blockCount: 42,
      headCountKv: 2,
      sharedKvLayers: 18,
      slidingWindow: 512,
      slidingWindowPattern: Array.from({ length: 42 }, (_, i) => (i + 1) % 6 !== 0),
      keyLength: 512,
      valueLength: 512,
      keyLengthSwa: 256,
      valueLengthSwa: 256,
      kvCacheType: 'f16',
    });
    // The first 24 layers contain 4 global and 20 SWA layers.
    expect(w?.bytesPerToken).toBe(4 * 2 * (512 + 512) * 2);
    expect(w?.fixedBytes).toBe(20 * 2 * (256 + 256) * 2 * (512 + 2048));
  });

  it('selects full E4B on 16 GiB fast memory and windowed E4B on 8 GiB', () => {
    const fullKvBytes = 7 * GiB;
    const residentWeightsBytes = Math.round(4_275_373_792 * 1.2);
    expect(
      fitsSwaFullInFastMemory({
        residentWeightsBytes,
        fullKvBytes,
        fastBudgetBytes: Math.floor(16 * GiB * 0.95),
      }),
    ).toBe(true);
    expect(
      fitsSwaFullInFastMemory({
        residentWeightsBytes,
        fullKvBytes,
        fastBudgetBytes: Math.floor(8 * GiB * 0.95),
      }),
    ).toBe(false);
  });

  it('scales by the KV cache dtype', () => {
    const f16 = estimateWindowedKvLinearization({ ...gemma31b, kvCacheType: 'f16' });
    const q8 = estimateWindowedKvLinearization({ ...gemma31b, kvCacheType: 'q8_0' });
    expect(q8?.bytesPerToken).toBeCloseTo((f16?.bytesPerToken ?? 0) * (34 / 32 / 2), 5);
  });

  it('estimateExactPerSlotKvBytesF16 picks windowed for SWA layouts and full per-layer otherwise', () => {
    // SWA model → windowed linearization at the per-turn window (the
    // engine-default cache, and the honest slot-ceiling upper bound).
    const swa = estimateExactPerSlotKvBytesF16(gemma31b, 65_536);
    expect(swa).toBe(50 * 16 * 512 * 2 * (1024 + 2048) + 10 * 4 * 1024 * 2 * 65_536);
    // Dense model → full-attention per-layer bytes at the same window.
    const dense = estimateExactPerSlotKvBytesF16(
      { blockCount: 40, headCountKv: 8, keyLength: 128, valueLength: 128 },
      65_536,
    );
    expect(dense).toBe(40 * 8 * 256 * 2 * 65_536);
    // No readable geometry → undefined so callers fall back to the heuristic.
    expect(estimateExactPerSlotKvBytesF16({ blockCount: 40 }, 65_536)).toBeUndefined();
  });

  it('degrades to undefined instead of guessing a layer layout', () => {
    expect(
      estimateWindowedKvLinearization({ ...gemma31b, slidingWindowPattern: undefined }),
    ).toBeUndefined();
    expect(
      estimateWindowedKvLinearization({
        ...gemma31b,
        slidingWindowPattern: [true, false],
      }),
    ).toBeUndefined();
    expect(
      estimateWindowedKvLinearization({ ...gemma31b, headCountKvPerLayer: [16, 4] }),
    ).toBeUndefined();
    expect(estimateWindowedKvLinearization({ ...gemma31b, slidingWindow: 0 })).toBeUndefined();
    expect(
      estimateWindowedKvLinearization({
        ...gemma31b,
        headCountKvPerLayer: undefined,
        headCountKv: undefined,
      }),
    ).toBeUndefined();
  });
});
