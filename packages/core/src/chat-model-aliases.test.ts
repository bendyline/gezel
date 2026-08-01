import { describe, expect, it } from 'vitest';
import { normalizeChatModelCatalogId } from './chat-model-aliases.js';

describe('normalizeChatModelCatalogId', () => {
  it('maps legacy downloaded-cache ids to current catalog ids', () => {
    expect(normalizeChatModelCatalogId('qwen3.5-9b')).toBe('qwen3.5-9b-q4');
    expect(normalizeChatModelCatalogId('qwen3.5-122b-a10b')).toBe('qwen3.5-122b-a10b-q4');
    expect(normalizeChatModelCatalogId('gpt-oss')).toBe('gpt-oss-20b-q4');
    expect(normalizeChatModelCatalogId('deepseek-r1')).toBe('deepseek-r1-8b-q4');
  });

  // `gemma4-e2b`/`gemma4-e4b` named the Q8_0 weights the catalog shipped
  // before the QAT-Q4 swap. Mapping them onto the `-q4` ids would apply Q4
  // tuning to a different set of weights, so the alias was dropped rather
  // than retargeted.
  it('does not map the pre-QAT gemma4 E-series short ids onto the q4 entries', () => {
    expect(normalizeChatModelCatalogId('gemma4-e2b')).toBe('gemma4-e2b');
    expect(normalizeChatModelCatalogId('gemma4-e4b')).toBe('gemma4-e4b');
  });

  it('leaves current and unknown ids unchanged', () => {
    expect(normalizeChatModelCatalogId('qwen3.5-9b-q4')).toBe('qwen3.5-9b-q4');
    expect(normalizeChatModelCatalogId('custom-local-model')).toBe('custom-local-model');
    expect(normalizeChatModelCatalogId(undefined)).toBeUndefined();
  });
});
