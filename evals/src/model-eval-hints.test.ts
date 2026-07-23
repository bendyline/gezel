import { describe, expect, it } from 'vitest';
import { _clearModelEvalHintsCacheForTests, loadModelEvalHints } from './model-eval-hints.ts';

describe('loadModelEvalHints', () => {
  // The catalog manifests on disk are the source of truth for this
  // helper; we test against the real files so a manifest typo or
  // schema drift surfaces here.
  it('returns the per-model floor for nemotron3-super-120b', () => {
    _clearModelEvalHintsCacheForTests();
    const hints = loadModelEvalHints('nemotron3-super-120b-q4');
    expect(hints?.sniffThresholds?.inlineJsMinBytes).toBe(1500);
  });

  it('normalizes legacy downloaded-cache ids before looking up manifests', () => {
    _clearModelEvalHintsCacheForTests();
    const hints = loadModelEvalHints('nemotron3-super-120b');
    expect(hints?.sniffThresholds?.inlineJsMinBytes).toBe(1500);
  });

  it('returns the per-model floor for nemotron3-nano-30b', () => {
    _clearModelEvalHintsCacheForTests();
    const hints = loadModelEvalHints('nemotron3-nano-30b-q4');
    expect(hints?.sniffThresholds?.inlineJsMinBytes).toBe(1000);
    expect(hints?.sniffThresholds?.htmlMinBytes).toBe(2048);
  });

  it('returns the per-model floor for gpt-oss-20b', () => {
    _clearModelEvalHintsCacheForTests();
    const hints = loadModelEvalHints('gpt-oss-20b-q4');
    expect(hints?.sniffThresholds?.inlineJsMinBytes).toBe(1000);
    expect(hints?.sniffThresholds?.htmlMinBytes).toBe(2048);
  });

  it('returns undefined for a model without evalHints', () => {
    _clearModelEvalHintsCacheForTests();
    const hints = loadModelEvalHints('qwen3.6-27b-q4');
    expect(hints).toBeUndefined();
  });

  it('returns undefined for a nonexistent model', () => {
    _clearModelEvalHintsCacheForTests();
    const hints = loadModelEvalHints('nonexistent-model-xyz');
    expect(hints).toBeUndefined();
  });

  it('caches per-process so re-reads do not hit disk twice', () => {
    _clearModelEvalHintsCacheForTests();
    const first = loadModelEvalHints('nemotron3-super-120b-q4');
    const second = loadModelEvalHints('nemotron3-super-120b-q4');
    expect(first).toBe(second); // same reference — cache hit
  });
});
