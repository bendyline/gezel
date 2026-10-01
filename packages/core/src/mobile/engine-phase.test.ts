import { describe, expect, it } from 'vitest';
import { mobileEnginePhaseDetail } from './engine-phase.js';

describe('mobile engine phase wording', () => {
  it('names model loading with and without a fraction', () => {
    expect(mobileEnginePhaseDetail({ phase: 'loading_model' })).toBe('Loading model into memory');
    expect(mobileEnginePhaseDetail({ phase: 'loading_model', progress: 0.47 })).toBe(
      'Loading model weights (47%)',
    );
  });

  it('describes prompt processing the way the desktop engines do', () => {
    expect(
      mobileEnginePhaseDetail({ phase: 'prefill', promptTokens: 2180, processedTokens: 1024 }),
    ).toBe('Processing prompt (47% · 1,024 / 2,180 tokens)');
    expect(mobileEnginePhaseDetail({ phase: 'prefill', progress: 0.5 })).toBe(
      'Processing prompt (50%)',
    );
    expect(mobileEnginePhaseDetail({ phase: 'prefill' })).toBeUndefined();
    expect(mobileEnginePhaseDetail({ phase: 'generating' })).toBeUndefined();
  });
});
