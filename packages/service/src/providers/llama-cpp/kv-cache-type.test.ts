import { describe, expect, it } from 'vitest';
import { resolveLlamaCppKvCacheType } from './kv-cache-type.js';

describe('resolveLlamaCppKvCacheType', () => {
  it('defaults the Gemma family to f16 (q8_0 corrupts its KV cache)', () => {
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma4' })).toBe('f16');
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma3' })).toBe('f16');
    expect(resolveLlamaCppKvCacheType({ architecture: 'Gemma' })).toBe('f16');
  });

  it('catches Gemma via the model id when GGUF architecture is missing', () => {
    expect(resolveLlamaCppKvCacheType({ modelId: 'gemma4-12b-q4' })).toBe('f16');
  });

  it('defaults other families to q8_0', () => {
    expect(resolveLlamaCppKvCacheType({ architecture: 'qwen2' })).toBe('q8_0');
    expect(resolveLlamaCppKvCacheType({ architecture: 'llama' })).toBe('q8_0');
    expect(resolveLlamaCppKvCacheType({})).toBe('q8_0');
  });

  it('lets an explicit operator override win over the family default', () => {
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma4', override: 'q8_0' })).toBe('q8_0');
    expect(resolveLlamaCppKvCacheType({ architecture: 'gemma4', override: 'q4_0' })).toBe('q4_0');
    expect(resolveLlamaCppKvCacheType({ architecture: 'qwen2', override: 'f16' })).toBe('f16');
  });
});
