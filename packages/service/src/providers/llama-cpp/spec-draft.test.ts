import type { PerModelLlamaCppEngineConfig } from '@bendyline/gezel-inference/internal/providers/llama-cpp/engine-flags';
import {
  drafterCostsContext,
  llamaCppSidecarLoads,
  resolveSpecDraft,
} from '@bendyline/gezel-inference/internal/providers/llama-cpp/spec-draft';
import { describe, expect, it } from 'vitest';

const draftManifest: PerModelLlamaCppEngineConfig = {
  spec: { type: 'draft-simple', draftModelId: 'gemma4-e2b-q4', nMax: 4 },
};

describe('resolveSpecDraft', () => {
  it('rewrites a manifest draft id to the installed GGUF path when present', async () => {
    const res = await resolveSpecDraft({
      perModel: draftManifest,
      resolveDraftPath: async (id) =>
        id === 'gemma4-e2b-q4' ? '/models/gemma4-e2b-q4/weights.gguf' : null,
    });
    expect(res.perModel?.spec?.draftModelId).toBe('/models/gemma4-e2b-q4/weights.gguf');
    expect(res.perModel?.spec?.type).toBe('draft-simple');
    expect(res.perModel?.spec?.nMax).toBe(4);
    expect(res.log?.level).toBe('info');
  });

  it('strips the spec block when a manifest-driven draft is not installed', async () => {
    const res = await resolveSpecDraft({
      perModel: draftManifest,
      resolveDraftPath: async () => null,
    });
    expect(res.perModel?.spec).toBeUndefined();
    expect(res.log?.level).toBe('info');
    expect(res.log?.message).toContain('not installed');
  });

  it('preserves other engine fields when stripping the spec block', async () => {
    const res = await resolveSpecDraft({
      perModel: { ...draftManifest, nGpuLayers: -1, flashAttn: 'on' },
      resolveDraftPath: async () => null,
    });
    expect(res.perModel?.spec).toBeUndefined();
    expect(res.perModel?.nGpuLayers).toBe(-1);
    expect(res.perModel?.flashAttn).toBe('on');
  });

  it("does not resolve when an explicit global draft path is set (operator's own path wins)", async () => {
    let called = false;
    const res = await resolveSpecDraft({
      perModel: draftManifest,
      configDraftModelPath: '/custom/draft.gguf',
      resolveDraftPath: async () => {
        called = true;
        return null;
      },
    });
    expect(called).toBe(false);
    expect(res.perModel).toBe(draftManifest);
    expect(res.log).toBeNull();
  });

  it('resolves a manifest draft even when the spec type comes from global config', async () => {
    const res = await resolveSpecDraft({
      perModel: { spec: { draftModelId: 'gemma4-e2b-q4' } },
      configSpecType: 'draft-simple',
      resolveDraftPath: async () => '/models/e2b/weights.gguf',
    });
    expect(res.perModel?.spec?.draftModelId).toBe('/models/e2b/weights.gguf');
  });

  it('warns (does not strip) when the operator forced the spec type but no draft resolves', async () => {
    const res = await resolveSpecDraft({
      perModel: { spec: { draftModelId: 'gemma4-e2b-q4' } },
      configSpecType: 'draft-simple',
      resolveDraftPath: async () => null,
    });
    expect(res.perModel?.spec?.draftModelId).toBe('gemma4-e2b-q4');
    expect(res.log?.level).toBe('warn');
  });

  it('no-ops for a non-draft-simple spec (e.g. draft-mtp)', async () => {
    const mtp: PerModelLlamaCppEngineConfig = { spec: { type: 'draft-mtp', mtp: true } };
    const res = await resolveSpecDraft({ perModel: mtp, resolveDraftPath: async () => null });
    expect(res.perModel).toBe(mtp);
    expect(res.log).toBeNull();
  });

  it('no-ops when there is no manifest engine config at all', async () => {
    const res = await resolveSpecDraft({ perModel: undefined, resolveDraftPath: async () => null });
    expect(res.perModel).toBeUndefined();
    expect(res.log).toBeNull();
  });

  it('treats a resolver throw as "not installed" and strips the manifest spec', async () => {
    const res = await resolveSpecDraft({
      perModel: draftManifest,
      resolveDraftPath: async () => {
        throw new Error('disk error');
      },
    });
    expect(res.perModel?.spec).toBeUndefined();
    expect(res.log?.level).toBe('info');
  });
});

describe('resolveSpecDraft with a per-backend drafter', () => {
  const perBackend: PerModelLlamaCppEngineConfig = {
    contextSize: 131072,
    spec: {
      mtp: true,
      nMax: 4,
      byBackend: { cuda: { type: 'draft-dflash', nMax: 5, sampling: 'probabilistic' } },
    },
  };
  const noDraft = async () => null;

  it('applies the overlay on its backend once the drafter is on disk', async () => {
    const res = await resolveSpecDraft({
      perModel: perBackend,
      backend: 'cuda',
      installedDraftModelPath: '/models/drafter.gguf',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel).toEqual({
      contextSize: 131072,
      spec: { mtp: true, type: 'draft-dflash', nMax: 5, sampling: 'probabilistic' },
    });
    expect(res.log).toBeNull();
  });

  it('keeps the base spec on a backend the catalog did not turn it on for', async () => {
    const res = await resolveSpecDraft({
      perModel: perBackend,
      backend: 'vulkan',
      installedDraftModelPath: '/models/drafter.gguf',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel?.spec).toEqual({ mtp: true, nMax: 4 });
  });

  // A live Gilde update reaches this: the manifest changes at once, and the
  // drafter arrives only when the person updates the model. llama-server exits
  // fatally for a drafter-less DFlash launch, so this path must keep MTP.
  it('falls back to the base spec when the drafter has not been downloaded', async () => {
    const res = await resolveSpecDraft({
      perModel: perBackend,
      backend: 'cuda',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel).toEqual({ contextSize: 131072, spec: { mtp: true, nMax: 4 } });
    expect(res.log?.level).toBe('info');
    expect(res.log?.message).toContain('not installed');
  });

  it('drops a base DFlash spec with no drafter rather than launching it', async () => {
    const res = await resolveSpecDraft({
      perModel: { contextSize: 65536, spec: { type: 'draft-dflash', nMax: 7 } },
      backend: 'cuda',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel).toEqual({ contextSize: 65536 });
  });

  it('drops an overlay over a drafter-needing base when no drafter is on disk', async () => {
    const res = await resolveSpecDraft({
      perModel: { spec: { type: 'draft-dflash', byBackend: { cuda: { nMax: 4 } } } },
      backend: 'cuda',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel?.spec).toBeUndefined();
  });

  it('does not hand a drafter sampling mode to an algorithm someone forced', async () => {
    const res = await resolveSpecDraft({
      perModel: perBackend,
      backend: 'cuda',
      configSpecType: 'draft-mtp',
      installedDraftModelPath: '/models/drafter.gguf',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel?.spec).toEqual({ mtp: true, nMax: 4 });
  });

  it('keeps the overlay when someone forces the same algorithm', async () => {
    const res = await resolveSpecDraft({
      perModel: perBackend,
      backend: 'cuda',
      configSpecType: 'draft-dflash',
      installedDraftModelPath: '/models/drafter.gguf',
      resolveDraftPath: noDraft,
    });
    expect(res.perModel?.spec?.sampling).toBe('probabilistic');
  });

  it('leaves a forced drafter algorithm to the operator when nothing resolves', async () => {
    const res = await resolveSpecDraft({
      perModel: perBackend,
      backend: 'vulkan',
      configSpecType: 'draft-dflash',
      resolveDraftPath: noDraft,
    });
    expect(res.log?.level).toBe('warn');
  });

  it('uses the base spec with no known backend', async () => {
    const res = await resolveSpecDraft({ perModel: perBackend, resolveDraftPath: noDraft });
    expect(res.perModel?.spec).toEqual({ mtp: true, nMax: 4 });
  });
});

describe('llamaCppSidecarLoads', () => {
  it('loads for an algorithm that needs a separate GGUF', () => {
    expect(
      llamaCppSidecarLoads({ specType: 'draft-dflash', targetHasMtp: true, perBackend: true }),
    ).toBe(true);
  });

  it('loads a separate MTP assistant for a target with no head of its own', () => {
    for (const specType of [undefined, 'draft-mtp']) {
      expect(llamaCppSidecarLoads({ specType, targetHasMtp: false, perBackend: false })).toBe(true);
    }
  });

  // The 27B after a move from CUDA to Vulkan: its DFlash drafter is still on
  // disk, and `--spec-draft-model` would hand it to the target's own MTP.
  it('never hands a DFlash drafter to a target with its own head', () => {
    for (const specType of [undefined, 'draft-mtp']) {
      expect(llamaCppSidecarLoads({ specType, targetHasMtp: true, perBackend: false })).toBe(false);
    }
  });

  it('leaves a per-backend drafter out where the catalog did not turn it on', () => {
    expect(
      llamaCppSidecarLoads({ specType: undefined, targetHasMtp: false, perBackend: true }),
    ).toBe(false);
  });

  it('loads nothing when speculation is off or takes no model', () => {
    for (const specType of ['none', 'ngram-mod']) {
      expect(llamaCppSidecarLoads({ specType, targetHasMtp: false, perBackend: false })).toBe(
        false,
      );
    }
  });
});

describe('drafterCostsContext', () => {
  const f16 = { kvCacheType: 'f16' };

  it('keeps a drafter that leaves the KV plan as it was', () => {
    expect(drafterCostsContext(f16, f16, true)).toBe(false);
  });

  it('drops one that no longer fits at all', () => {
    expect(drafterCostsContext(f16, f16, false)).toBe(true);
  });

  it('drops one that would coarsen the KV cache', () => {
    expect(drafterCostsContext({ kvCacheType: 'q8_0' }, f16, true)).toBe(true);
  });

  it('drops one that would buy f16 by shortening the window', () => {
    expect(drafterCostsContext({ kvCacheType: 'f16', ctxCapTokens: 65_536 }, f16, true)).toBe(true);
  });
});
