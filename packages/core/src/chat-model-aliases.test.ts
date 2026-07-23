import { describe, expect, it } from 'vitest';
import { normalizeChatModelCatalogId } from './chat-model-aliases.js';

describe('normalizeChatModelCatalogId', () => {
  it('maps legacy downloaded-cache ids to current catalog ids', () => {
    expect(normalizeChatModelCatalogId('qwen3.5-9b')).toBe('qwen3.5-9b-q4');
    expect(normalizeChatModelCatalogId('qwen3.5-122b-a10b')).toBe('qwen3.5-122b-a10b-q4');
    expect(normalizeChatModelCatalogId('gemma4-e2b')).toBe('gemma4-e2b-q8');
    expect(normalizeChatModelCatalogId('gpt-oss')).toBe('gpt-oss-20b-q4');
    expect(normalizeChatModelCatalogId('deepseek-r1')).toBe('deepseek-r1-8b-q4');
  });

  it('leaves current and unknown ids unchanged', () => {
    expect(normalizeChatModelCatalogId('qwen3.5-9b-q4')).toBe('qwen3.5-9b-q4');
    expect(normalizeChatModelCatalogId('custom-local-model')).toBe('custom-local-model');
    expect(normalizeChatModelCatalogId(undefined)).toBeUndefined();
  });
});
