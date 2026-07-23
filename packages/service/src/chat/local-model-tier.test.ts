import { describe, expect, it } from 'vitest';
import { classifyLocalModelTier, parseBillionsFromModelId } from './manager.js';

describe('parseBillionsFromModelId', () => {
  it('parses ollama-style ids (`<model>:<size>b`)', () => {
    expect(parseBillionsFromModelId('llama3.1:8b')).toBe(8);
    expect(parseBillionsFromModelId('qwen2.5:7b')).toBe(7);
    expect(parseBillionsFromModelId('gemma2:27b')).toBe(27);
  });

  it('parses ollama "effective parameters" prefix (`:e4b`) and doubles to total params', () => {
    // Gemma 3n's `e<N>b` advertises N billion *effective active* params,
    // but MatFormer loads the full model (~2N billion total) into memory.
    // Doubling here lets the tier classifier see the real model size.
    expect(parseBillionsFromModelId('gemma4:e4b')).toBe(8);
    expect(parseBillionsFromModelId('gemma4:e2b')).toBe(4);
  });

  it('parses mlx-style ids (`gemma4-e4b-mlx`) with the same MatFormer doubling', () => {
    expect(parseBillionsFromModelId('gemma4-e4b-mlx')).toBe(8);
    expect(parseBillionsFromModelId('gemma4-e2b-mlx')).toBe(4);
  });

  it('parses hf-style slash-separated ids', () => {
    expect(parseBillionsFromModelId('meta-llama/Llama-3-70B')).toBe(70);
    expect(parseBillionsFromModelId('mistralai/Mistral-7B-v0.1')).toBe(7);
  });

  it('parses underscore-separated ids', () => {
    expect(parseBillionsFromModelId('model_8b_q4')).toBe(8);
  });

  it('handles fractional sizes', () => {
    expect(parseBillionsFromModelId('llama3.1:0.5b')).toBe(0.5);
    expect(parseBillionsFromModelId('gemma:1.5b')).toBe(1.5);
  });

  it('returns undefined for ids without a size suffix', () => {
    expect(parseBillionsFromModelId('gpt-4o')).toBeUndefined();
    expect(parseBillionsFromModelId('claude-opus-4-7')).toBeUndefined();
    expect(parseBillionsFromModelId('mock-fast')).toBeUndefined();
  });

  it('returns undefined for empty / undefined input', () => {
    expect(parseBillionsFromModelId(undefined)).toBeUndefined();
    expect(parseBillionsFromModelId('')).toBeUndefined();
  });
});

describe('classifyLocalModelTier', () => {
  it('returns "cloud" for cloud providers regardless of model id', () => {
    // Cloud providers get their own bucket (was 'large' historically;
    // separated so cloud-specific behaviors don't conflate with a
    // 70B local). Includes cloud "small" SKUs like gpt-4o-mini and
    // Haiku — they still classify as `cloud`, since the relevant
    // dimension is the runtime, not parameter count.
    expect(classifyLocalModelTier({ providerName: 'copilot', modelId: 'gpt-4o' })).toBe('cloud');
    expect(classifyLocalModelTier({ providerName: 'openai', modelId: undefined })).toBe('cloud');
    expect(classifyLocalModelTier({ providerName: 'anthropic', modelId: 'claude-haiku' })).toBe(
      'cloud',
    );
  });

  it('returns "tiny" for sub-5B local models', () => {
    // Gemma E2B's MatFormer-doubled total (~4B) still lands in tiny.
    expect(classifyLocalModelTier({ providerName: 'mlx', modelId: 'gemma4-e2b-mlx' })).toBe('tiny');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'gemma4:e2b' })).toBe('tiny');
  });

  it('returns "small" for 5–11B local models', () => {
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'llama3.1:8b' })).toBe(
      'small',
    );
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'mistral:7b' })).toBe('small');
    expect(classifyLocalModelTier({ providerName: 'llama-cpp', modelId: 'qwen2.5:7b' })).toBe(
      'small',
    );
    // Gemma E4B: MatFormer-doubled total (~8B) lifts it from tiny → small.
    // Behaviorally it's a small model, not a tiny one — the "E4B" label
    // describes active-params, not the actual on-disk size.
    expect(classifyLocalModelTier({ providerName: 'mlx', modelId: 'gemma4-e4b-mlx' })).toBe(
      'small',
    );
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'gemma4:e4b' })).toBe('small');
  });

  it('returns "medium" for 12-44B local models', () => {
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'mistral:13b' })).toBe(
      'medium',
    );
    expect(classifyLocalModelTier({ providerName: 'mlx', modelId: 'qwen3.6-27b-mlx' })).toBe(
      'medium',
    );
    expect(classifyLocalModelTier({ providerName: 'mlx', modelId: 'gemma4-31b-mlx' })).toBe(
      'medium',
    );
    expect(classifyLocalModelTier({ providerName: 'mlx', modelId: 'gpt-oss-20b-mlx' })).toBe(
      'medium',
    );
  });

  it('returns "large" for ≥45B local models (top end of local enthusiast tier)', () => {
    // Note: cloud is a separate bucket, so a 70B *local* is `large`
    // while a frontier cloud model is `cloud`.
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'llama3.1:70b' })).toBe(
      'large',
    );
    expect(
      classifyLocalModelTier({ providerName: 'llama-cpp', modelId: 'meta-llama/Llama-3-70B' }),
    ).toBe('large');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:405b' })).toBe('large');
  });

  it('returns "tiny" for unknown-size local models (conservative default)', () => {
    // Better to apply the cookbook to a model whose size we can't
    // parse than to skip it and let a small model regress on tools.
    expect(classifyLocalModelTier({ providerName: 'mlx', modelId: 'unknown-model' })).toBe('tiny');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: undefined })).toBe('tiny');
  });

  it('treats the 5B / 12B / 45B boundaries cleanly', () => {
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:4.9b' })).toBe('tiny');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:5b' })).toBe('small');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:11.9b' })).toBe('small');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:12b' })).toBe('medium');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:44.9b' })).toBe('medium');
    expect(classifyLocalModelTier({ providerName: 'ollama', modelId: 'm:45b' })).toBe('large');
  });
});
