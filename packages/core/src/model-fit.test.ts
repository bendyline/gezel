import { describe, expect, it } from 'vitest';
import {
  LLAMA_CPP_VISION_COMPUTE_BYTES,
  LLAMA_CPP_WEIGHTS_MULTIPLIER,
  MLX_FIXED_ENGINE_BYTES,
  MLX_WEIGHTS_MULTIPLIER,
  computeModelFit,
  estimateLlamaCppResidentBytes,
  estimateManifestKvBytes,
  estimateMlxResidentBytes,
  isMemoryConstrainedMachine,
  isMoEFromTags,
  localContextFloorTokens,
} from './model-fit.js';

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

describe('computeModelFit — the non-expert VRAM gate on fits-offload', () => {
  // A 4 GB card + 32 GB RAM — the GTX 1650 report that motivated the gate.
  const smallGpu = {
    usableBytes: Math.floor(4 * GiB * 0.95),
    totalRamBytes: 32 * GiB,
    gpuVramBytes: 4 * GiB,
    admissibleBytes: Math.floor(4 * GiB * 0.95) + Math.floor(32 * GiB * 0.6),
  };

  it('still offers expert offload on a 4 GB card when the estimated residue fits', () => {
    // gemma4-26b-q4 shape: ~16.2 GiB resident MoE; 15% residue ≈ 2.4 GiB ≤ 3.8.
    const r = computeModelFit({ residentBytes: 16.2 * GiB, isMoE: true, ...smallGpu });
    expect(r.tier).toBe('fits-offload');
  });

  it('demotes to tight when the estimated always-active residue exceeds VRAM', () => {
    // 2 GB card: 15% of 16.2 GiB ≈ 2.4 GiB > 1.9 GiB usable — "runs on the
    // GPU" would be a false promise; the engine has to spill layers to CPU.
    const r = computeModelFit({
      residentBytes: 16.2 * GiB,
      isMoE: true,
      usableBytes: Math.floor(2 * GiB * 0.95),
      totalRamBytes: 32 * GiB,
      gpuVramBytes: 2 * GiB,
      admissibleBytes: Math.floor(2 * GiB * 0.95) + Math.floor(32 * GiB * 0.6),
    });
    expect(r.tier).toBe('tight');
    expect(r.runnable).toBe(true);
    expect(r.detail).toMatch(/always-active/i);
  });

  it('an exact scanned residue overrides the estimate in both directions', () => {
    // Estimate would pass (2.4 ≤ 3.8) but the real GGUF says 5 GiB → tight.
    const heavyResidue = computeModelFit({
      residentBytes: 16.2 * GiB,
      isMoE: true,
      nonExpertBytes: 5 * GiB,
      ...smallGpu,
    });
    expect(heavyResidue.tier).toBe('tight');
    // Estimate would fail on a 2 GB card, but the real residue is tiny → offload.
    const lightResidue = computeModelFit({
      residentBytes: 16.2 * GiB,
      isMoE: true,
      nonExpertBytes: 1 * GiB,
      usableBytes: Math.floor(2 * GiB * 0.95),
      totalRamBytes: 32 * GiB,
      gpuVramBytes: 2 * GiB,
      admissibleBytes: Math.floor(2 * GiB * 0.95) + Math.floor(32 * GiB * 0.6),
    });
    expect(lightResidue.tier).toBe('fits-offload');
  });
});

describe('computeModelFit — the admission ceiling', () => {
  // The reported failure: on a 24 GB card + 64 GB RAM the browser offered a
  // 42 GB MoE (80% of system RAM says yes), the daemon's broker refused it,
  // and the download was already done. Fit has to stop where admission does.
  const gpuHost = {
    usableBytes: Math.floor(24 * GiB * 0.95),
    totalRamBytes: 64 * GiB,
    gpuVramBytes: 24 * GiB,
    // VRAM + 60% of RAM — what the broker will actually admit.
    admissibleBytes: Math.floor(24 * GiB * 0.95) + Math.floor(64 * GiB * 0.6),
  };

  it('runs a MoE the broker admits', () => {
    const r = computeModelFit({ residentBytes: 42 * GiB, isMoE: true, ...gpuHost });
    expect(r.tier).toBe('fits-offload');
    expect(r.runnable).toBe(true);
  });

  it('calls a model the broker would refuse too big, however much RAM there is', () => {
    // Inside 80% of 64 GB, outside the broker's ceiling. The old rule said
    // "runs"; the load then failed.
    const r = computeModelFit({ residentBytes: 64 * GiB, isMoE: true, ...gpuHost });
    expect(r.tier).toBe('too-big');
    expect(r.runnable).toBe(false);
  });

  it('falls back to the RAM fraction when the daemon does not report a ceiling', () => {
    const { admissibleBytes: _omitted, ...noCeiling } = gpuHost;
    const r = computeModelFit({ residentBytes: 48 * GiB, isMoE: true, ...noCeiling });
    expect(r.tier).toBe('fits-offload');
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

describe('estimateManifestKvBytes', () => {
  it('prices KV at the 64K fit window from the authored f16 geometry', () => {
    // qwen3.5-4b-shaped: ~137 KB/token f16 → ~4.4 GB at 64K q8 — a model
    // whose KV exceeds its 2.6 GB weights, the case weights-only fit
    // badges get wrong.
    const bytes = estimateManifestKvBytes({ kvBytesPerTokenF16: 140_000 });
    expect(bytes).toBe(Math.round(140_000 * 65_536 * 0.55));
  });

  it('adds the fixed SWA block and honors the cache scale', () => {
    const bytes = estimateManifestKvBytes(
      { kvBytesPerTokenF16: 16_384, kvFixedBytesF16: 1_000_000_000 },
      { ctxTokens: 32_768, cacheScale: 1 },
    );
    expect(bytes).toBe(16_384 * 32_768 + 1_000_000_000);
  });

  it('degrades to 0 when the manifest predates the fields', () => {
    expect(estimateManifestKvBytes({})).toBe(0);
    expect(estimateManifestKvBytes({ kvBytesPerTokenF16: 0 })).toBe(0);
  });
});

describe('isMemoryConstrainedMachine', () => {
  it('judges a discrete card on VRAM alone, not on system RAM', () => {
    // 24 GB card + 16 GB of system RAM: the KV lives on the card, so this is
    // not a context-constrained host despite the modest RAM.
    expect(
      isMemoryConstrainedMachine({
        totalRamBytes: 16 * GiB,
        gpuVramBytes: Math.floor(24 * GiB * 0.95),
      }),
    ).toBe(false);
    expect(
      isMemoryConstrainedMachine({
        totalRamBytes: 64 * GiB,
        gpuVramBytes: Math.floor(8 * GiB * 0.95),
      }),
    ).toBe(true);
    // 10 GB usable clears the line; 8 GB usable does not.
    expect(
      isMemoryConstrainedMachine({
        totalRamBytes: 64 * GiB,
        gpuVramBytes: Math.floor(10 * GiB * 0.95),
      }),
    ).toBe(false);
  });

  it('judges unified / CPU-only hosts on system RAM', () => {
    expect(isMemoryConstrainedMachine({ totalRamBytes: 16 * GiB, gpuVramBytes: null })).toBe(true);
    expect(isMemoryConstrainedMachine({ totalRamBytes: 18 * GiB, gpuVramBytes: null })).toBe(false);
    expect(isMemoryConstrainedMachine({ totalRamBytes: 64 * GiB, gpuVramBytes: null })).toBe(false);
  });
});

describe('localContextFloorTokens', () => {
  it('halves the floor on a constrained host and keeps 64K elsewhere', () => {
    expect(localContextFloorTokens({ totalRamBytes: 16 * GiB, gpuVramBytes: null })).toBe(32_768);
    expect(localContextFloorTokens({ totalRamBytes: 64 * GiB, gpuVramBytes: null })).toBe(65_536);
    expect(localContextFloorTokens()).toBe(65_536);
  });

  it('is what fit badges price KV at, so a 16 GB Mac is not badged at 64K', () => {
    const manifest = { kvBytesPerTokenF16: 140_000 };
    const small = { totalRamBytes: 16 * GiB, gpuVramBytes: null };
    expect(estimateManifestKvBytes(manifest, { ctxTokens: localContextFloorTokens(small) })).toBe(
      Math.round(140_000 * 32_768 * 0.55),
    );
  });
});

describe('estimateMlxResidentBytes', () => {
  // Weights-only footprints measured 2026-08-15 on an M5 Max from
  // `mx.get_active_memory()` after load and before any inference, paired with
  // the process cost the sidecar carries on top (macOS phys_footprint).
  const measured = [
    { id: 'lfm2.5-2.6b-q4', approx: 1_535_590_880, footprint: 2_097_219_960 },
    { id: 'gemma4-12b-q4', approx: 11_020_138_609, footprint: 11_937_326_368 },
    { id: 'qwen3.8-27b-q4', approx: 16_081_488_731, footprint: 16_822_088_256 },
    { id: 'qwen3.6-27b-q8', approx: 29_528_164_409, footprint: 30_222_800_904 },
    { id: 'qwen3.6-35b-a3b-q8', approx: 37_748_365_642, footprint: 38_446_395_160 },
    { id: 'laguna-s-2.1-118b-q6', approx: 92_507_783_098, footprint: 92_902_328_032 },
  ];

  it('covers every measured model without over-reserving more than 30%', () => {
    for (const { id, approx, footprint } of measured) {
      const estimate = estimateMlxResidentBytes(approx);
      expect(estimate, `${id} must not under-reserve`).toBeGreaterThanOrEqual(footprint);
      expect(estimate / footprint, `${id} must not over-reserve`).toBeLessThan(1.3);
    }
  });

  it('is fixed-plus-proportional, so the engine term does not scale with weights', () => {
    // The bug a bare multiplier hides: the sidecar's Python/MLX/tokenizer cost
    // is flat, so scaling it starves small models and wastes on large ones.
    const small = estimateMlxResidentBytes(2 * GiB) - Math.round(2 * GiB * MLX_WEIGHTS_MULTIPLIER);
    const large =
      estimateMlxResidentBytes(80 * GiB) - Math.round(80 * GiB * MLX_WEIGHTS_MULTIPLIER);
    expect(small).toBe(large);
    expect(small).toBe(MLX_FIXED_ENGINE_BYTES);
  });

  it('reserves more than the old bare 1.05x on the small end it under-served', () => {
    const approx = 1_535_590_880;
    expect(estimateMlxResidentBytes(approx)).toBeGreaterThan(Math.round(approx * 1.05));
  });
});

describe('estimateLlamaCppResidentBytes — the multimodal projector', () => {
  // muse-glimmer-30b-q4, measured 2026-08-15 on an M5 Max: the GGUF alone runs
  // at 15928 MiB RSS, and loading `--mmproj mmproj-kquant.gguf` takes it to
  // 17626 MiB. `approxSizeBytes` counts only the 15980 MiB GGUF.
  const GGUF_BYTES = 16_756_681_056;
  const MMPROJ_BYTES = 1_400_328_928;
  const MEASURED_RSS_WITH_MMPROJ = 18_482_675_712;

  it('covers the measured vision footprint without overcorrecting', () => {
    const withVision = estimateLlamaCppResidentBytes(GGUF_BYTES, { mmprojBytes: MMPROJ_BYTES });
    expect(withVision).toBeGreaterThanOrEqual(MEASURED_RSS_WITH_MMPROJ);
    expect(withVision / MEASURED_RSS_WITH_MMPROJ).toBeLessThan(1.2);
  });

  it('stops the projector from eating the margin meant for architecture variance', () => {
    // On a 15.6 GiB model the weights-only estimate happens to clear the
    // measured vision footprint — but only because the proportional term's
    // ~1.6 GiB of headroom is almost exactly the projector. That headroom
    // exists to absorb an unusual architecture (gemma4-E4B ran 1.09x on
    // Windows), so spending it here leaves nothing for the case it is for.
    expect(estimateLlamaCppResidentBytes(GGUF_BYTES)).toBeGreaterThan(MEASURED_RSS_WITH_MMPROJ);

    // The coincidence is size-dependent, and inverts on a small model with a
    // full-size projector: 10% of 4 GiB cannot absorb a 1.3 GiB sidecar.
    const smallVisionModel = 4 * GiB;
    expect(estimateLlamaCppResidentBytes(smallVisionModel)).toBeLessThan(
      smallVisionModel + MMPROJ_BYTES,
    );
    expect(
      estimateLlamaCppResidentBytes(smallVisionModel, { mmprojBytes: MMPROJ_BYTES }),
    ).toBeGreaterThan(smallVisionModel + MMPROJ_BYTES + LLAMA_CPP_VISION_COMPUTE_BYTES);
  });

  it('charges the vision compute buffers only when a projector is loaded', () => {
    const none = estimateLlamaCppResidentBytes(GGUF_BYTES);
    expect(estimateLlamaCppResidentBytes(GGUF_BYTES, {})).toBe(none);
    expect(estimateLlamaCppResidentBytes(GGUF_BYTES, { mmprojBytes: 0 })).toBe(none);

    const withVision = estimateLlamaCppResidentBytes(GGUF_BYTES, { mmprojBytes: MMPROJ_BYTES });
    expect(withVision - none).toBe(
      Math.round((GGUF_BYTES + MMPROJ_BYTES) * LLAMA_CPP_WEIGHTS_MULTIPLIER) -
        Math.round(GGUF_BYTES * LLAMA_CPP_WEIGHTS_MULTIPLIER) +
        LLAMA_CPP_VISION_COMPUTE_BYTES,
    );
  });
});
