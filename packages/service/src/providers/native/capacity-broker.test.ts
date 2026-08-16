import { estimateLlamaCppResidentBytes, estimateMlxResidentBytes } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateKvReserveBytes,
  estimateLinearHybridKvLinearization,
  estimateWindowedKvLinearization,
} from '../llama-cpp/offload-planner.js';
import {
  CapacityBroker,
  autoDetectBudgetBytes,
  clampCtxTokensForMemory,
  computeCapacityBudget,
  defaultLocalEngineSlots,
  estimatePerSlotKvBytes,
  fastMemoryBudgetBytes,
  formatCapacityDenial,
  formatContextCapacityDenial,
  llamaCppSlotCeiling,
  localEngineKvBudgetBytes,
  localEngineSlotCeiling,
  minViableLocalContextTokens,
  parseMeminfoAvailableBytes,
  parseVmStatAvailableBytes,
  planAdaptiveContextGrowth,
  planCtxTokensForMemory,
  plannedLocalEngineSlots,
  resolveLlamaCppContextRequirement,
  resolveLocalContextRequirement,
  setDetectedGpuVramBytes,
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
    const discrete = { unifiedMemory: false };
    expect(autoDetectBudgetBytes(16 * GB, discrete)).toBe(Math.floor(16 * GB * 0.6));
    expect(autoDetectBudgetBytes(64 * GB, discrete)).toBe(Math.floor(64 * GB * 0.6));
    expect(autoDetectBudgetBytes(96 * GB, discrete)).toBe(Math.floor(96 * GB * 0.8));
    // 128 GB × 0.8 = 102.4 GB → cap of 96 GB applies.
    expect(autoDetectBudgetBytes(128 * GB, discrete)).toBe(96 * GB);
    // Larger hosts keep the same default cap unless explicitly overridden.
    expect(autoDetectBudgetBytes(192 * GB, discrete)).toBe(96 * GB);
    expect(autoDetectBudgetBytes(512 * GB, discrete)).toBe(96 * GB);
  });

  it('auto-detect gives unified-memory hosts a larger share less a flat OS reserve', () => {
    const uma = { unifiedMemory: true };
    // The case this exists for: a 16 GB Mac. The old shared 60% fraction
    // capped it at 9.6 GiB, below an 8B-class model at 8-bit — the machine
    // could hold the model, the budget said otherwise. gemma4-e4b-q4 on
    // MLX reserves ~10.8 GiB, so the new value has to clear that.
    expect(autoDetectBudgetBytes(16 * GB, uma)).toBe(Math.floor(16 * GB * 0.7));
    expect(autoDetectBudgetBytes(16 * GB, uma)).toBeGreaterThan(11 * GB);
    expect(autoDetectBudgetBytes(16 * GB, uma)).toBeGreaterThan(
      autoDetectBudgetBytes(16 * GB, { unifiedMemory: false }),
    );
    // The 4 GB reserve binds at the small end where the fraction alone
    // would leave the OS too little.
    expect(autoDetectBudgetBytes(8 * GB, uma)).toBe(4 * GB);
    // The fraction binds in the middle, where its reserve is under 16 GiB.
    expect(autoDetectBudgetBytes(32 * GB, uma)).toBe(Math.floor(32 * GB * 0.7));
    // Above that the capped reserve binds instead: what macOS, the shell, and
    // the user's apps need is absolute, so a bigger machine hands the extra
    // to models rather than holding back a proportional share of it. The old
    // curve stranded 19 GB on a 64 GB Mac and 32 GB on a 128 GB one.
    expect(autoDetectBudgetBytes(64 * GB, uma)).toBe(64 * GB - 16 * GB);
    expect(autoDetectBudgetBytes(96 * GB, uma)).toBe(96 * GB - 16 * GB);
    expect(autoDetectBudgetBytes(128 * GB, uma)).toBe(112 * GB);
    // The reserve is a ceiling, not a target — it never grows with the host.
    expect(autoDetectBudgetBytes(512 * GB, uma)).toBe(512 * GB - 16 * GB);
  });

  it('raises admission capacity without raising peak concurrency', () => {
    // The two must not move together: a bigger budget should let MORE MODELS
    // fit, not give one model more simultaneous KV slots (that is the 27B-q8
    // Metal abort below). Slot sizing keeps the pre-cap curve.
    const uma = { unifiedMemory: true };
    const big = computeCapacityBudget({ systemRamBytes: 128 * GB, ...uma });
    expect(big.budgetBytes).toBe(112 * GB);
    expect(big.concurrencySizingBytes).toBe(96 * GB);

    // Where the reserve cap doesn't bind, the two agree.
    const small = computeCapacityBudget({ systemRamBytes: 32 * GB, ...uma });
    expect(small.concurrencySizingBytes).toBe(small.budgetBytes);
  });

  it('auto-detect kicks in when budgetBytes is omitted', () => {
    const b = new CapacityBroker({ systemRamBytes: () => 64 * GB, unifiedMemory: false });
    expect(b.committed().budgetBytes).toBe(Math.floor(64 * GB * 0.6));
    expect(b.committed().enforced).toBe(true);
    expect(b.committed().overridden).toBe(false);
  });

  it('committed() reports the system RAM the budget was derived from', () => {
    const b = new CapacityBroker({ systemRamBytes: () => 16 * GB });
    expect(b.committed().systemRamBytes).toBe(16 * GB);
  });

  it('committed() reports the auto value even while an override is in force', () => {
    const b = new CapacityBroker({
      systemRamBytes: () => 16 * GB,
      unifiedMemory: true,
      budgetBytes: 14 * GB,
    });
    const snap = b.committed();
    expect(snap.budgetBytes).toBe(14 * GB);
    expect(snap.autoBudgetBytes).toBe(Math.floor(16 * GB * 0.7));
    expect(snap.overridden).toBe(true);
  });

  it('setBudgetBytes re-points the budget live and null reverts to auto', () => {
    const auto = Math.floor(16 * GB * 0.7);
    const b = new CapacityBroker({ systemRamBytes: () => 16 * GB, unifiedMemory: true });
    expect(b.committed().budgetBytes).toBe(auto);

    b.setBudgetBytes(14 * GB);
    expect(b.committed().budgetBytes).toBe(14 * GB);
    expect(b.committed().overridden).toBe(true);
    expect(b.canReserve(13 * GB)).toBe(true);

    b.setBudgetBytes(null);
    expect(b.committed().budgetBytes).toBe(auto);
    expect(b.committed().overridden).toBe(false);
    expect(b.canReserve(13 * GB)).toBe(false);
  });

  it('shrinking the budget below what is committed keeps reservations but denies the next', () => {
    // Moving the slider down must not sever a running engine — the pool's
    // LRU path frees room on the next spawn instead.
    const b = new CapacityBroker({ systemRamBytes: () => 32 * GB, budgetBytes: 20 * GB });
    b.reserve('mlx:resident:0', 12 * GB);
    b.setBudgetBytes(10 * GB);
    expect(b.committed().committedBytes).toBe(12 * GB);
    expect(b.canReserve(1 * GB)).toBe(false);
    b.release('mlx:resident:0');
    expect(b.canReserve(1 * GB)).toBe(true);
  });

  describe('RAM spillover / co-residency', () => {
    // 64 GB host, 32 GB card: usable VRAM 30.4 GB, RAM share 38.4 GB.
    const discrete = (allowRamSpillover: boolean | null) =>
      new CapacityBroker({
        systemRamBytes: () => 64 * GB,
        gpuVramBytes: 32 * GB,
        unifiedMemory: false,
        allowRamSpillover,
      });
    const vramUsable = Math.floor(32 * GB * 0.95);

    it('keeps automatic co-residency within VRAM on every discrete GPU', () => {
      const small = new CapacityBroker({
        systemRamBytes: () => 32 * GB,
        gpuVramBytes: 12 * GB,
        unifiedMemory: false,
      });
      expect(small.ramSpilloverAllowed()).toBe(false);
      expect(discrete(null).ramSpilloverAllowed()).toBe(false);
    });

    it('never binds on a host with one memory pool', () => {
      const uma = new CapacityBroker({ systemRamBytes: () => 64 * GB, unifiedMemory: true });
      expect(uma.ramSpilloverAllowed()).toBe(true);
      expect(uma.coResidencyBytes()).toBe(uma.committed().budgetBytes);
    });

    it('lets ONE model exceed the card — the big-MoE case the budget exists for', () => {
      const b = discrete(false);
      // 40 GB is past the card but well inside the 68 GB budget: it streams
      // experts from system RAM, which is the whole point of the RAM share.
      expect(b.canReserve(40 * GB)).toBe(true);
      expect(b.reserve('llama-cpp:big-moe:0', 40 * GB).granted).toBe(true);
    });

    it('refuses a SECOND model that would push the resident set off the card', () => {
      const b = discrete(false);
      b.reserve('llama-cpp:a:0', 20 * GB);
      expect(b.canReserve(5 * GB)).toBe(true); // 25 GB still fits the card
      expect(b.canReserve(12 * GB)).toBe(false); // 32 GB does not
      const r = b.reserve('llama-cpp:b:0', 12 * GB);
      expect(r.granted).toBe(false);
      expect(r.reason).toMatch(/budget exhausted/);
      expect(r.reason).toMatch(/co-residency ceiling/);
      expect(b.committedBytes()).toBe(20 * GB);
    });

    it('allows the same pair once spilling is turned on', () => {
      const b = discrete(true);
      b.reserve('llama-cpp:a:0', 20 * GB);
      expect(b.reserve('llama-cpp:b:0', 12 * GB).granted).toBe(true);
      expect(b.committedBytes()).toBe(32 * GB);
    });

    it('setAllowRamSpillover re-points the rule live and null reverts to auto', () => {
      const b = discrete(true);
      b.reserve('llama-cpp:a:0', 20 * GB);
      expect(b.canReserve(12 * GB)).toBe(true);

      b.setAllowRamSpillover(false);
      expect(b.canReserve(12 * GB)).toBe(false);
      expect(b.committed().ramSpillover.overridden).toBe(true);

      b.setAllowRamSpillover(null);
      // Auto on a 32 GB card is "don't spill", so the answer stands.
      expect(b.canReserve(12 * GB)).toBe(false);
      expect(b.committed().ramSpillover).toMatchObject({
        allowed: false,
        auto: false,
        overridden: false,
        coResidencyBytes: vramUsable,
      });
    });

    it('sizes the shortfall so the pool evicts exactly what the rule needs', () => {
      const b = discrete(false);
      b.reserve('llama-cpp:a:0', 20 * GB);
      // Releasing a's 20 GB is enough to seat a 12 GB model beside nothing.
      expect(b.shortfallFor(12 * GB)).toBeGreaterThan(0);
      expect(b.shortfallFor(12 * GB)).toBeLessThanOrEqual(20 * GB);
      // A model past the ceiling needs the pool empty — never more than that.
      expect(b.shortfallFor(40 * GB)).toBe(20 * GB);
      // A resize of the SAME key isn't an obstacle to itself.
      expect(b.shortfallFor(25 * GB, 20 * GB)).toBe(0);
    });

    it('leaves the rule off entirely when enforcement is disabled', () => {
      const b = new CapacityBroker({
        budgetBytes: 0,
        gpuVramBytes: 32 * GB,
        unifiedMemory: false,
        allowRamSpillover: false,
      });
      b.reserve('llama-cpp:a:0', 30 * GB);
      expect(b.canReserve(30 * GB)).toBe(true);
      expect(b.shortfallFor(30 * GB)).toBe(0);
    });
  });

  it('formatCapacityDenial explains a co-residency refusal as a different problem', () => {
    const msg = formatCapacityDenial({
      modelLabel: 'qwen3.6-27b-q4',
      requestedBytes: 20 * GB,
      budgetBytes: 68 * GB,
      committedBytes: 25 * GB,
      systemRamBytes: 64 * GB,
      coResidencyBytes: 30 * GB,
      pools: {
        kind: 'discrete-gpu',
        vramBytes: 30 * GB,
        ramShareBytes: 38 * GB,
        fastBytes: 30 * GB,
        concurrencySizingBytes: 30 * GB,
      },
    });
    expect(msg).toMatch(/keep models on the graphics card/);
    expect(msg).toMatch(/every loaded model is busy right now/);
    // Must not send someone shopping for a smaller model: the machine has
    // the memory, it is the on-card policy plus busy engines that refused.
    expect(msg).not.toMatch(/smaller or more-quantized/);
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
    // Points at the in-app setting, not an environment variable — the
    // person reading this is blocked in a desktop app, not a shell.
    expect(msg).toMatch(/Settings/);
    expect(msg).not.toMatch(/GEZEL_CAPACITY_BUDGET_GB/);
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
    // llama.cpp is measured too now, and its shape is proportional + fixed:
    // weight buffers scale with the file (0.98-1.09x across a 3.9-21 GB
    // span), while compute/output buffers are a flat ~100-160 MiB that the
    // old single 1.2x multiplier smeared into the proportional term.
    expect(CapacityBroker.estimateResidentBytes('llama-cpp', 10 * GB)).toBe(
      estimateLlamaCppResidentBytes(10 * GB),
    );
    expect(estimateLlamaCppResidentBytes(10 * GB)).toBe(
      Math.round(10 * GB * 1.1) + 256 * 1024 ** 2,
    );
    // The fixed term is what stops a small model from being under-described:
    // doubling the file must NOT double the engine overhead.
    expect(estimateLlamaCppResidentBytes(2 * GB) - Math.round(2 * GB * 1.1)).toBe(
      estimateLlamaCppResidentBytes(20 * GB) - Math.round(20 * GB * 1.1),
    );
    // MLX is the same shape for the same reason. `mx.get_active_memory()`
    // after load(), before inference, tracks the weights at 0.988-0.9999x
    // across a 1.4-86 GiB span; what it does NOT scale with is the sidecar's
    // Python/MLX/tokenizer cost, a flat 376-875 MiB. The old bare 1.05x
    // under-reserved a 1.4 GiB model by 633 MiB and wasted 1.1 GiB on a 35.
    expect(CapacityBroker.estimateResidentBytes('mlx', 10 * GB)).toBe(
      estimateMlxResidentBytes(10 * GB),
    );
    expect(estimateMlxResidentBytes(2 * GB) - Math.round(2 * GB * 1.02)).toBe(
      estimateMlxResidentBytes(20 * GB) - Math.round(20 * GB * 1.02),
    );
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

describe('defaultLocalEngineSlots — fast-memory demand default', () => {
  it('scales only with usable fast memory, capped at 4', () => {
    expect(defaultLocalEngineSlots(8 * GB)).toBe(1);
    expect(defaultLocalEngineSlots(11 * GB)).toBe(1);
    expect(defaultLocalEngineSlots(12 * GB)).toBe(2);
    expect(defaultLocalEngineSlots(23 * GB)).toBe(2);
    expect(defaultLocalEngineSlots(24 * GB)).toBe(3);
    expect(defaultLocalEngineSlots(47 * GB)).toBe(3);
    expect(defaultLocalEngineSlots(48 * GB)).toBe(4);
    expect(defaultLocalEngineSlots(128 * GB)).toBe(4);
  });
});

describe('plannedLocalEngineSlots — one resolver for preview and launch', () => {
  it('caps the fast-memory tier default by what the model can hold', () => {
    // The bug this pins: the launch-preview short-circuit quoted the bare
    // tier default (3 on a 32-48 GB host) while the launch path clamped by
    // the ceiling, so a resident 17 GB model advertised a ~49 GB reservation
    // the broker would never have admitted.
    expect(plannedLocalEngineSlots({ ceiling: 1, tierDefault: 3 })).toBe(1);
    expect(plannedLocalEngineSlots({ ceiling: 4, tierDefault: 3 })).toBe(3);
  });

  it('honors an explicit operator setting verbatim, ceiling included', () => {
    expect(plannedLocalEngineSlots({ configuredSlots: 4, ceiling: 1, tierDefault: 2 })).toBe(4);
  });

  it('never resolves below one slot', () => {
    expect(plannedLocalEngineSlots({ ceiling: 0, tierDefault: 3 })).toBe(1);
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
    // conservative fallback: 86,051,079,584 bytes of weights through
    // `estimateLlamaCppResidentBytes`. The remaining budget still covers a
    // 65K q4_0 KV slot plus the broker's 20% compute-headroom reserve.
    //
    // This is a FLOOR — the invariant is that a 120B-class model is not
    // refused outright. It asserted exactly 1 while the estimate was a flat
    // 1.2x; measuring that down to 1.1x + a fixed term frees ~8 GB here,
    // which is enough for a second slot. The exact count was pinning the
    // over-reservation, not the property under test.
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
    ).toBeGreaterThanOrEqual(1);
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
  it('prices weights from measurement, and charges MLX its heavier working set as headroom', () => {
    // This used to read "leaves less headroom for MLX than llama-cpp" and
    // assert it through a 1.3x weights multiplier. That inverted the meaning
    // of the number: MLX's weights are the LIGHTER of the two (0.999x
    // measured, vs llama's measured 0.98-1.09x), and what is heavier is its
    // per-wave compute working set. Both halves are now stated where they
    // belong — weights here, working set in the slot ceiling's headroom — so
    // the invariant that matters is still MLX <= llama in SLOTS.
    const base = { budgetBytes: 96 * GB, weightsBytes: 28 * GB };
    expect(localEngineKvBudgetBytes({ engine: 'mlx', ...base })).toBe(
      96 * GB - estimateMlxResidentBytes(28 * GB),
    );
    const slotInput = { ...base, perTurnCtxTokens: 32_768, kvCacheType: 'f16' as const };
    expect(localEngineSlotCeiling({ engine: 'mlx', ...slotInput })).toBeLessThanOrEqual(
      localEngineSlotCeiling({ engine: 'llama-cpp', ...slotInput }),
    );
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
    //
    // Sized the way buildMlxProvider sizes it: against `concurrencySizingBytes`
    // rather than the admission budget, and with the header-exact per-slot KV
    // MLX reads from the model dir's config.json. Both matter — the raised
    // reserve cap and the measured (1.0, not 1.3) weights multiplier each free
    // memory that the weights-scaled KV heuristic, which under-prices a dense
    // model ~3x, would happily spend on a second slot. buildMlxProvider pins
    // the ceiling to 1 outright when geometry is unreadable, for that reason.
    const budget = computeCapacityBudget({ systemRamBytes: 64 * GB, unifiedMemory: true });
    const n = localEngineSlotCeiling({
      engine: 'mlx',
      budgetBytes: budget.fastBytes,
      sizingBudgetBytes: budget.concurrencySizingBytes,
      weightsBytes: 28 * GB,
      perTurnCtxTokens: 32_768,
      kvCacheType: 'f16',
      // 64 layers x 4 KV heads x 256 head_dim x 2 (K+V) x 2 B x 32K tokens.
      exactPerSlotKvBytesF16: 64 * 4 * 256 * 2 * 2 * 32_768,
    });
    expect(n).toBe(1);
  });

  it('correcting the MLX weights multiplier does not buy a slot', () => {
    // The trap in measuring 1.3x -> 1.0x: ~9 GB of phantom weights on a 27B
    // was silently funding the compute-headroom margin, so an honest weights
    // figure alone would have raised peak concurrency — the one outcome the
    // margin exists to prevent. MLX carries its share of that margin openly
    // instead, and the slot count is unchanged.
    const budget = computeCapacityBudget({ systemRamBytes: 128 * GB, unifiedMemory: true });
    const n = localEngineSlotCeiling({
      engine: 'mlx',
      budgetBytes: budget.fastBytes,
      sizingBudgetBytes: budget.concurrencySizingBytes,
      weightsBytes: 27.5 * GB,
      perTurnCtxTokens: 65_536,
      kvCacheType: 'f16',
      exactPerSlotKvBytesF16: 64 * 4 * 256 * 2 * 2 * 65_536,
    });
    expect(n).toBe(2);
  });

  it('still allows real batching for a small model on a big machine', () => {
    const n = localEngineSlotCeiling({
      engine: 'mlx',
      budgetBytes: autoDetectBudgetBytes(64 * GB, { unifiedMemory: true }),
      weightsBytes: 4 * GB,
      perTurnCtxTokens: 8_192,
      kvCacheType: 'f16',
    });
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe('discrete-GPU hosts — VRAM is memory, not a rounding error', () => {
  // The reported shape: Windows, 63.9 GB RAM, a 24 GB RTX 4090. The budget
  // was 60% of system RAM and nothing else, so a 42 GB MoE the card could
  // run with expert offload was refused, and the refusal explained itself as
  // a percentage of the pool the model would mostly not have lived in.
  const RAM = 64 * GB;
  const VRAM = 24 * GB;
  const host = { unifiedMemory: false, gpuVramBytes: VRAM };

  it('adds usable VRAM to the system-RAM share instead of ignoring it', () => {
    const budget = computeCapacityBudget({ systemRamBytes: RAM, ...host });
    expect(budget.kind).toBe('discrete-gpu');
    expect(budget.vramBytes).toBe(Math.floor(VRAM * 0.95));
    expect(budget.ramShareBytes).toBe(Math.floor(RAM * 0.6));
    expect(budget.budgetBytes).toBe(budget.vramBytes + budget.ramShareBytes);
    // The model from the report: ~42.2 GB resident. Admitted now, denied before.
    expect(budget.budgetBytes).toBeGreaterThan(42.2 * GB);
    expect(autoDetectBudgetBytes(RAM, host)).toBe(budget.budgetBytes);
  });

  it('keeps an explicitly detected 16 GiB card discrete beside 16 GiB RAM', () => {
    setDetectedGpuVramBytes(16 * GB, false);
    try {
      const budget = computeCapacityBudget({ systemRamBytes: 16 * GB });
      expect(budget.kind).toBe('discrete-gpu');
      expect(budget.vramBytes).toBe(Math.floor(16 * GB * 0.95));
      expect(budget.ramShareBytes).toBe(Math.floor(16 * GB * 0.6));
    } finally {
      setDetectedGpuVramBytes(null);
    }
  });

  it('keeps the RAM share bounded no matter what the card absorbs', () => {
    // Every admissible set of models can put at most `ramShareBytes` in RAM:
    // VRAM absorbs the first `vramBytes` of any total under the budget. That
    // bound is why adding the pools together is safe rather than optimistic.
    const budget = computeCapacityBudget({ systemRamBytes: RAM, ...host });
    const worstCaseInRam = budget.budgetBytes - budget.vramBytes;
    expect(worstCaseInRam).toBe(budget.ramShareBytes);
    expect(worstCaseInRam).toBeLessThan(RAM * 0.61);
  });

  it('sizes KV against the card, not the combined budget', () => {
    // The other half of the confusion: slots sized off 38 GB of system RAM
    // on a 24 GB card is how a GPU runs out of memory mid-generation.
    const budget = computeCapacityBudget({ systemRamBytes: RAM, ...host });
    expect(budget.fastBytes).toBe(budget.vramBytes);
    expect(budget.fastBytes).toBeLessThan(budget.budgetBytes);
    expect(fastMemoryBudgetBytes(RAM, host)).toBe(budget.vramBytes);
  });

  it('does not let 32 GiB of system RAM inflate concurrency on a 16 GiB card', () => {
    const budget = computeCapacityBudget({
      systemRamBytes: 32 * GB,
      unifiedMemory: false,
      gpuVramBytes: 16 * GB,
    });
    const slotInput = {
      weightsBytes: 4 * GB,
      perTurnCtxTokens: 65_536,
      kvCacheType: 'f16',
      exactPerSlotKvBytesF16: 4 * GB,
    };

    const vramSlots = llamaCppSlotCeiling({ budgetBytes: budget.fastBytes, ...slotInput });
    const wronglyCombinedSlots = llamaCppSlotCeiling({
      budgetBytes: budget.budgetBytes,
      ...slotInput,
    });

    expect(defaultLocalEngineSlots(budget.fastBytes)).toBe(2);
    expect(vramSlots).toBe(2);
    expect(wronglyCombinedSlots).toBe(5);
  });

  it('treats a shared pool reported as VRAM as unified, not as a second pool', () => {
    // GB10 / DGX Spark and integrated GPUs report host memory as VRAM.
    // Adding it to the RAM share would count the same bytes twice.
    const shared = computeCapacityBudget({ systemRamBytes: RAM, gpuVramBytes: 60 * GB });
    expect(shared.kind).toBe('unified');
    expect(shared.vramBytes).toBe(0);
    // Unified curve: the 16 GiB reserve cap, not the 0.7 fraction, at 64 GB.
    expect(shared.budgetBytes).toBe(RAM - 16 * GB);
    expect(shared.fastBytes).toBe(shared.budgetBytes);
  });

  it('accepts explicit integrated-memory classification when the reported share is below the ratio heuristic', () => {
    // Surface-class Vulkan adapters may advertise ~12 GiB on a 32 GiB host:
    // well below the 75% GB10 heuristic, but still the same physical RAM.
    const integrated = computeCapacityBudget({
      systemRamBytes: 32 * GB,
      gpuVramBytes: 12 * GB,
      unifiedMemory: true,
    });
    expect(integrated.kind).toBe('unified');
    expect(integrated.vramBytes).toBe(0);
    expect(integrated.budgetBytes).toBe(Math.floor(32 * GB * 0.7));
  });

  it('a host with no card is unchanged', () => {
    const cpuOnly = computeCapacityBudget({
      systemRamBytes: RAM,
      gpuVramBytes: null,
      unifiedMemory: false,
    });
    expect(cpuOnly.kind).toBe('system-ram');
    expect(cpuOnly.budgetBytes).toBe(Math.floor(RAM * 0.6));
    expect(cpuOnly.fastBytes).toBe(cpuOnly.budgetBytes);
  });

  it('the broker reports the pools behind its budget', () => {
    const b = new CapacityBroker({
      systemRamBytes: () => RAM,
      unifiedMemory: false,
      gpuVramBytes: VRAM,
    });
    const snap = b.committed();
    expect(snap.pools.kind).toBe('discrete-gpu');
    expect(snap.pools.vramBytes).toBe(Math.floor(VRAM * 0.95));
    expect(snap.budgetBytes).toBe(snap.pools.vramBytes + snap.pools.ramShareBytes);
    expect(b.fastBudgetBytes()).toBe(snap.pools.vramBytes);
  });

  it('an explicit budget lowers the fast ceiling but never raises the card', () => {
    const b = new CapacityBroker({
      systemRamBytes: () => RAM,
      unifiedMemory: false,
      gpuVramBytes: VRAM,
      budgetBytes: 12 * GB,
    });
    expect(b.fastBudgetBytes()).toBe(12 * GB);
    b.setBudgetBytes(null);
    expect(b.fastBudgetBytes()).toBe(Math.floor(VRAM * 0.95));
  });

  it('names the graphics card in the denial instead of a share of system RAM', () => {
    const b = new CapacityBroker({
      systemRamBytes: () => RAM,
      unifiedMemory: false,
      gpuVramBytes: VRAM,
    });
    const c = b.committed();
    const msg = formatCapacityDenial({
      modelLabel: 'qwen3.6-35b-a3b-q8',
      requestedBytes: 70 * GB,
      budgetBytes: c.budgetBytes,
      committedBytes: 0,
      systemRamBytes: c.systemRamBytes,
      pools: c.pools,
    });
    expect(msg).toMatch(/graphics memory/);
    expect(msg).toMatch(/22\.8 GB/);
    expect(msg).toMatch(/38\.4 GB/);
    // The old copy told a Windows user their memory was being kept free for
    // macOS, and framed a GPU budget as a percentage of system RAM.
    expect(msg).not.toMatch(/macOS/);
    expect(msg).not.toMatch(/% of your/);
  });

  it('leaves the RAM-only denial wording alone', () => {
    const msg = formatCapacityDenial({
      modelLabel: 'gemma4-12b-q4',
      requestedBytes: 20 * GB,
      budgetBytes: 10 * GB,
      committedBytes: 0,
      systemRamBytes: 16 * GB,
    });
    expect(msg).toMatch(/about 63% of your 16\.0 GB machine/);
    expect(msg).not.toMatch(/macOS/);
  });
});

describe('clampCtxTokensForMemory', () => {
  // The 2026-08-03 incident, in numbers: gemma4-12b Q4 (6.7 GB weights,
  // ~8 GB resident) at f16 KV on a 32 GB / 12 GB-VRAM machine. Real KV
  // geometry is ~380 KB/token — a 64K single-slot launch projects ~25 GB
  // of KV and became a ~25 GB process that paged the whole desktop out.
  const INCIDENT = {
    requestedPerTurnCtxTokens: 65_536,
    slots: 1,
    kvBytesPerToken: 380 * 1024,
    weightsResidentBytes: 8 * GB,
    budgetBytes: 30.7 * GB,
    freeSystemRamBytes: 15 * GB,
    vramBytes: 11.6 * GB,
  };

  it('clamps the incident launch to something the machine can hold', () => {
    const result = clampCtxTokensForMemory(INCIDENT);
    expect(result.clamped).toBe(true);
    // cap = min(budget 30.7, vram 11.6 + (15-2) free) = 24.6 GB;
    // allowance = (24.6 - 8) * 0.8 = 13.3 GB → ~36.6K tokens → 1024-floor.
    expect(result.perTurnCtxTokens).toBeLessThanOrEqual(36_864);
    expect(result.perTurnCtxTokens).toBeGreaterThanOrEqual(8_192);
    expect(result.perTurnCtxTokens % 1024).toBe(0);
    expect(result.reason).toMatch(/context clamped 65536/);
    expect(result.reason).toMatch(/KV/);
  });

  it('clamps much harder when the machine is already under pressure', () => {
    // Second daemon of the night: another engine already ate the RAM.
    const result = clampCtxTokensForMemory({
      ...INCIDENT,
      freeSystemRamBytes: 4.5 * GB,
    });
    expect(result.clamped).toBe(true);
    // cap = min(30.7, 11.6 + 2.5) = 14.1; allowance = 4.9 GB → ~13.5K.
    expect(result.perTurnCtxTokens).toBeLessThanOrEqual(13_312);
  });

  it('leaves a launch that fits untouched', () => {
    const result = clampCtxTokensForMemory({
      requestedPerTurnCtxTokens: 65_536,
      slots: 1,
      kvBytesPerToken: 30 * 1024,
      weightsResidentBytes: 4 * GB,
      budgetBytes: 30 * GB,
      freeSystemRamBytes: 24 * GB,
      vramBytes: 11.6 * GB,
    });
    expect(result).toEqual({ perTurnCtxTokens: 65_536, clamped: false, reason: null });
  });

  it('never clamps below the floor even when nothing fits', () => {
    const result = clampCtxTokensForMemory({
      ...INCIDENT,
      freeSystemRamBytes: 1 * GB,
      vramBytes: 0,
      budgetBytes: 6 * GB,
    });
    expect(result.clamped).toBe(true);
    expect(result.perTurnCtxTokens).toBe(8_192);
  });

  it('honors the budget when it is tighter than live memory', () => {
    const result = clampCtxTokensForMemory({
      ...INCIDENT,
      budgetBytes: 12 * GB,
      committedOtherBytes: 2 * GB,
      freeSystemRamBytes: 64 * GB,
    });
    expect(result.clamped).toBe(true);
    // budgetCap = 10 GB binds; allowance = (10 - 8) * 0.8 = 1.6 GB → ~4.4K
    // → floor wins.
    expect(result.perTurnCtxTokens).toBe(8_192);
    expect(result.reason).toMatch(/held by other models/);
  });

  it('accounts for slot multiplication', () => {
    const one = clampCtxTokensForMemory({ ...INCIDENT, slots: 1 });
    const two = clampCtxTokensForMemory({ ...INCIDENT, slots: 2 });
    expect(two.perTurnCtxTokens).toBeLessThan(one.perTurnCtxTokens);
  });

  it('is inert without a usable KV rate or when already at the floor', () => {
    expect(clampCtxTokensForMemory({ ...INCIDENT, kvBytesPerToken: 0 }).clamped).toBe(false);
    expect(clampCtxTokensForMemory({ ...INCIDENT, requestedPerTurnCtxTokens: 8_192 }).clamped).toBe(
      false,
    );
  });
});

describe('model-aware context admission', () => {
  it('reduces slots before sacrificing the 64K working window', () => {
    const result = planCtxTokensForMemory({
      requestedPerTurnCtxTokens: 98_304,
      minimumPerTurnCtxTokens: 65_536,
      slots: 2,
      kvBytesPerToken: 100 * 1024,
      weightsResidentBytes: 4 * GB,
      budgetBytes: 18 * GB,
      freeSystemRamBytes: 64 * GB,
      vramBytes: 0,
    });
    expect(result.minimumSatisfied).toBe(true);
    expect(result.slots).toBe(1);
    expect(result.perTurnCtxTokens).toBe(98_304);
  });

  it('denies admission when even one slot cannot retain 64K', () => {
    const result = planCtxTokensForMemory({
      requestedPerTurnCtxTokens: 65_536,
      minimumPerTurnCtxTokens: 65_536,
      slots: 2,
      kvBytesPerToken: 380 * 1024,
      weightsResidentBytes: 8 * GB,
      budgetBytes: 30.7 * GB,
      freeSystemRamBytes: 15 * GB,
      vramBytes: 11.6 * GB,
    });
    expect(result.minimumSatisfied).toBe(false);
    expect(result.slots).toBe(1);
    expect(result.perTurnCtxTokens).toBeLessThan(65_536);
    expect(formatContextCapacityDenial({ modelLabel: 'Gemma', plan: result })).toMatch(
      /required 65,536-token working window/,
    );
  });

  it('uses a genuinely smaller native window as the model floor', () => {
    expect(
      resolveLocalContextRequirement({
        modelContextWindow: 32_768,
        requestedContextWindow: 16_384,
      }),
    ).toMatchObject({
      minimumPerTurnCtxTokens: 32_768,
      requestedPerTurnCtxTokens: 32_768,
    });
  });

  it('raises low preferences to 64K while honoring useful higher requests', () => {
    expect(
      resolveLocalContextRequirement({
        modelContextWindow: 128_000,
        requestedContextWindow: 16_384,
      }).requestedPerTurnCtxTokens,
    ).toBe(65_536);
    expect(
      resolveLocalContextRequirement({
        modelContextWindow: 128_000,
        requestedContextWindow: 98_304,
      }).requestedPerTurnCtxTokens,
    ).toBe(98_304);
  });

  it('adaptive llama.cpp sizing keeps the practical target and 64K floor', () => {
    expect(
      resolveLlamaCppContextRequirement({
        modelContextWindow: 262_144,
        adaptiveContextWindow: 98_304,
        contextSizing: 'adaptive',
      }),
    ).toMatchObject({
      minimumPerTurnCtxTokens: 65_536,
      requestedPerTurnCtxTokens: 98_304,
      strict: false,
    });
  });

  it('model-max sizing makes the advertised window a strict admission minimum', () => {
    expect(
      resolveLlamaCppContextRequirement({
        modelContextWindow: 262_144,
        adaptiveContextWindow: 65_536,
        contextSizing: 'model-max',
      }),
    ).toMatchObject({
      nativeContextWindow: 262_144,
      minimumPerTurnCtxTokens: 262_144,
      requestedPerTurnCtxTokens: 262_144,
      strict: true,
    });
  });

  it('model-max on an SWA model: full-attention math denies, the windowed re-plan admits at native', () => {
    // gemma4-12b's real header geometry: 48 layers in a 5:1 SWA:global
    // pattern, SWA layers 8 KV heads × 256+256 dims, global layers 1 KV
    // head × 512+512, sliding window 1024, native window 256000. The
    // regression this pins: an early build gated the windowed re-plan on
    // `!strict`, so model-max evaluated Gemma ONLY under full-attention
    // math — which can never fit — and denied a model whose real windowed
    // cache at the full native window is ~5 GB.
    const NATIVE = 256_000;
    const requirement = resolveLlamaCppContextRequirement({
      modelContextWindow: NATIVE,
      adaptiveContextWindow: 65_536,
      contextSizing: 'model-max',
    });
    expect(requirement).toMatchObject({
      minimumPerTurnCtxTokens: NATIVE,
      requestedPerTurnCtxTokens: NATIVE,
      strict: true,
    });

    const blockCount = 48;
    const perLayerHeads = Array.from({ length: blockCount }, (_, i) => ((i + 1) % 6 === 0 ? 1 : 8));
    const meanHeads = perLayerHeads.reduce((a, b) => a + b, 0) / blockCount;
    const budget = {
      weightsResidentBytes: 8.6 * GB,
      budgetBytes: 44.8 * GB,
      committedOtherBytes: 0,
      freeSystemRamBytes: 40 * GB,
      vramBytes: 0,
    };

    const fullKvAtReference = estimateKvReserveBytes({
      blockCount,
      headCountKv: meanHeads,
      keyLength: 512,
      valueLength: 512,
      ctxTokens: 4096,
      kvCacheType: 'f16',
    });
    const fullPlan = planCtxTokensForMemory({
      requestedPerTurnCtxTokens: requirement.requestedPerTurnCtxTokens,
      slots: 1,
      minimumPerTurnCtxTokens: requirement.minimumPerTurnCtxTokens,
      kvBytesPerToken: (fullKvAtReference ?? 0) / 4096,
      ...budget,
    });
    expect(fullPlan.minimumSatisfied).toBe(false);

    const windowed = estimateWindowedKvLinearization({
      blockCount,
      headCountKvPerLayer: perLayerHeads,
      slidingWindow: 1024,
      slidingWindowPattern: Array.from({ length: blockCount }, (_, i) => (i + 1) % 6 !== 0),
      keyLength: 512,
      valueLength: 512,
      keyLengthSwa: 256,
      valueLengthSwa: 256,
      kvCacheType: 'f16',
    });
    expect(windowed).toBeDefined();
    const windowedPlan = planCtxTokensForMemory({
      requestedPerTurnCtxTokens: requirement.requestedPerTurnCtxTokens,
      slots: 1,
      minimumPerTurnCtxTokens: requirement.minimumPerTurnCtxTokens,
      kvBytesPerToken: windowed?.bytesPerToken ?? 0,
      ...budget,
      weightsResidentBytes: budget.weightsResidentBytes + (windowed?.fixedBytes ?? 0),
    });
    expect(windowedPlan).toMatchObject({
      minimumSatisfied: true,
      clamped: false,
      perTurnCtxTokens: NATIVE,
      slots: 1,
    });
  });

  it('prices a linear-attention hybrid on its full-attention layers only', () => {
    // qwen35moe (Qwen 3.5 MoE / Ornith / BTL-4): 40 layers, every 4th full
    // attention, the other 30 carrying a context-independent recurrent
    // state. Counting all 40 gave 80 KB/token; the truth is 20 KB/token,
    // which is what the publisher documents and what the engine allocates.
    const geometry = {
      blockCount: 40,
      headCountKv: 2,
      keyLength: 256,
      valueLength: 256,
      fullAttentionInterval: 4,
      ssmInnerSize: 4096,
      ssmStateSize: 128,
      ssmConvKernel: 4,
    };
    const hybrid = estimateLinearHybridKvLinearization({ ...geometry, kvCacheType: 'f16' });
    expect(hybrid).toBeDefined();
    // 10 full-attention layers x 2 kv heads x (256+256) x 2 bytes.
    expect(hybrid?.bytesPerToken).toBe(20 * 1024);
    // 30 linear layers, each holding conv + recurrent state at f32. Tens of
    // MB against GB of weights — real, but never the deciding term.
    expect(hybrid?.fixedBytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(hybrid?.fixedBytes).toBeLessThan(100 * 1024 * 1024);

    // The slope-only estimator agrees, so the bytes-per-token a caller
    // derives by dividing through a reference context stays correct.
    const atRef = estimateKvReserveBytes({ ...geometry, ctxTokens: 4096, kvCacheType: 'f16' });
    expect((atRef ?? 0) / 4096).toBe(20 * 1024);
  });

  it('leaves ordinary full-attention models on every-layer math', () => {
    const dense = {
      blockCount: 40,
      headCountKv: 2,
      keyLength: 256,
      valueLength: 256,
    };
    expect(estimateLinearHybridKvLinearization({ ...dense, kvCacheType: 'f16' })).toBeUndefined();
    const atRef = estimateKvReserveBytes({ ...dense, ctxTokens: 4096, kvCacheType: 'f16' });
    expect((atRef ?? 0) / 4096).toBe(80 * 1024);
  });

  it('an explicit numeric override wins over model-max and retains adaptive fallback', () => {
    expect(
      resolveLlamaCppContextRequirement({
        modelContextWindow: 262_144,
        explicitContextWindow: 131_072,
        adaptiveContextWindow: 65_536,
        contextSizing: 'model-max',
      }),
    ).toMatchObject({
      minimumPerTurnCtxTokens: 65_536,
      requestedPerTurnCtxTokens: 131_072,
    });
  });

  it('a per-model override below the floor is honored via a reduced caller floor', () => {
    const requirement = resolveLlamaCppContextRequirement({
      modelContextWindow: 262_144,
      explicitContextWindow: 32_768,
      adaptiveContextWindow: 65_536,
      contextSizing: 'adaptive',
      // Callers pass min(hostFloor, override) so an explicit 32K survives
      // the 64K floor's max() instead of being silently raised.
      minViableContextTokens: 32_768,
    });
    expect(requirement).toMatchObject({
      minimumPerTurnCtxTokens: 32_768,
      requestedPerTurnCtxTokens: 32_768,
      strict: false,
    });
    expect(requirement.growthTargetTokens).toBeUndefined();
  });
});

describe('adaptive context growth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('resolveLlamaCppContextRequirement growth target', () => {
    it('emits the native window as the target for a plain adaptive launch', () => {
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          adaptiveContextWindow: 65_536,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBe(262_144);
    });

    it('floors an off-grid native window to 1024 alignment', () => {
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 100_000,
          adaptiveContextWindow: 65_536,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBe(99_328);
    });

    it('emits no target under strict model-max, explicit overrides, or unknown native', () => {
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          adaptiveContextWindow: 65_536,
          contextSizing: 'model-max',
        }).growthTargetTokens,
      ).toBeUndefined();
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          explicitContextWindow: 98_304,
          adaptiveContextWindow: 65_536,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBeUndefined();
      expect(
        resolveLlamaCppContextRequirement({
          adaptiveContextWindow: 65_536,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBeUndefined();
    });

    it('treats an authored manifest contextSize as a growth ceiling', () => {
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          adaptiveContextWindow: 98_304,
          manifestContextSize: 98_304,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBeUndefined();
      // A manifest ceiling above the request still allows growth up to it.
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          adaptiveContextWindow: 65_536,
          manifestContextSize: 131_072,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBe(131_072);
    });

    it('honors the explicit and env growth ceilings', () => {
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          adaptiveContextWindow: 65_536,
          contextSizing: 'adaptive',
          growthCeilingTokens: 131_072,
        }).growthTargetTokens,
      ).toBe(131_072);
      vi.stubEnv('GEZEL_LLAMA_GROWTH_CEILING_TOKENS', '98304');
      expect(
        resolveLlamaCppContextRequirement({
          modelContextWindow: 262_144,
          adaptiveContextWindow: 65_536,
          contextSizing: 'adaptive',
        }).growthTargetTokens,
      ).toBe(98_304);
    });
  });

  describe('planAdaptiveContextGrowth', () => {
    // A 24 GB discrete card holding a dense ~27B q4: weights ~19.1 GB
    // resident against a 22.8 GB usable fast pool, ~36 KB/token of KV.
    const DENSE_ON_CARD = {
      basePerTurnCtxTokens: 65_536,
      targetPerTurnCtxTokens: 262_144,
      slots: 1,
      kvBytesPerToken: 36 * 1024,
      weightsResidentBytes: 19.1 * GB,
      fastBudgetBytes: 22.8 * GB,
      committedOtherBytes: 0,
      budgetKind: 'discrete-gpu' as const,
      vramBytes: 22.8 * GB,
      freeSystemRamBytes: 64 * GB,
    };

    it('grows a dense model into leftover VRAM, 1024-aligned, above the base grant', () => {
      const result = planAdaptiveContextGrowth(DENSE_ON_CARD);
      expect(result.grown).toBe(true);
      expect(result.perTurnCtxTokens).toBeGreaterThan(65_536);
      expect(result.perTurnCtxTokens % 1024).toBe(0);
      expect(result.reason).toMatch(/growing context 65536/);
      // The grown KV plus weights stays inside the fast pool with the
      // compute headroom the shared clamp enforces.
      const kv = result.perTurnCtxTokens * DENSE_ON_CARD.kvBytesPerToken;
      expect(DENSE_ON_CARD.weightsResidentBytes + kv / 0.8).toBeLessThanOrEqual(
        DENSE_ON_CARD.fastBudgetBytes + 1024,
      );
    });

    it('confines discrete-GPU growth to the card — free system RAM is invisible', () => {
      const dry = planAdaptiveContextGrowth({ ...DENSE_ON_CARD, freeSystemRamBytes: 0 });
      const flooded = planAdaptiveContextGrowth({
        ...DENSE_ON_CARD,
        freeSystemRamBytes: 999 * GB,
      });
      expect(flooded.perTurnCtxTokens).toBe(dry.perTurnCtxTokens);
    });

    it('uses live free RAM on shared-pool hosts', () => {
      const unified = {
        ...DENSE_ON_CARD,
        budgetKind: 'unified' as const,
        vramBytes: 0,
        weightsResidentBytes: 8.6 * GB,
        fastBudgetBytes: 44.8 * GB,
      };
      const tight = planAdaptiveContextGrowth({ ...unified, freeSystemRamBytes: 14 * GB });
      const roomy = planAdaptiveContextGrowth({ ...unified, freeSystemRamBytes: 64 * GB });
      expect(roomy.perTurnCtxTokens).toBeGreaterThan(tight.perTurnCtxTokens);
    });

    it('never grows past the target and reports a full-native grant exactly', () => {
      // SWA-class linearization: ~2 KB/token makes the whole native window cheap.
      const result = planAdaptiveContextGrowth({
        ...DENSE_ON_CARD,
        weightsResidentBytes: 5.9 * GB,
        kvBytesPerToken: 2 * 1024,
      });
      expect(result).toMatchObject({ grown: true, perTurnCtxTokens: 262_144 });
    });

    it('never returns below the base grant when weights exceed the fast pool', () => {
      const result = planAdaptiveContextGrowth({
        ...DENSE_ON_CARD,
        weightsResidentBytes: 30 * GB,
      });
      expect(result).toMatchObject({ grown: false, perTurnCtxTokens: 65_536, reason: null });
    });

    it('refuses MoE growth on a discrete card but allows it on unified hosts', () => {
      expect(planAdaptiveContextGrowth({ ...DENSE_ON_CARD, isMoE: true }).grown).toBe(false);
      expect(
        planAdaptiveContextGrowth({
          ...DENSE_ON_CARD,
          isMoE: true,
          budgetKind: 'unified',
          vramBytes: 0,
          weightsResidentBytes: 8.6 * GB,
          fastBudgetBytes: 44.8 * GB,
        }).grown,
      ).toBe(true);
    });

    it('shrinks growth by other models’ committed reservations', () => {
      const alone = planAdaptiveContextGrowth(DENSE_ON_CARD);
      const shared = planAdaptiveContextGrowth({
        ...DENSE_ON_CARD,
        committedOtherBytes: 2 * GB,
      });
      expect(shared.perTurnCtxTokens).toBeLessThan(alone.perTurnCtxTokens);
    });
  });

  describe('planAdaptiveContextGrowth — slot trade', () => {
    // A 32 GB-class card: 30 GB fast pool, 19 GB of resident weights,
    // ~36 KB/token of KV. The 11 GB KV allowance splits as 84,992
    // tokens/slot at 3 lanes and 128,000 at 2.
    const THREE_LANES = {
      basePerTurnCtxTokens: 65_536,
      targetPerTurnCtxTokens: 262_144,
      slots: 3,
      kvBytesPerToken: 36_864,
      weightsResidentBytes: 19 * GB,
      fastBudgetBytes: 30 * GB,
      committedOtherBytes: 0,
      budgetKind: 'discrete-gpu' as const,
      vramBytes: 30 * GB,
      freeSystemRamBytes: 0,
      allowSlotTrade: true,
    };

    it('consolidates 3 → 2 lanes when the target is out of reach and the gain is real', () => {
      const result = planAdaptiveContextGrowth(THREE_LANES);
      expect(result).toMatchObject({ grown: true, slots: 2, perTurnCtxTokens: 128_000 });
      expect(result.reason).toMatch(/consolidating 3 → 2 engine lanes/);
    });

    it('never trades lanes without allowSlotTrade — an explicit pin is not growth’s to spend', () => {
      const result = planAdaptiveContextGrowth({ ...THREE_LANES, allowSlotTrade: false });
      expect(result).toMatchObject({ grown: true, slots: 3, perTurnCtxTokens: 84_992 });
    });

    it('keeps every lane when the target is already reachable without trading', () => {
      // 80K target fits at 3 lanes (84,992 available per slot).
      const result = planAdaptiveContextGrowth({
        ...THREE_LANES,
        targetPerTurnCtxTokens: 81_920,
      });
      expect(result).toMatchObject({ grown: true, slots: 3, perTurnCtxTokens: 81_920 });
    });

    it('takes the LARGEST lane count that reaches the target, not always two', () => {
      // At 4 lanes the pool yields 63,488/slot; the 80K target is reachable
      // at 3 — consolidating all the way to 2 would spend a lane for nothing.
      const result = planAdaptiveContextGrowth({
        ...THREE_LANES,
        slots: 4,
        targetPerTurnCtxTokens: 81_920,
      });
      expect(result).toMatchObject({ grown: true, slots: 3, perTurnCtxTokens: 81_920 });
    });

    it('never consolidates below two lanes', () => {
      const result = planAdaptiveContextGrowth({ ...THREE_LANES, slots: 2 });
      expect(result).toMatchObject({ grown: true, slots: 2, perTurnCtxTokens: 128_000 });
    });

    it('refuses a marginal trade — a lane is worth more than a few percent of window', () => {
      // 88K target: 3 lanes already grant 84,992, so trading to 2 buys only
      // ~6% — under the materiality bar, the lanes win.
      const result = planAdaptiveContextGrowth({
        ...THREE_LANES,
        targetPerTurnCtxTokens: 90_112,
      });
      expect(result).toMatchObject({ grown: true, slots: 3, perTurnCtxTokens: 84_992 });
    });

    it('prices the windowed fixed block per LANE, so trading also frees fixed KV', () => {
      // SWA-class shape: modest slope, large per-slot fixed block. Dropping
      // a lane returns its whole 3 GB fixed block to the pool: 3 lanes leave
      // only (30−19−9)×0.8 = 1.6 GB of slope KV (~69K/slot), while 2 lanes
      // leave (30−19−6)×0.8 = 4 GB — the full native window.
      const result = planAdaptiveContextGrowth({
        ...THREE_LANES,
        kvBytesPerToken: 8 * 1024,
        kvFixedPerSlotBytes: 3 * GB,
        targetPerTurnCtxTokens: 262_144,
      });
      expect(result).toMatchObject({ grown: true, slots: 2, perTurnCtxTokens: 262_144 });
    });
  });
});

describe('minViableLocalContextTokens', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ambient = () => {
    // The suite pins GEZEL_MIN_CONTEXT_TOKENS so context assertions are
    // host-independent; these cases are about the host derivation itself.
    vi.stubEnv('GEZEL_MIN_CONTEXT_TOKENS', '');
  };

  it('holds a roomy host to the 64K floor', () => {
    ambient();
    const budget = computeCapacityBudget({ systemRamBytes: 64 * GB, unifiedMemory: true });
    expect(minViableLocalContextTokens({ systemRamBytes: 64 * GB, budget })).toBe(65_536);
  });

  it('drops a 16 GB unified host to 32K rather than denying the launch', () => {
    ambient();
    const budget = computeCapacityBudget({ systemRamBytes: 16 * GB, unifiedMemory: true });
    expect(minViableLocalContextTokens({ systemRamBytes: 16 * GB, budget })).toBe(32_768);
  });

  it('judges a discrete card on its VRAM, not the system RAM beside it', () => {
    ambient();
    const smallCard = computeCapacityBudget({
      systemRamBytes: 64 * GB,
      gpuVramBytes: 8 * GB,
      unifiedMemory: false,
    });
    expect(minViableLocalContextTokens({ systemRamBytes: 64 * GB, budget: smallCard })).toBe(
      32_768,
    );

    const bigCardSmallHost = computeCapacityBudget({
      systemRamBytes: 16 * GB,
      gpuVramBytes: 24 * GB,
      unifiedMemory: false,
    });
    expect(minViableLocalContextTokens({ systemRamBytes: 16 * GB, budget: bigCardSmallHost })).toBe(
      65_536,
    );
  });

  it('honors GEZEL_MIN_CONTEXT_TOKENS over the host derivation', () => {
    vi.stubEnv('GEZEL_MIN_CONTEXT_TOKENS', '49152');
    const budget = computeCapacityBudget({ systemRamBytes: 16 * GB, unifiedMemory: true });
    expect(minViableLocalContextTokens({ systemRamBytes: 16 * GB, budget })).toBe(49_152);
  });

  it('a constrained floor admits the launch that 64K would have denied', () => {
    // ~1 MB/token of KV: 64K needs ~64 GB, 32K needs ~32 GB, and the host
    // has ~34 GB of headroom after the weights.
    const input = {
      requestedPerTurnCtxTokens: 65_536,
      slots: 1,
      kvBytesPerToken: 1024 * 1024,
      weightsResidentBytes: 6 * GB,
      budgetBytes: 52 * GB,
      freeSystemRamBytes: 56 * GB,
      vramBytes: 0,
    };
    expect(planCtxTokensForMemory({ ...input, minimumPerTurnCtxTokens: 65_536 })).toMatchObject({
      minimumSatisfied: false,
    });
    const constrained = planCtxTokensForMemory({ ...input, minimumPerTurnCtxTokens: 32_768 });
    expect(constrained.minimumSatisfied).toBe(true);
    expect(constrained.perTurnCtxTokens).toBeGreaterThanOrEqual(32_768);
  });

  it('a constrained floor lets a model keep a 32K manifest recommendation', () => {
    expect(
      resolveLocalContextRequirement({
        modelContextWindow: 262_144,
        requestedContextWindow: 32_768,
        minViableContextTokens: 32_768,
      }),
    ).toMatchObject({
      minimumPerTurnCtxTokens: 32_768,
      requestedPerTurnCtxTokens: 32_768,
    });
    expect(
      resolveLlamaCppContextRequirement({
        modelContextWindow: 262_144,
        adaptiveContextWindow: 65_536,
        contextSizing: 'adaptive',
        minViableContextTokens: 32_768,
      }),
    ).toMatchObject({
      minimumPerTurnCtxTokens: 32_768,
      requestedPerTurnCtxTokens: 65_536,
      strict: false,
    });
  });
});

describe('availableSystemRamBytes parsers', () => {
  // os.freemem() reports truly-free pages only; on macOS a just-exited
  // engine's mmap'd weights are file-backed cache and count as "used".
  // Wild-caught: the ctx clamp saw ~6.6GB on a 64GB box and floored
  // gemma4-31b to 8,192 ctx — 11/11 trials died on context overflow.
  it('parses vm_stat into reclaimable-aware bytes', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                  100000.',
      'Pages active:                               1500000.',
      'Pages inactive:                              200000.',
      'Pages speculative:                             1000.',
      'Pages throttled:                                  0.',
      'Pages wired down:                            210873.',
      'Pages purgeable:                              20000.',
      'File-backed pages:                          1000000.',
    ].join('\n');
    // (100000+200000+1000+20000+1000000) * 16384
    expect(parseVmStatAvailableBytes(out)).toBe(1_321_000 * 16384);
  });

  it('returns null for non-vm_stat text', () => {
    expect(parseVmStatAvailableBytes('command not found')).toBeNull();
  });

  it('parses /proc/meminfo MemAvailable', () => {
    const txt =
      'MemTotal:       65536000 kB\nMemFree:         1000000 kB\nMemAvailable:   42000000 kB\n';
    expect(parseMeminfoAvailableBytes(txt)).toBe(42_000_000 * 1024);
  });

  it('returns null when MemAvailable is absent', () => {
    expect(parseMeminfoAvailableBytes('MemFree: 12 kB')).toBeNull();
  });
});
