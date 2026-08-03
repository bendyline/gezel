import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE_REUSE, buildLlamaCppEngineArgs } from './engine-flags.js';

/** Value token immediately after `flag`, or undefined if the flag is absent. */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

describe('buildLlamaCppEngineArgs — defaults & cache-reuse', () => {
  it('empty single-slot config emits only the auto-on cache-reuse default', () => {
    const args = buildLlamaCppEngineArgs({ config: {}, slots: 1 });
    expect(argValue(args, '--cache-reuse')).toBe(String(DEFAULT_CACHE_REUSE));
    // Nothing else without any config or a quantized KV cache.
    expect(has(args, '--flash-attn')).toBe(false);
    expect(has(args, '--n-gpu-layers')).toBe(false);
    expect(has(args, '--cpu-moe')).toBe(false);
  });

  it('does NOT auto-enable cache-reuse under multi-slot (b9843 would reject it)', () => {
    expect(has(buildLlamaCppEngineArgs({ config: {}, slots: 4 }), '--cache-reuse')).toBe(false);
    // Unknown slot count is treated conservatively (no default).
    expect(has(buildLlamaCppEngineArgs({ config: {} }), '--cache-reuse')).toBe(false);
  });

  it('an explicit cache-reuse is passed regardless of slot count', () => {
    expect(
      argValue(
        buildLlamaCppEngineArgs({ config: { llamaCppCacheReuse: 128 }, slots: 4 }),
        '--cache-reuse',
      ),
    ).toBe('128');
  });

  it('cache-reuse can be disabled with 0 even on a single slot', () => {
    const args = buildLlamaCppEngineArgs({ config: { llamaCppCacheReuse: 0 }, slots: 1 });
    expect(has(args, '--cache-reuse')).toBe(false);
  });

  it('per-model cacheReuse is used when global is unset', () => {
    const args = buildLlamaCppEngineArgs({ config: {}, perModel: { cacheReuse: 512 }, slots: 4 });
    expect(argValue(args, '--cache-reuse')).toBe('512');
  });
});

describe('buildLlamaCppEngineArgs — flash-attn coherence & back-compat', () => {
  it('forces flash-attn on under quantized KV when otherwise unset', () => {
    expect(
      argValue(buildLlamaCppEngineArgs({ config: {}, kvCacheType: 'q8_0' }), '--flash-attn'),
    ).toBe('on');
    expect(
      argValue(buildLlamaCppEngineArgs({ config: {}, kvCacheType: 'q4_0' }), '--flash-attn'),
    ).toBe('on');
  });

  it('does NOT force flash-attn under f16 KV', () => {
    expect(has(buildLlamaCppEngineArgs({ config: {}, kvCacheType: 'f16' }), '--flash-attn')).toBe(
      false,
    );
  });

  it('legacy boolean true → on; false → omit under f16 but coerced on under quantized KV', () => {
    expect(
      argValue(buildLlamaCppEngineArgs({ config: { llamaCppFlashAttn: true } }), '--flash-attn'),
    ).toBe('on');
    // Legacy `false` only ever meant "don't pass the flag" (server default) —
    // the old schema had no force-off. Under f16 we honour that and omit it…
    expect(
      has(
        buildLlamaCppEngineArgs({ config: { llamaCppFlashAttn: false }, kvCacheType: 'f16' }),
        '--flash-attn',
      ),
    ).toBe(false);
    // …but quantized KV WITHOUT flash-attn is the known-bad pairing, so the
    // coherence rule still forces it on. Only an explicit `'off'` defeats that.
    expect(
      argValue(
        buildLlamaCppEngineArgs({ config: { llamaCppFlashAttn: false }, kvCacheType: 'q8_0' }),
        '--flash-attn',
      ),
    ).toBe('on');
  });

  it('explicit off wins over KV coherence', () => {
    expect(
      argValue(
        buildLlamaCppEngineArgs({ config: { llamaCppFlashAttn: 'off' }, kvCacheType: 'q8_0' }),
        '--flash-attn',
      ),
    ).toBe('off');
  });
});

describe('buildLlamaCppEngineArgs — GPU / MoE offload', () => {
  it('maps -1 to "all"', () => {
    expect(
      argValue(buildLlamaCppEngineArgs({ config: { llamaCppNGpuLayers: -1 } }), '--n-gpu-layers'),
    ).toBe('all');
  });
  it('passes an explicit layer count', () => {
    expect(
      argValue(buildLlamaCppEngineArgs({ config: { llamaCppNGpuLayers: 20 } }), '--n-gpu-layers'),
    ).toBe('20');
    // 0 layers (CPU-only) is a real value, not "unset".
    expect(
      argValue(buildLlamaCppEngineArgs({ config: { llamaCppNGpuLayers: 0 } }), '--n-gpu-layers'),
    ).toBe('0');
  });
  it('cpu-moe wins over n-cpu-moe (all experts already on CPU)', () => {
    const args = buildLlamaCppEngineArgs({ config: { llamaCppCpuMoe: true, llamaCppNCpuMoe: 8 } });
    expect(has(args, '--cpu-moe')).toBe(true);
    expect(has(args, '--n-cpu-moe')).toBe(false);
  });
  it('n-cpu-moe emits the partial split when cpu-moe is off', () => {
    expect(
      argValue(buildLlamaCppEngineArgs({ config: { llamaCppNCpuMoe: 12 } }), '--n-cpu-moe'),
    ).toBe('12');
  });
  it('explicit cpu-moe:false forces experts on the GPU, suppressing the planner split', () => {
    // Tri-state "Off": the planner wanted a partial offload, but the user
    // said no. Neither --cpu-moe nor --n-cpu-moe should be emitted.
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppCpuMoe: false },
      planner: { cpuMoe: false, nCpuMoe: 6, reason: 'partial split fits' },
    });
    expect(has(args, '--cpu-moe')).toBe(false);
    expect(has(args, '--n-cpu-moe')).toBe(false);
  });
  it('an explicit partial split survives an explicit cpu-moe:false', () => {
    // Force-off suppresses only the PLANNER's split, never an explicit one.
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppCpuMoe: false, llamaCppNCpuMoe: 4 },
    });
    expect(has(args, '--cpu-moe')).toBe(false);
    expect(argValue(args, '--n-cpu-moe')).toBe('4');
  });
});

describe('buildLlamaCppEngineArgs — SWA full cache (Gemma auto)', () => {
  it('auto-enables --swa-full for the Gemma family', () => {
    expect(has(buildLlamaCppEngineArgs({ config: {}, architecture: 'gemma3' }), '--swa-full')).toBe(
      true,
    );
    expect(
      has(buildLlamaCppEngineArgs({ config: {}, modelId: 'gemma-3-12b-it' }), '--swa-full'),
    ).toBe(true);
  });
  it('leaves --swa-full off for non-Gemma models by default', () => {
    expect(has(buildLlamaCppEngineArgs({ config: {}, architecture: 'qwen3' }), '--swa-full')).toBe(
      false,
    );
  });
  it('an explicit false forces --swa-full off even for Gemma', () => {
    expect(
      has(
        buildLlamaCppEngineArgs({ config: { llamaCppSwaFull: false }, architecture: 'gemma3' }),
        '--swa-full',
      ),
    ).toBe(false);
  });
  it('an explicit true forces --swa-full on for a non-Gemma model', () => {
    expect(
      has(
        buildLlamaCppEngineArgs({ config: { llamaCppSwaFull: true }, architecture: 'qwen3' }),
        '--swa-full',
      ),
    ).toBe(true);
  });
});

describe('buildLlamaCppEngineArgs — precedence (global > perModel > planner)', () => {
  it('global config wins over the manifest', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppNGpuLayers: 10 },
      perModel: { nGpuLayers: 99 },
    });
    expect(argValue(args, '--n-gpu-layers')).toBe('10');
  });
  it('manifest wins over the planner', () => {
    const args = buildLlamaCppEngineArgs({
      config: {},
      perModel: { cpuMoe: false, nCpuMoe: 4 },
      planner: { cpuMoe: true, reason: 'would not fit VRAM' },
    });
    // perModel expressed nCpuMoe:4 and cpuMoe:false → planner's cpuMoe is shadowed.
    expect(has(args, '--cpu-moe')).toBe(false);
    expect(argValue(args, '--n-cpu-moe')).toBe('4');
  });
  it('planner fills in when neither global nor manifest set the field', () => {
    const args = buildLlamaCppEngineArgs({ config: {}, planner: { nGpuLayers: -1, cpuMoe: true } });
    expect(argValue(args, '--n-gpu-layers')).toBe('all');
    expect(has(args, '--cpu-moe')).toBe(true);
  });
});

describe('buildLlamaCppEngineArgs — speculative decoding', () => {
  it('emits --spec-type for ngram modes with no draft model', () => {
    const args = buildLlamaCppEngineArgs({ config: { llamaCppSpecType: 'ngram-mod' } });
    expect(argValue(args, '--spec-type')).toBe('ngram-mod');
    expect(has(args, '--spec-draft-model')).toBe(false);
  });
  it('"none" is treated as off', () => {
    expect(
      has(buildLlamaCppEngineArgs({ config: { llamaCppSpecType: 'none' } }), '--spec-type'),
    ).toBe(false);
  });
  it('draft-simple pulls in the draft model + n-max', () => {
    const args = buildLlamaCppEngineArgs({
      config: {
        llamaCppSpecType: 'draft-simple',
        llamaCppDraftModelPath: '/m/draft.gguf',
        llamaCppSpecDraftNMax: 5,
      },
    });
    expect(argValue(args, '--spec-type')).toBe('draft-simple');
    expect(argValue(args, '--spec-draft-model')).toBe('/m/draft.gguf');
    expect(argValue(args, '--spec-draft-n-max')).toBe('5');
  });
  it('per-model spec block is honoured', () => {
    const args = buildLlamaCppEngineArgs({
      config: {},
      perModel: { spec: { type: 'draft-mtp' } },
      ggufHasMtp: true,
    });
    expect(argValue(args, '--spec-type')).toBe('draft-mtp');
  });

  it('passes a catalog-installed sidecar to separate-head MTP models', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppSpecType: 'draft-mtp' },
      perModel: { spec: { mtp: true, nMax: 4 } },
      ggufHasMtp: true,
      installedDraftModelPath: '/models/gemma/mtp.gguf',
    });
    expect(argValue(args, '--spec-type')).toBe('draft-mtp');
    expect(argValue(args, '--spec-draft-model')).toBe('/models/gemma/mtp.gguf');
    expect(argValue(args, '--spec-draft-n-max')).toBe('4');
  });

  it('does not require a sidecar for combined MTP GGUFs', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppSpecType: 'draft-mtp' },
      perModel: { spec: { mtp: true } },
      ggufHasMtp: true,
    });
    expect(argValue(args, '--spec-type')).toBe('draft-mtp');
    expect(has(args, '--spec-draft-model')).toBe(false);
  });

  it('passes a catalog-installed sidecar to other draft algorithms', () => {
    const args = buildLlamaCppEngineArgs({
      config: {},
      perModel: { spec: { type: 'draft-dflash' } },
      installedDraftModelPath: '/models/laguna/dflash.gguf',
    });
    expect(argValue(args, '--spec-type')).toBe('draft-dflash');
    expect(argValue(args, '--spec-draft-model')).toBe('/models/laguna/dflash.gguf');
  });

  it('keeps manifest spec.mtp as capability metadata instead of auto-enabling MTP', () => {
    const args = buildLlamaCppEngineArgs({
      config: {},
      perModel: { spec: { mtp: true } },
      ggufHasMtp: true,
    });
    expect(has(args, '--spec-type')).toBe(false);
  });
  it('MTP SAFETY: an explicit request with no GGUF confirmation does not enable', () => {
    expect(
      has(buildLlamaCppEngineArgs({ config: { llamaCppSpecType: 'draft-mtp' } }), '--spec-type'),
    ).toBe(false);
    expect(
      has(
        buildLlamaCppEngineArgs({
          config: { llamaCppSpecType: 'draft-mtp' },
          ggufHasMtp: false,
        }),
        '--spec-type',
      ),
    ).toBe(false);
  });
  it('an explicit global non-MTP spec type wins over MTP capability metadata', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppSpecType: 'ngram-mod' },
      perModel: { spec: { mtp: true } },
      ggufHasMtp: true,
    });
    expect(argValue(args, '--spec-type')).toBe('ngram-mod');
  });
  it('an explicit manifest spec.type wins over MTP capability metadata', () => {
    const args = buildLlamaCppEngineArgs({
      config: {},
      perModel: { spec: { type: 'ngram-mod', mtp: true } },
    });
    expect(argValue(args, '--spec-type')).toBe('ngram-mod');
  });
  it('explicit "none" stays off even with MTP capability metadata', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppSpecType: 'none' },
      perModel: { spec: { mtp: true } },
    });
    expect(has(args, '--spec-type')).toBe(false);
  });
});

describe('buildLlamaCppEngineArgs — extra-args escape hatch', () => {
  it('true → bare flag, false → omitted, scalar → flag + value, keys normalized', () => {
    const args = buildLlamaCppEngineArgs({
      config: {
        llamaCppExtraArgs: {
          metrics: true, // bare
          'no-mmap': false, // omitted
          numa: 'distribute', // value
          '--override-tensor': '\\.ffn_.*_exps\\.=CPU', // already dashed
          'sleep-idle-seconds': 900, // number
        },
      },
    });
    expect(has(args, '--metrics')).toBe(true);
    expect(has(args, '--no-mmap')).toBe(false);
    expect(argValue(args, '--numa')).toBe('distribute');
    expect(argValue(args, '--override-tensor')).toBe('\\.ffn_.*_exps\\.=CPU');
    expect(argValue(args, '--sleep-idle-seconds')).toBe('900');
  });

  it('extra-args are appended last so they override first-class flags', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppNGpuLayers: 10, llamaCppExtraArgs: { 'n-gpu-layers': 0 } },
    });
    // Both present; llama-server honours the last occurrence.
    const first = args.indexOf('--n-gpu-layers');
    const last = args.lastIndexOf('--n-gpu-layers');
    expect(last).toBeGreaterThan(first);
    expect(args[last + 1]).toBe('0');
  });
});

describe('buildLlamaCppEngineArgs — scalar overrides', () => {
  it('threads / batch / ubatch / swa-full', () => {
    const args = buildLlamaCppEngineArgs({
      config: {
        llamaCppThreads: 8,
        llamaCppBatchSize: 4096,
        llamaCppUbatchSize: 256,
        llamaCppSwaFull: true,
      },
    });
    expect(argValue(args, '--threads')).toBe('8');
    expect(argValue(args, '--batch-size')).toBe('4096');
    expect(argValue(args, '--ubatch-size')).toBe('256');
    expect(has(args, '--swa-full')).toBe(true);
  });

  it('passes a catalog-scoped chat-template override', () => {
    const args = buildLlamaCppEngineArgs({
      config: {},
      perModel: { chatTemplate: 'mistral-v3' },
    });

    expect(argValue(args, '--chat-template')).toBe('mistral-v3');
  });
});

describe('buildLlamaCppEngineArgs — reasoning format', () => {
  it('omitted by default', () => {
    const args = buildLlamaCppEngineArgs({ config: {} });
    expect(has(args, '--reasoning-format')).toBe(false);
  });

  it('passes --reasoning-format when the opt-in value is set', () => {
    const args = buildLlamaCppEngineArgs({ config: {}, reasoningFormat: 'none' });
    expect(argValue(args, '--reasoning-format')).toBe('none');
  });

  it('extra-args still win over the reasoning-format opt-in', () => {
    const args = buildLlamaCppEngineArgs({
      config: { llamaCppExtraArgs: { 'reasoning-format': 'auto' } },
      reasoningFormat: 'none',
    });
    const first = args.indexOf('--reasoning-format');
    const last = args.lastIndexOf('--reasoning-format');
    expect(last).toBeGreaterThan(first);
    expect(args[last + 1]).toBe('auto');
  });
});
