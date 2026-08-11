import { describe, expect, it } from 'vitest';
import { FileReviewWireSchema, formatReviewProvenance } from './file-review.js';

describe('FileReviewWireSchema', () => {
  const base = {
    notesMd: 'notes',
    issues: [],
    health: 6,
    healthReason: 'fine',
    model: 'qwen3-4b',
    reviewedAt: '2026-08-11T10:00:00.000Z',
  };

  it('round-trips with and without the provenance fields', () => {
    expect(FileReviewWireSchema.parse(base)).toMatchObject({ model: 'qwen3-4b' });
    const full = FileReviewWireSchema.parse({
      ...base,
      provider: 'llama-cpp',
      gezelId: 'noor',
      gezelName: 'Noor',
      appVersion: '1.2.3',
    });
    expect(full.provider).toBe('llama-cpp');
    expect(full.appVersion).toBe('1.2.3');
  });
});

describe('formatReviewProvenance', () => {
  it('renders the full line', () => {
    expect(
      formatReviewProvenance({
        model: 'qwen3-4b',
        provider: 'llama-cpp',
        gezelName: 'Noor',
        appVersion: '1.2.3',
        reviewedAt: '2026-08-11T10:00:00.000Z',
      }),
    ).toBe('Reviewed by qwen3-4b (llama-cpp) · Noor · gezel 1.2.3 · 2026-08-11');
  });

  it('drops null segments and degrades to the model-only line', () => {
    expect(formatReviewProvenance({ model: 'qwen3-4b', provider: null, reviewedAt: null })).toBe(
      'Reviewed by qwen3-4b',
    );
  });

  it('names a dev build honestly', () => {
    expect(
      formatReviewProvenance({
        model: 'm',
        appVersion: '0.0.0',
        reviewedAt: '2026-08-11T10:00:00.000Z',
      }),
    ).toBe('Reviewed by m · gezel dev · 2026-08-11');
  });

  it('null when even the model is unrecorded', () => {
    expect(formatReviewProvenance({ model: null, reviewedAt: null })).toBeNull();
  });
});
