import { describe, expect, it } from 'vitest';
import { MODEL_IMG2IMG_SUPPORT, resolveImg2ImgSupport } from './img2img-support.js';

describe('resolveImg2ImgSupport', () => {
  it('explicit capability wins over the assessment map', () => {
    expect(MODEL_IMG2IMG_SUPPORT.get('flux-2-klein-4b-q4')).toBe(false);
    expect(resolveImg2ImgSupport({ modelId: 'flux-2-klein-4b-q4', explicit: true }).supported).toBe(
      true,
    );
    expect(MODEL_IMG2IMG_SUPPORT.get('sd-1.5')).toBe(true);
    const denied = resolveImg2ImgSupport({ modelId: 'sd-1.5', explicit: false });
    expect(denied.supported).toBe(false);
    expect(denied.reason).toMatch(/sd-1\.5/);
  });

  it('assessment map covers the shipped catalog models', () => {
    for (const id of ['sd-1.5', 'sdxl-base-1.0', 'sdxl-turbo', 'flux-1-schnell-q4']) {
      expect(resolveImg2ImgSupport({ modelId: id }).supported).toBe(true);
    }
    for (const id of ['flux-2-klein-4b-q4', 'krea-2-turbo-q4', 'krea-2-turbo-q8']) {
      const verdict = resolveImg2ImgSupport({ modelId: id });
      expect(verdict.supported).toBe(false);
      expect(verdict.reason).toContain(id);
    }
  });

  it('falls back to the weights-kind default for unassessed models', () => {
    expect(
      resolveImg2ImgSupport({ modelId: 'somebody-elses-sd', weightsKind: 'checkpoint' }).supported,
    ).toBe(true);
    const unverified = resolveImg2ImgSupport({
      modelId: 'somebody-elses-flow-model',
      weightsKind: 'diffusion-model',
    });
    expect(unverified.supported).toBe(false);
    expect(unverified.reason).toMatch(/not been verified/);
  });

  it('treats legacy installs with no metadata as supported', () => {
    // Pre-capability installs are all SD-era checkpoints.
    expect(resolveImg2ImgSupport({ modelId: 'ancient-install' }).supported).toBe(true);
    expect(resolveImg2ImgSupport({}).supported).toBe(true);
  });
});
