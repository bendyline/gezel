import { ProviderNameSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  applyRecognitionPolicy,
  mmprojBudgetBytes,
  nativeVisionEnabledFor,
  resolveImageStrategy,
  resolveVisionCapability,
} from './vision-capability.js';

const AVAILABLE = { mode: 'auto', recognitionAvailable: true } as const;
const NOTHING_INSTALLED = { mode: 'auto', recognitionAvailable: false } as const;

describe('resolveVisionCapability', () => {
  // The anti-rot guard. Adding a provider to ProviderNameSchema without
  // classifying it in VISION_NATIVE is a typecheck failure; this catches the
  // subtler case where someone classifies it but the resolver throws or
  // returns nonsense for that arm.
  it('answers for every provider in ProviderNameSchema', () => {
    for (const provider of ProviderNameSchema.options) {
      const result = resolveVisionCapability({ provider });
      expect(typeof result.native, provider).toBe('boolean');
      expect(result.reason, provider).toBeTruthy();
    }
  });

  it('treats the hosted providers as vision-capable', () => {
    for (const provider of ['copilot', 'openai', 'anthropic'] as const) {
      expect(resolveVisionCapability({ provider }).native, provider).toBe(true);
    }
  });

  // ds4 is the case that motivated the feature. It must be false on the
  // strength of the provider alone — no config, no installed-model lookup.
  it('reports ds4 as blind regardless of what else is set', () => {
    const result = resolveVisionCapability({
      provider: 'ds4',
      modelId: 'deepseek-v4-flash-284b-q2',
      mmprojPath: '/somehow/a/projector.gguf',
      nativeVisionEnabled: true,
    });
    expect(result.native).toBe(false);
    expect(result.reason).toContain('ds4');
  });

  it('reports the CLI-backed providers as blind', () => {
    expect(resolveVisionCapability({ provider: 'anthropic-cli' }).native).toBe(false);
    expect(resolveVisionCapability({ provider: 'codex-cli' }).native).toBe(false);
  });

  it('requires a projector for llama-cpp, not a catalog tag', () => {
    // qwen3.5-4b-q4 ships tagged "vision"/"multimodal" but installs text-only.
    expect(
      resolveVisionCapability({ provider: 'llama-cpp', modelId: 'qwen3.5-4b-q4' }).native,
    ).toBe(false);
  });

  it('requires the projector AND the opt-in to be considered native', () => {
    const withProjector = {
      provider: 'llama-cpp',
      modelId: 'gemma4-12b-q4',
      mmprojPath: '/models/mmproj-BF16.gguf',
    } as const;
    expect(resolveVisionCapability(withProjector).native).toBe(false);
    expect(resolveVisionCapability({ ...withProjector, nativeVisionEnabled: true }).native).toBe(
      true,
    );
  });

  it('reports mlx as blind even with a projector on disk', () => {
    expect(
      resolveVisionCapability({
        provider: 'mlx',
        modelId: 'qwen3.5-4b-q4',
        mmprojPath: '/models/mmproj.gguf',
        nativeVisionEnabled: true,
      }).native,
    ).toBe(false);
  });
});

describe('applyRecognitionPolicy', () => {
  const blind = { native: false, reason: 'ds4 cannot accept images' };
  const sighted = { native: true, reason: 'copilot accepts images' };

  it('preprocesses when the model is blind and a reader is installed', () => {
    expect(applyRecognitionPolicy(blind, AVAILABLE).verdict).toBe('preprocess');
  });

  it('falls back to unavailable when no reader is installed', () => {
    const plan = applyRecognitionPolicy(blind, NOTHING_INSTALLED);
    expect(plan.verdict).toBe('unavailable');
    expect(plan.reason).toContain('no local image reader');
  });

  it('ships pixels natively when the model can see', () => {
    expect(applyRecognitionPolicy(sighted, AVAILABLE).verdict).toBe('native');
  });

  // The cost lever: cheaper than frontier vision tokens, and no bytes leave
  // the machine.
  it('lets an explicit always override native capability', () => {
    const plan = applyRecognitionPolicy(sighted, { mode: 'always', recognitionAvailable: true });
    expect(plan.verdict).toBe('preprocess');
    expect(plan.reason).toContain('always');
  });

  it('ignores always when there is no reader to do the work', () => {
    expect(
      applyRecognitionPolicy(sighted, { mode: 'always', recognitionAvailable: false }).verdict,
    ).toBe('native');
  });

  it('never preprocesses when the user turned scanning off', () => {
    const plan = applyRecognitionPolicy(blind, { mode: 'off', recognitionAvailable: true });
    expect(plan.verdict).toBe('unavailable');
  });

  it('leaves a sighted model native even when scanning is off', () => {
    expect(
      applyRecognitionPolicy(sighted, { mode: 'off', recognitionAvailable: true }).verdict,
    ).toBe('native');
  });
});

describe('resolveImageStrategy', () => {
  it('produces a verdict for every provider under every policy mode', () => {
    for (const provider of ProviderNameSchema.options) {
      for (const mode of ['auto', 'always', 'off'] as const) {
        for (const recognitionAvailable of [true, false]) {
          const plan = resolveImageStrategy({ provider }, { mode, recognitionAvailable });
          expect(['native', 'preprocess', 'unavailable']).toContain(plan.verdict);
          // A `preprocess` verdict with nothing installed would strand the turn.
          if (plan.verdict === 'preprocess') expect(recognitionAvailable).toBe(true);
        }
      }
    }
  });

  it('routes a pasted screenshot at ds4 through local recognition', () => {
    const plan = resolveImageStrategy(
      { provider: 'ds4', modelId: 'deepseek-v4-flash-284b-q2' },
      AVAILABLE,
    );
    expect(plan.verdict).toBe('preprocess');
  });
});

describe('nativeVisionEnabledFor / mmprojBudgetBytes', () => {
  it('defaults ON when the model has no explicit entry', () => {
    expect(nativeVisionEnabledFor(undefined, 'qwen3.8-27b-q2')).toBe(true);
    expect(nativeVisionEnabledFor({}, 'qwen3.8-27b-q2')).toBe(true);
    expect(nativeVisionEnabledFor({ other: false }, 'qwen3.8-27b-q2')).toBe(true);
  });

  it('honors an explicit opt-out, and only for that model', () => {
    const cfg = { 'qwen3.8-27b-q2': false, 'gemma4-e4b-q4': true };
    expect(nativeVisionEnabledFor(cfg, 'qwen3.8-27b-q2')).toBe(false);
    expect(nativeVisionEnabledFor(cfg, 'gemma4-e4b-q4')).toBe(true);
  });

  it('is false without a model id — there is nothing to enable', () => {
    expect(nativeVisionEnabledFor({}, undefined)).toBe(false);
  });

  it('drops the projector from the memory budget when vision is off', () => {
    // The point of the opt-out: reserving for a file the launch will not
    // load silently shrinks the context window the user traded vision for.
    expect(mmprojBudgetBytes(927_607_488, true)).toBe(927_607_488);
    expect(mmprojBudgetBytes(927_607_488, false)).toBe(0);
    expect(mmprojBudgetBytes(undefined, true)).toBe(0);
  });
});
