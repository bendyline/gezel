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
  pickRecommendedModel,
  prefersMoE,
} from './recommendation.js';

const GB = 1024 ** 3;

/**
 * Candidate set mirroring the seeded catalog (Gemma 4 = recoScore 15, Qwen
 * 3.6 = 20). `residentBytes` is the llama.cpp working set (≈ on-disk × 1.2)
 * unless the manifest pins one. Only the fields the picker reads are set.
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

  it('best-effort: tiny device still gets the smallest recommended model', () => {
    const pick = pickRecommendedModel(CANDIDATES, {
      platform: 'linux',
      gpuVramBytes: null,
      totalRamBytes: 4 * GB,
      usableBytes: 2 * GB,
    });
    // Nothing fits 2 GB comfortably → the smallest candidate is offered so
    // first-run always has something.
    expect(pick?.id).toBe('gemma4-e2b-q4');
    expect(pick?.reason).toMatch(/best-effort/);
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
