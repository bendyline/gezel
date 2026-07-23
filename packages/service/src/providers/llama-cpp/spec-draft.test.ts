import { describe, expect, it } from 'vitest';
import type { PerModelLlamaCppEngineConfig } from './engine-flags.js';
import { resolveSpecDraft } from './spec-draft.js';

const draftManifest: PerModelLlamaCppEngineConfig = {
  spec: { type: 'draft-simple', draftModelId: 'gemma4-e2b-q8', nMax: 4 },
};

describe('resolveSpecDraft', () => {
  it('rewrites a manifest draft id to the installed GGUF path when present', async () => {
    const res = await resolveSpecDraft({
      perModel: draftManifest,
      resolveDraftPath: async (id) =>
        id === 'gemma4-e2b-q8' ? '/models/gemma4-e2b-q8/weights.gguf' : null,
    });
    expect(res.perModel?.spec?.draftModelId).toBe('/models/gemma4-e2b-q8/weights.gguf');
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
      perModel: { spec: { draftModelId: 'gemma4-e2b-q8' } },
      configSpecType: 'draft-simple',
      resolveDraftPath: async () => '/models/e2b/weights.gguf',
    });
    expect(res.perModel?.spec?.draftModelId).toBe('/models/e2b/weights.gguf');
  });

  it('warns (does not strip) when the operator forced the spec type but no draft resolves', async () => {
    const res = await resolveSpecDraft({
      perModel: { spec: { draftModelId: 'gemma4-e2b-q8' } },
      configSpecType: 'draft-simple',
      resolveDraftPath: async () => null,
    });
    expect(res.perModel?.spec?.draftModelId).toBe('gemma4-e2b-q8');
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
