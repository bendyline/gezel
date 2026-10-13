import { describe, expect, it } from 'vitest';
import {
  type RecoDevice,
  type RecoModelInput,
  excludesMoE,
  hardwareHint,
  isBandwidthBoundHost,
  isRecommendedModel,
  isUnifiedMemoryDevice,
  mediaModelFits,
  needsSmallModelRecommendation,
  pickRecommendedModel,
  prefersMoE,
} from './recommendation.js';

const GB = 1024 ** 3;

/**
 * Candidate set mirroring the seeded catalog (Gemma 4 = recoScore 15, Qwen
 * 3.6 = 20). `residentBytes` is the llama.cpp working set (see
 * `estimateLlamaCppResidentBytes`) unless the manifest pins one. Only the
 * fields the picker reads are set.
 */
const CANDIDATES: RecoModelInput[] = [
  {
    id: 'gemma4-e2b-q4',
    recoScore: 15,
    licenseClass: 'open',
    tags: ['small'],
    residentBytes: 5.96 * GB,
  },
  { id: 'gemma4-e4b-q4', recoScore: 15, licenseClass: 'open', tags: [], residentBytes: 9.64 * GB },
  {
    id: 'gemma4-12b-q4',
    recoScore: 15,
    licenseClass: 'open',
    tags: ['qat'],
    residentBytes: 8.06 * GB,
  },
  {
    id: 'gemma4-31b-q4',
    recoScore: 15,
    licenseClass: 'open',
    tags: ['large'],
    residentBytes: 21.03 * GB,
  },
  {
    id: 'gemma4-26b-q4',
    recoScore: 15,
    licenseClass: 'open',
    tags: ['mix of experts'],
    residentBytes: 17.1 * GB,
  },
  {
    id: 'qwen3.6-27b-q4',
    recoScore: 20,
    licenseClass: 'open',
    tags: ['long-context'],
    residentBytes: 19.86 * GB,
  },
  {
    id: 'qwen3.6-27b-q8',
    recoScore: 20,
    licenseClass: 'open',
    tags: ['long-context'],
    residentBytes: 34.3 * GB,
  },
  {
    id: 'qwen3.6-35b-a3b-q4',
    recoScore: 20,
    licenseClass: 'open',
    tags: ['moe'],
    residentBytes: 25.4 * GB,
  },
  {
    id: 'qwen3.6-35b-a3b-q8',
    recoScore: 20,
    licenseClass: 'open',
    tags: ['moe'],
    residentBytes: 44.3 * GB,
  },
  // Not recommended (no score) and a restricted model with a stray score:
  { id: 'mistral-7b-q4', licenseClass: 'open', tags: [], residentBytes: 5 * GB },
  {
    id: 'llama3.2-3b-q4',
    recoScore: 99,
    licenseClass: 'custom-restricted',
    tags: [],
    residentBytes: 3 * GB,
  },
];

describe('pickRecommendedModel', () => {
  it('big discrete GPU (34 GB AMD): dense Qwen over Gemma, MoE excluded', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 34.2 * GB,
      totalRamBytes: 64 * GB,
      usableBytes: 32.5 * GB,
    });
    // Qwen (20) beats Gemma (15); MoE dropped on >24 GB; largest dense Qwen
    // that fits VRAM is 27b-q4 (27b-q8 is ~34 GB resident, too big).
    expect(pick?.id).toBe('qwen3.6-27b-q4');
  });

  it('Apple Silicon (64 GB unified): prefers the Qwen MoE', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'darwin',
      gpuVramBytes: null,
      totalRamBytes: 64 * GB,
      usableBytes: 38.4 * GB,
    });
    expect(pick?.id).toBe('qwen3.6-35b-a3b-q4');
  });

  it('small discrete GPU (12 GB): MoE via expert offload wins', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      totalRamBytes: 32 * GB,
      usableBytes: 11.4 * GB,
    });
    // ≤24 GB → MoE preferred; 35B-A3B offloads experts to the 32 GB RAM.
    expect(pick?.id).toBe('qwen3.6-35b-a3b-q4');
  });

  // A 12 GB laptop with 7.7 GB of RAM free picked the 35B MoE, and the first
  // chat turn was refused with "not enough memory" (2026-10-11).
  it('12 GB card: passes over the offloaded MoE when the RAM it needs is not free now', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 31 * GB,
      usableBytes: 11.34 * GB,
      budgetBytes: 30 * GB,
      // 11.34 GB of card plus 7.7 GB free RAM, less the OS reserve and margin.
      launchCapBytes: 15.4 * GB,
    });
    expect(pick?.id).not.toBe('qwen3.6-35b-a3b-q4');
    expect(pick?.reason).toMatch(/passed over .*qwen3\.6-35b-a3b-q4.*would not start/);
    const chosen = CANDIDATES.find((c) => c.id === pick?.id);
    expect(chosen!.residentBytes).toBeLessThanOrEqual(15.4 * GB);
  });

  it('12 GB card: still offloads the MoE on a card other programs share', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 64 * GB,
      usableBytes: 11.34 * GB,
      budgetBytes: 49 * GB,
      launchCapBytes: 40 * GB,
      // A browser and the desktop hold about 2 GB; the experts stream from RAM.
      freeGpuBytes: 9.5 * GB,
    });
    expect(pick?.id).toBe('qwen3.6-35b-a3b-q4');
  });

  it('12 GB card: passes over models larger than the card when it is nearly full', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 64 * GB,
      usableBytes: 11.34 * GB,
      budgetBytes: 49 * GB,
      launchCapBytes: 40 * GB,
      // Another program holds most of the card: not even the always-active
      // layers of a 25 GB MoE (about 3.8 GB) plus their reserves fit.
      freeGpuBytes: 4 * GB,
    });
    const chosen = CANDIDATES.find((c) => c.id === pick?.id);
    expect(chosen!.residentBytes).toBeLessThanOrEqual(11.34 * GB);
  });

  it('12 GB card: still offloads the MoE when the RAM is free and the card is idle', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 32 * GB,
      usableBytes: 11.4 * GB,
      budgetBytes: 30 * GB,
      launchCapBytes: 28 * GB,
      freeGpuBytes: 11.6 * GB,
    });
    expect(pick?.id).toBe('qwen3.6-35b-a3b-q4');
  });

  // A 1-bit Qwen 3.8 27B, scored level with the 35B, became the first-run
  // pick on a 12 GB laptop once the 35B could not start (2026-10-12).
  it('ranks a 1-bit quant at half its score and a 2-bit one at four fifths', () => {
    const device = {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete' as const,
      totalRamBytes: 31 * GB,
      usableBytes: 11.34 * GB,
      budgetBytes: 30 * GB,
    };
    const open = { licenseClass: 'open' as const, tags: [] };
    const gemma = {
      id: 'gemma4-12b-q4',
      recoScore: 15,
      quantization: 'UD-Q4_K_XL',
      residentBytes: 7 * GB,
      ...open,
    };
    const oneBit = {
      id: 'qwen3.8-27b-iq1-s',
      recoScore: 20,
      quantization: 'UD-IQ1_S',
      residentBytes: 6.6 * GB,
      ...open,
    };
    const twoBit = {
      id: 'qwen3.8-27b-q2',
      recoScore: 21,
      quantization: 'UD-Q2_K_XL',
      residentBytes: 10.4 * GB,
      ...open,
    };

    const withOneBit = pickRecommendedModel([gemma, oneBit], device);
    expect(withOneBit?.id).toBe('gemma4-12b-q4');

    // 21 × 0.8 = 16.8 still outranks Gemma's 15.
    const withTwoBit = pickRecommendedModel([gemma, oneBit, twoBit], device);
    expect(withTwoBit?.id).toBe('qwen3.8-27b-q2');
    expect(withTwoBit?.reason).toContain('recoScore 21 → 16.8 (UD-Q2_K_XL)');
  });

  it('GTX 1650 class host (4 GB VRAM + 32 GB RAM): recommends Gemma E2B, not an offloaded MoE', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 4 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 32 * GB,
      usableBytes: 3.8 * GB,
      budgetBytes: 23 * GB,
    });
    expect(pick?.id).toBe('gemma4-e2b-q4');
    expect(pick?.reason).toMatch(/below 8 GB/);
  });

  it('consumer integrated GPU with a large shared allocation: recommends Gemma E2B', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'integrated',
      totalRamBytes: 32 * GB,
      usableBytes: 16 * GB,
      budgetBytes: 22.4 * GB,
    });
    expect(pick?.id).toBe('gemma4-e2b-q4');
  });

  it('CPU-only 32 GB host still recommends Gemma E2B', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'linux',
      gpuVramBytes: null,
      gpuMemoryKind: 'none',
      totalRamBytes: 32 * GB,
      usableBytes: 16 * GB,
    });
    expect(pick?.id).toBe('gemma4-e2b-q4');
  });

  it('DGX Spark unified CUDA memory stays on the normal large-model path', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'linux',
      gpuVramBytes: 119 * GB,
      gpuMemoryKind: 'unified',
      totalRamBytes: 121 * GB,
      usableBytes: 96 * GB,
    });
    expect(
      needsSmallModelRecommendation({
        platform: 'linux',
        gpuVramBytes: 119 * GB,
        gpuMemoryKind: 'unified',
        totalRamBytes: 121 * GB,
        usableBytes: 96 * GB,
      }),
    ).toBe(false);
    expect(pick?.id).not.toBe('gemma4-e2b-q4');
  });

  it('uses a strict below-8-GiB boundary for discrete cards', () => {
    const base = {
      platform: 'linux',
      gpuMemoryKind: 'discrete' as const,
      totalRamBytes: 32 * GB,
      usableBytes: 8 * GB,
    };
    expect(needsSmallModelRecommendation({ ...base, gpuVramBytes: 8 * GB })).toBe(false);
    expect(needsSmallModelRecommendation({ ...base, gpuVramBytes: 8 * GB - 1 })).toBe(true);
  });

  it('CPU-only 16 GB: falls to the safe small dense Gemma', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 16 * GB,
      usableBytes: 8 * GB,
    });
    // No GPU to offload onto → big MoEs don't comfortably fit; E2B is the
    // only thing under the 8 GB CPU budget.
    expect(pick?.id).toBe('gemma4-e2b-q4');
  });

  it('never recommends a non-open model, even with a huge stray score', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 16 * GB,
      usableBytes: 8 * GB,
    });
    expect(pick?.id).not.toBe('llama3.2-3b-q4');
  });

  it('never recommends a tool-less model, on either the comfortable or best-effort path', () => {
    // A gezel works through its MCP toolset, so a no-tools model is a niche
    // the user opts into by hand — never the first-run pick. This fixture is
    // built to win both ranking paths if the gate were missing: the highest
    // score (comfortable path) and the smallest working set (best-effort).
    const withNiche: RecoModelInput[] = [
      ...CANDIDATES,
      {
        id: 'talkie-1930-13b-q4',
        recoScore: 99,
        licenseClass: 'open',
        supportsTools: false,
        tags: [],
        residentBytes: 1 * GB,
      },
    ];
    const roomy = pickRecommendedModel(withNiche, {
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 64 * GB,
      usableBytes: 32 * GB,
    });
    expect(roomy?.id).not.toBe('talkie-1930-13b-q4');
    const tiny = pickRecommendedModel(withNiche, {
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 4 * GB,
      usableBytes: 2 * GB,
    });
    expect(tiny?.id).toBe('gemma4-e2b-q4');
  });

  it('returns null when nothing carries a recoScore', () => {
    const pick = pickRecommendedModel(
      [{ id: 'x', licenseClass: 'open', tags: [], residentBytes: 1 * GB }],
      { platform: 'linux', gpuVramBytes: null, totalRamBytes: 16 * GB, usableBytes: 8 * GB },
    );
    expect(pick).toBeNull();
  });

  it('tiny CPU-only device gets the smallest recommended model', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 4 * GB,
      usableBytes: 2 * GB,
    });
    // The low-acceleration policy chooses the smallest curated candidate.
    expect(pick?.id).toBe('gemma4-e2b-q4');
    expect(pick?.reason).toMatch(/safest small model/);
  });
});

describe('isRecommendedModel (the one shared gate)', () => {
  it('needs a positive score, an open license, and tool support together', () => {
    expect(isRecommendedModel({ recoScore: 20, licenseClass: 'open', supportsTools: true })).toBe(
      true,
    );
    expect(isRecommendedModel({ licenseClass: 'open', supportsTools: true })).toBe(false);
    expect(isRecommendedModel({ recoScore: 0, licenseClass: 'open', supportsTools: true })).toBe(
      false,
    );
    expect(
      isRecommendedModel({ recoScore: 20, licenseClass: 'custom-restricted', supportsTools: true }),
    ).toBe(false);
    expect(isRecommendedModel({ recoScore: 20, licenseClass: 'open', supportsTools: false })).toBe(
      false,
    );
  });

  it('admits media manifests, which declare no supportsTools field at all', () => {
    expect(isRecommendedModel({ recoScore: 10, licenseClass: 'open' })).toBe(true);
  });

  it('never recommends a retired catalog entry', () => {
    expect(
      isRecommendedModel({
        recoScore: 99,
        licenseClass: 'open',
        supportsTools: true,
        tags: ['Retired'],
      }),
    ).toBe(false);
  });
});

describe('hardware hints (C2 — advisory only)', () => {
  // GB10 / DGX Spark shape: nvidia-smi reports no VRAM, so the llama-server
  // device probe returns ~all of unified RAM as gpuVramBytes.
  const gb10: RecoDevice = {
    platform: 'linux',
    gpuVramBytes: 119 * GB,
    totalRamBytes: 121 * GB,
    usableBytes: 96 * GB,
  };
  const rtx4090: RecoDevice = {
    platform: 'linux',
    gpuVramBytes: 24 * GB,
    totalRamBytes: 128 * GB,
    usableBytes: 24 * GB,
  };
  const bigDgpu: RecoDevice = {
    platform: 'win32',
    gpuVramBytes: 48 * GB,
    totalRamBytes: 256 * GB,
    usableBytes: 48 * GB,
  };
  const mac: RecoDevice = {
    platform: 'darwin',
    gpuVramBytes: null,
    totalRamBytes: 64 * GB,
    usableBytes: 44 * GB,
  };

  it('isUnifiedMemoryDevice: GB10 true (vram ≈ ram), 4090 false, Mac true', () => {
    expect(isUnifiedMemoryDevice(gb10)).toBe(true);
    expect(isUnifiedMemoryDevice(rtx4090)).toBe(false);
    expect(isUnifiedMemoryDevice(mac)).toBe(true);
  });

  it('isBandwidthBoundHost: unified and small-dGPU hosts, not a 48 GB dGPU', () => {
    expect(isBandwidthBoundHost(gb10)).toBe(true);
    expect(isBandwidthBoundHost(rtx4090)).toBe(true);
    expect(isBandwidthBoundHost(mac)).toBe(true);
    expect(isBandwidthBoundHost(bigDgpu)).toBe(false);
  });

  it('hint: MoE that runs on a bandwidth-bound host → good match', () => {
    const hint = hardwareHint(gb10, { isMoE: true, fitTier: 'fits' });
    expect(hint?.kind).toBe('moe-good-match');
  });

  it('hint: large dense on a bandwidth-bound host → caution; small dense → none', () => {
    const large = hardwareHint(gb10, {
      isMoE: false,
      fitTier: 'fits',
      residentBytes: 60 * GB,
    });
    expect(large?.kind).toBe('large-dense-caution');
    const small = hardwareHint(gb10, {
      isMoE: false,
      fitTier: 'fits',
      residentBytes: 10 * GB,
    });
    expect(small).toBeNull();
  });

  it('hint: nothing on a big discrete GPU, nothing for a too-big model', () => {
    expect(hardwareHint(bigDgpu, { isMoE: true, fitTier: 'fits' })).toBeNull();
    expect(hardwareHint(gb10, { isMoE: true, fitTier: 'too-big' })).toBeNull();
  });

  it('hint: large models get a usability caution on integrated graphics and sub-8-GiB cards', () => {
    const integrated: RecoDevice = {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'integrated',
      totalRamBytes: 32 * GB,
      usableBytes: 16 * GB,
    };
    expect(
      hardwareHint(integrated, {
        isMoE: true,
        fitTier: 'fits-offload',
        residentBytes: 17 * GB,
      })?.kind,
    ).toBe('low-acceleration-caution');
    expect(
      hardwareHint(integrated, {
        isMoE: false,
        fitTier: 'fits',
        residentBytes: 6 * GB,
      }),
    ).toBeNull();
  });

  // Settings called the 35B that had just been refused a "good match for this
  // machine", and Gemma 4 12B, which had finished the task, "may respond
  // slowly" (2026-10-11).
  it('says a model will not start right now when the launch check would refuse it', () => {
    const laptop: RecoDevice = {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 31 * GB,
      usableBytes: 11.34 * GB,
    };
    expect(
      hardwareHint(laptop, { isMoE: true, fitTier: 'fits-offload', startsNow: false })?.kind,
    ).toBe('wont-start-now');
    expect(
      hardwareHint(laptop, { isMoE: true, fitTier: 'fits-offload', startsNow: true })?.kind,
    ).toBe('moe-good-match');
  });

  it('does not call a dense model that fits the card slow', () => {
    const laptop: RecoDevice = {
      platform: 'win32',
      gpuVramBytes: 12 * GB,
      gpuMemoryKind: 'discrete',
      totalRamBytes: 31 * GB,
      usableBytes: 11.34 * GB,
    };
    expect(
      hardwareHint(laptop, { isMoE: false, fitTier: 'fits', residentBytes: 10.7 * GB }),
    ).toBeNull();
    expect(
      hardwareHint(laptop, { isMoE: false, fitTier: 'tight', residentBytes: 14.5 * GB })?.kind,
    ).toBe('large-dense-caution');
  });

  it('scope guard: prefersMoE/excludesMoE are untouched by the hint work', () => {
    // The known GB10 misfire (excludesMoE true on a unified non-Mac host)
    // is deliberately preserved — fixing it changes the first-run
    // auto-pick and is deferred (see docs/model-fitness.md).
    expect(excludesMoE(gb10)).toBe(true);
    expect(prefersMoE(gb10)).toBe(false);
    expect(excludesMoE(rtx4090)).toBe(false);
    expect(prefersMoE(rtx4090)).toBe(true);
    expect(prefersMoE(mac)).toBe(true);
    expect(excludesMoE(mac)).toBe(false);
    expect(excludesMoE(bigDgpu)).toBe(true);
  });
});

describe('mediaModelFits', () => {
  const bigGpu = {
    platform: 'win32',
    gpuVramBytes: 34 * GB,
    totalRamBytes: 64 * GB,
    usableBytes: 32 * GB,
  };
  const cpuOnly = {
    platform: 'linux',
    gpuVramBytes: null,
    totalRamBytes: 32 * GB,
    usableBytes: 16 * GB,
  };
  const mac = {
    platform: 'darwin',
    gpuVramBytes: null,
    totalRamBytes: 32 * GB,
    usableBytes: 19 * GB,
  };

  it('image gates on system RAM (klein: 16 GB floor)', () => {
    expect(mediaModelFits(cpuOnly, { minRamGB: 16 })).toBe(true);
    expect(mediaModelFits({ ...cpuOnly, totalRamBytes: 8 * GB }, { minRamGB: 16 })).toBe(false);
  });

  it('video gates on VRAM (wan: 24 GB floor) — needs a real/unified GPU', () => {
    expect(mediaModelFits(bigGpu, { minVramGB: 24 })).toBe(true); // 34 GB AMD
    expect(mediaModelFits(cpuOnly, { minVramGB: 24 })).toBe(false); // no GPU
    expect(mediaModelFits({ ...bigGpu, gpuVramBytes: 12 * GB }, { minVramGB: 24 })).toBe(false);
  });

  it('video uses ~80% of Apple unified memory (chat model is evicted), not the general usableBytes', () => {
    // 32 GB Mac → ~25.6 GB video budget: a 24 GB model fits, a 32 GB one doesn't.
    expect(mediaModelFits({ ...mac, totalRamBytes: 32 * GB }, { minVramGB: 24 })).toBe(true);
    expect(mediaModelFits({ ...mac, totalRamBytes: 32 * GB }, { minVramGB: 32 })).toBe(false);
    // A 128 GB Mac runs an 80 GB model — the low `usableBytes` (the chat-coexistence
    // budget) must NOT gate video, or the manager warns on machines that clearly fit.
    expect(
      mediaModelFits({ ...mac, totalRamBytes: 128 * GB, usableBytes: 76 * GB }, { minVramGB: 80 }),
    ).toBe(true);
  });

  it('no floors (audio) → always fits', () => {
    expect(mediaModelFits(cpuOnly, {})).toBe(true);
  });
});
