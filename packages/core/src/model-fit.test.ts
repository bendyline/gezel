import { describe, expect, it } from 'vitest';
import { computeModelFit, isMoEFromTags } from './model-fit.js';

const GiB = 1024 ** 3;

// A discrete 12 GB GPU + 64 GB RAM (the user's motivating machine).
const discrete = {
  usableBytes: Math.floor(12 * GiB * 0.95),
  totalRamBytes: 64 * GiB,
  gpuVramBytes: 12 * GiB,
};
// Apple-silicon unified memory (64 GB, no separate VRAM).
const unified = {
  usableBytes: Math.floor(64 * GiB * 0.6),
  totalRamBytes: 64 * GiB,
  gpuVramBytes: null,
};

describe('computeModelFit', () => {
  it('a small model fits fully in VRAM', () => {
    const r = computeModelFit({ residentBytes: 4 * GiB, isMoE: false, ...discrete });
    expect(r.tier).toBe('fits');
    expect(r.label).toBe('fits in VRAM');
    expect(r.runnable).toBe(true);
  });

  it('THE case: a big MoE that exceeds VRAM runs via expert offload on a discrete GPU', () => {
    // 35B-A3B ~ 24 GiB resident on a 12 GiB card + 64 GiB RAM.
    const r = computeModelFit({ residentBytes: 24 * GiB, isMoE: true, ...discrete });
    expect(r.tier).toBe('fits-offload');
    expect(r.label).toMatch(/expert offload/);
    expect(r.runnable).toBe(true);
  });

  it('a same-size DENSE model on the same GPU is only "may run slowly" (no offload trick)', () => {
    const r = computeModelFit({ residentBytes: 24 * GiB, isMoE: false, ...discrete });
    expect(r.tier).toBe('tight');
    expect(r.label).toMatch(/slowly/);
    expect(r.runnable).toBe(true);
  });

  it('too big for RAM → not runnable', () => {
    const r = computeModelFit({ residentBytes: 200 * GiB, isMoE: true, ...discrete });
    expect(r.tier).toBe('too-big');
    expect(r.runnable).toBe(false);
  });

  it('unified memory: MoE and dense fit the same (no discrete VRAM to offload from)', () => {
    const moe = computeModelFit({ residentBytes: 24 * GiB, isMoE: true, ...unified });
    const dense = computeModelFit({ residentBytes: 24 * GiB, isMoE: false, ...unified });
    // 24 ≤ 60% of 64 (=38.4) → both fit fully in unified memory.
    expect(moe.tier).toBe('fits');
    expect(dense.tier).toBe('fits');
    expect(moe.label).toBe('fits in memory');
  });

  it('unified memory: a MoE beyond the fast budget does NOT claim expert-offload (no discrete GPU)', () => {
    // 45 GiB > 38.4 fast budget, ≤ 51.2 RAM budget → tight, NOT fits-offload.
    const r = computeModelFit({ residentBytes: 45 * GiB, isMoE: true, ...unified });
    expect(r.tier).toBe('tight');
  });
});

describe('isMoEFromTags', () => {
  it('matches the inconsistent MoE tag spellings across the catalog', () => {
    expect(isMoEFromTags(['alibaba', 'moe'])).toBe(true); // qwen3.6-35b-a3b
    expect(isMoEFromTags(['google', 'mix of experts', 'qat'])).toBe(true); // gemma4-26b
    expect(isMoEFromTags(['mixture of experts'])).toBe(true);
    expect(isMoEFromTags(['openai', 'moe', 'large'])).toBe(true); // gpt-oss
  });
  it('does not match dense models', () => {
    expect(isMoEFromTags(['google', 'reasoning', 'large', 'qat'])).toBe(false); // gemma4-31b
    expect(isMoEFromTags(undefined)).toBe(false);
    expect(isMoEFromTags([])).toBe(false);
  });
});
