import { describe, expect, it } from 'vitest';
import { classifyEvalModelTier, modelBillionsForEval } from './model-tier.ts';

describe('modelBillionsForEval', () => {
  it('prefers catalog parameterSize and falls back to the model-id tag', () => {
    expect(modelBillionsForEval('qwen3.5-122b-a10b-q4')).toBe(122);
    expect(modelBillionsForEval('imaginary-119.5b-q4')).toBe(119.5);
    expect(modelBillionsForEval('imaginary-no-size-here')).toBeUndefined();
  });
});

describe('classifyEvalModelTier', () => {
  it('classifies real local models by their catalog parameterSize', () => {
    // Manifests carry parameterSize: 2.3B / 8B / 27B / 120B respectively.
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'gemma4-e2b-q8' })).toBe('tiny');
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'gemma4-e4b-q8' })).toBe('small');
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' })).toBe(
      'medium',
    );
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'nemotron3-super-120b-q4' })).toBe(
      'large',
    );
  });

  it('treats every non-local engine as cloud', () => {
    expect(classifyEvalModelTier({ engine: 'codex-cli', modelId: 'gpt-5.5' })).toBe('cloud');
    expect(classifyEvalModelTier({ engine: 'anthropic-cli', modelId: 'claude-opus-4-8' })).toBe(
      'cloud',
    );
    expect(classifyEvalModelTier({ engine: 'openai', modelId: 'gpt-5.5' })).toBe('cloud');
  });

  it('falls back to the model-id tag when no manifest is present', () => {
    // No catalog manifest for these synthetic ids → tag parse.
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'imaginary-7b-q4' })).toBe(
      'small',
    );
    // Gemma "effective params" ×2 rule: e4b → 8B → small.
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'imaginary-e4b-mlx' })).toBe(
      'small',
    );
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'imaginary-70b' })).toBe('large');
  });

  it('classifies an unknown-size local model conservatively as tiny', () => {
    expect(classifyEvalModelTier({ engine: 'llama-cpp', modelId: 'imaginary-no-size-here' })).toBe(
      'tiny',
    );
  });
});
