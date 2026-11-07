import { describe, expect, it } from 'vitest';
import {
  llamaCppDraftModelApplies,
  llamaCppDraftResidentBytes,
  llamaCppSpecForBackend,
  llamaCppSpecNeedsDraftModel,
} from './llama-cpp-spec.js';
import {
  LLAMA_CPP_DRAFT_CONTEXT_BYTES,
  LLAMA_CPP_WEIGHTS_MULTIPLIER,
  estimateLlamaCppResidentBytes,
} from './model-fit.js';
import { ChatModelLlamaCppSourceSchema } from './schemas/chat-model-sources.js';
import { LlamaCppEngineConfigSchema } from './schemas/model-tuning.js';

describe('llamaCppSpecForBackend', () => {
  const spec = {
    mtp: true,
    nMax: 4,
    byBackend: { cuda: { type: 'draft-dflash', nMax: 5, sampling: 'greedy' as const } },
  };

  it('lays the overlay over the base for a tested backend', () => {
    expect(llamaCppSpecForBackend(spec, 'cuda')).toEqual({
      mtp: true,
      type: 'draft-dflash',
      nMax: 5,
      sampling: 'greedy',
    });
  });

  it('keeps the base block on every other backend', () => {
    for (const backend of ['vulkan', 'rocm', 'metal', 'cpu']) {
      expect(llamaCppSpecForBackend(spec, backend)).toEqual({ mtp: true, nMax: 4 });
    }
  });

  it('treats an unknown backend as untested', () => {
    expect(llamaCppSpecForBackend(spec, undefined)).toEqual({ mtp: true, nMax: 4 });
    expect(llamaCppSpecForBackend(spec, null)).toEqual({ mtp: true, nMax: 4 });
  });

  it('never lets an unset overlay field erase the base', () => {
    const partial = { nMax: 4, byBackend: { cuda: { type: 'draft-dflash', nMax: undefined } } };
    expect(llamaCppSpecForBackend(partial, 'cuda')).toEqual({ type: 'draft-dflash', nMax: 4 });
  });

  it('passes a missing block through', () => {
    expect(llamaCppSpecForBackend(undefined, 'cuda')).toBeUndefined();
  });
});

describe('llamaCppSpecNeedsDraftModel', () => {
  it('names the algorithms that load a separate GGUF', () => {
    for (const type of ['draft-simple', 'draft-dflash', 'draft-eagle3']) {
      expect(llamaCppSpecNeedsDraftModel(type)).toBe(true);
    }
  });

  it('excludes MTP, whose head can live inside the target', () => {
    for (const type of ['draft-mtp', 'none', 'ngram-mod', undefined, null]) {
      expect(llamaCppSpecNeedsDraftModel(type)).toBe(false);
    }
  });
});

describe('llamaCppDraftModelApplies', () => {
  it('applies an unrestricted drafter everywhere, including an unknown backend', () => {
    expect(llamaCppDraftModelApplies({}, 'vulkan')).toBe(true);
    expect(llamaCppDraftModelApplies({}, undefined)).toBe(true);
  });

  it('limits a restricted drafter to the backends it names', () => {
    const draft = { backends: ['cuda'] };
    expect(llamaCppDraftModelApplies(draft, 'cuda')).toBe(true);
    expect(llamaCppDraftModelApplies(draft, 'vulkan')).toBe(false);
    expect(llamaCppDraftModelApplies(draft, undefined)).toBe(false);
  });

  it('is false with no drafter at all', () => {
    expect(llamaCppDraftModelApplies(undefined, 'cuda')).toBe(false);
    expect(llamaCppDraftModelApplies(null, 'cuda')).toBe(false);
  });
});

describe('llamaCppDraftResidentBytes', () => {
  const draft = { filename: 'sub/drafter-q4.gguf', residentBytes: 2_600_000_000 };

  it('reads the measured cost for the drafter that is installed', () => {
    expect(llamaCppDraftResidentBytes(draft, '/models/x/drafter-q4.gguf')).toBe(2_600_000_000);
    expect(llamaCppDraftResidentBytes(draft, 'C:\\models\\x\\drafter-q4.gguf')).toBe(2_600_000_000);
  });

  it('ignores a figure for a drafter the install has not fetched', () => {
    expect(llamaCppDraftResidentBytes(draft, '/models/x/drafter-q8.gguf')).toBeUndefined();
  });

  it('is undefined with nothing measured or nothing installed', () => {
    expect(llamaCppDraftResidentBytes({ filename: 'd.gguf' }, '/m/d.gguf')).toBeUndefined();
    expect(llamaCppDraftResidentBytes(draft, undefined)).toBeUndefined();
    expect(llamaCppDraftResidentBytes(undefined, '/m/d.gguf')).toBeUndefined();
  });
});

describe('drafter pricing', () => {
  const without = estimateLlamaCppResidentBytes(16e9);

  it('estimates an unmeasured drafter from its file', () => {
    expect(estimateLlamaCppResidentBytes(16e9, { draftBytes: 1e9 }) - without).toBe(
      Math.round(1e9 * LLAMA_CPP_WEIGHTS_MULTIPLIER) + LLAMA_CPP_DRAFT_CONTEXT_BYTES,
    );
  });

  it('uses a measured cost in place of the estimate', () => {
    expect(
      estimateLlamaCppResidentBytes(16e9, { draftBytes: 1e9, draftResidentBytes: 2.5e9 }) - without,
    ).toBe(2.5e9);
  });

  it('charges nothing without a drafter, whatever was measured', () => {
    expect(estimateLlamaCppResidentBytes(16e9, { draftResidentBytes: 2.5e9 })).toBe(without);
  });
});

describe('schema round trip', () => {
  it('keeps a per-backend spec with sampling', () => {
    const parsed = LlamaCppEngineConfigSchema.parse({
      spec: {
        mtp: true,
        nMax: 4,
        byBackend: { cuda: { type: 'draft-dflash', nMax: 4, sampling: 'probabilistic' } },
      },
    });
    expect(parsed.spec?.byBackend?.cuda).toEqual({
      type: 'draft-dflash',
      nMax: 4,
      sampling: 'probabilistic',
    });
  });

  it('keeps a drafter limited to some backends', () => {
    const parsed = ChatModelLlamaCppSourceSchema.parse({
      huggingfaceRepo: 'owner/model',
      filename: 'model.gguf',
      sha256: 'a'.repeat(64),
      quantization: 'Q4_K_M',
      approxSizeBytes: 1024,
      draftModel: {
        filename: 'drafter.gguf',
        sha256: 'b'.repeat(64),
        sizeBytes: 512,
        backends: ['cuda'],
        residentBytes: 2048,
      },
    });
    expect(parsed.draftModel?.backends).toEqual(['cuda']);
    expect(parsed.draftModel?.residentBytes).toBe(2048);
  });
});
