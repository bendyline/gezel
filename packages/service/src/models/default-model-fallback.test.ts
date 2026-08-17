import { describe, expect, it } from 'vitest';
import {
  type InstalledModelSummary,
  pickDefaultModelFallback,
  reconcileDefaultModel,
} from './default-model-fallback.js';

function model(
  id: string,
  installedAt: string,
  approxSizeBytes = 1_000_000_000,
): InstalledModelSummary {
  return { id, installedAt, approxSizeBytes };
}

describe('pickDefaultModelFallback', () => {
  it('returns undefined when nothing is installed', () => {
    expect(pickDefaultModelFallback([])).toBeUndefined();
  });

  it('returns the only installed model', () => {
    expect(pickDefaultModelFallback([model('gemma4-e4b-q4', '2026-08-17T02:47:07.293Z')])).toBe(
      'gemma4-e4b-q4',
    );
  });

  it('prefers the most recently installed model', () => {
    const picked = pickDefaultModelFallback([
      model('older', '2026-08-01T00:00:00.000Z'),
      model('newest', '2026-08-17T00:00:00.000Z'),
      model('middle', '2026-08-09T00:00:00.000Z'),
    ]);
    expect(picked).toBe('newest');
  });

  it('breaks an install-time tie on size, then id, so the pick never alternates', () => {
    const same = '2026-08-17T00:00:00.000Z';
    expect(pickDefaultModelFallback([model('small', same, 1_000), model('big', same, 9_000)])).toBe(
      'big',
    );
    expect(pickDefaultModelFallback([model('bbb', same, 5_000), model('aaa', same, 5_000)])).toBe(
      'aaa',
    );
  });

  it('treats an unparseable installedAt as oldest rather than throwing', () => {
    const picked = pickDefaultModelFallback([
      model('broken', 'not-a-date'),
      model('good', '2026-01-01T00:00:00.000Z'),
    ]);
    expect(picked).toBe('good');
  });
});

describe('reconcileDefaultModel', () => {
  it('leaves an installed pin alone', () => {
    expect(
      reconcileDefaultModel({
        pinned: 'gemma4-e4b-q4',
        installed: [model('gemma4-e4b-q4', '2026-08-17T00:00:00.000Z')],
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('substitutes an installed model for a pin whose weights never landed', () => {
    expect(
      reconcileDefaultModel({
        pinned: 'qwen3.6-27b-q8',
        installed: [model('gemma4-e4b-q4', '2026-08-17T00:00:00.000Z')],
      }),
    ).toEqual({ kind: 'substitute', modelId: 'gemma4-e4b-q4' });
  });

  it('substitutes for an absent pin too', () => {
    expect(
      reconcileDefaultModel({
        installed: [model('gemma4-e4b-q4', '2026-08-17T00:00:00.000Z')],
      }),
    ).toEqual({ kind: 'substitute', modelId: 'gemma4-e4b-q4' });
  });

  it('reports nothing-installed when there is no fallback to offer', () => {
    expect(reconcileDefaultModel({ pinned: 'qwen3.6-27b-q8', installed: [] })).toEqual({
      kind: 'nothing-installed',
    });
  });
});
