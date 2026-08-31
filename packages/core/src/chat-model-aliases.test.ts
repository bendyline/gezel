import { describe, expect, it } from 'vitest';
import {
  hasQuantSuffix,
  normalizeChatModelCatalogId,
  quantSuffixForLabel,
  quantSuffixedModelId,
} from './chat-model-aliases.js';

describe('normalizeChatModelCatalogId', () => {
  it('maps legacy downloaded-cache ids to current catalog ids', () => {
    expect(normalizeChatModelCatalogId('qwen3.5-9b')).toBe('qwen3.5-9b-q4');
    expect(normalizeChatModelCatalogId('qwen3.5-122b-a10b')).toBe('qwen3.5-122b-a10b-q4');
    expect(normalizeChatModelCatalogId('gpt-oss')).toBe('gpt-oss-20b-q4');
    expect(normalizeChatModelCatalogId('deepseek-r1')).toBe('deepseek-r1-8b-q4');
    expect(normalizeChatModelCatalogId('nemotron3.5-lightning-30b')).toBe(
      'nemotron3.5-lightning-30b-q4',
    );
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

describe('hasQuantSuffix', () => {
  it('recognizes every shape a current catalog id ends in', () => {
    for (const id of [
      'qwen3.5-9b-q4',
      'gemma4-12b-q8',
      'btl4-compact-iq2',
      'qwen3.8-27b-iq1-s',
      'deepseek-v4-flash-284b-q2q4',
      'deepseek-v4-flash-284b-mxfp4',
      'laguna-s-2.1-118b-q6',
    ]) {
      expect(hasQuantSuffix(id)).toBe(true);
    }
  });

  // A parameter-count tail is the near-miss that matters: `-9b` and `-e4b`
  // both end in a digit-plus-letter and must not read as a width.
  it('does not mistake a parameter-count tail for a quantization', () => {
    for (const id of ['mistral', 'qwen3.5-9b', 'gemma4-e4b', 'deepseek-r1', 'gpt-oss']) {
      expect(hasQuantSuffix(id)).toBe(false);
    }
  });
});

describe('quantSuffixForLabel', () => {
  it('reads the width out of either engine label dialect', () => {
    expect(quantSuffixForLabel('Q4_K_M')).toBe('q4');
    expect(quantSuffixForLabel('Q8_0')).toBe('q8');
    expect(quantSuffixForLabel('UD-Q2_K_XL')).toBe('q2');
    expect(quantSuffixForLabel('4bit')).toBe('q4');
    expect(quantSuffixForLabel('MXFP4')).toBe('mxfp4');
    expect(quantSuffixForLabel('bf16')).toBe('bf16');
  });

  it('reads IQ labels as IQ, not as the plain width they contain', () => {
    expect(quantSuffixForLabel('IQ2_XXS')).toBe('iq2');
    expect(quantSuffixForLabel('UD-IQ1_S')).toBe('iq1');
  });

  it('returns null for an unusable label', () => {
    expect(quantSuffixForLabel(undefined)).toBeNull();
    expect(quantSuffixForLabel('K-Quant-17GB')).toBeNull();
  });
});

describe('quantSuffixedModelId', () => {
  it('prefers the aliased catalog id, which both names the width and re-links', () => {
    expect(quantSuffixedModelId('mistral', 'Q4_K_M')).toBe('mistral-7b-q4');
    expect(quantSuffixedModelId('qwen3.5-9b', 'Q4_K_M')).toBe('qwen3.5-9b-q4');
  });

  // The catalog only ever published E4B at Q4, so there is no id to re-link
  // to — the width still has to make it into the name.
  it('derives a suffix from the manifest when no catalog id exists', () => {
    expect(quantSuffixedModelId('gemma4-e4b', 'Q8_0')).toBe('gemma4-e4b-q8');
  });

  it('leaves an already-suffixed id alone', () => {
    expect(quantSuffixedModelId('gemma4-e4b-q4', 'UD-Q4_K_XL')).toBeNull();
  });

  it('gives up rather than guess when the label names no width', () => {
    expect(quantSuffixedModelId('muse-glimmer', 'K-Quant-17GB')).toBeNull();
  });
});
