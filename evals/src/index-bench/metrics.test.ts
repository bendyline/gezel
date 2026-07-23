import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from './corpus.ts';
import { matchesExpected, scoreQuery, scoreRetrieval } from './metrics.ts';

describe('matchesExpected', () => {
  it('dir+basename requires the last two segments, slash- and backtick-agnostic', () => {
    const exp = 'core/src/markdown/sanitize.ts';
    expect(matchesExpected('core/src/markdown/sanitize.ts', exp, 'dir+basename')).toBe(true);
    expect(
      matchesExpected('The code is in `markdown/sanitize.ts` here.', exp, 'dir+basename'),
    ).toBe(true);
    expect(matchesExpected('markdown\\sanitize.ts', exp, 'dir+basename')).toBe(true);
    expect(matchesExpected('formats/other/sanitize.ts', exp, 'dir+basename')).toBe(false);
    expect(matchesExpected('sanitize.ts alone', exp, 'dir+basename')).toBe(false);
  });

  it('basename accepts the bare filename (only used for corpus-unique names)', () => {
    const exp = 'core/src/spatial/Geohash.ts';
    expect(matchesExpected('see Geohash.ts', exp, 'basename')).toBe(true);
    expect(matchesExpected('see Haversine.ts', exp, 'basename')).toBe(false);
  });
});

describe('scoreQuery / scoreRetrieval', () => {
  const q: GoldenQuery = {
    query: 'q',
    expected: ['core/src/markdown/sanitize.ts'],
    matchLevel: 'dir+basename',
  };

  it('ranks the first expected hit', () => {
    expect(scoreQuery(['a.ts', 'core/src/markdown/sanitize.ts', 'b.ts'], q).rank).toBe(2);
    expect(scoreQuery(['a.ts', 'b.ts'], q).rank).toBeNull();
  });

  it('computes recall@k and MRR', () => {
    const score = scoreRetrieval([
      { query: 'a', rank: 1 },
      { query: 'b', rank: 4 },
      { query: 'c', rank: null },
      { query: 'd', rank: 8 },
    ]);
    expect(score.recallAt1).toBeCloseTo(1 / 4);
    expect(score.recallAt5).toBeCloseTo(2 / 4);
    expect(score.mrr).toBeCloseTo((1 + 0.25 + 0 + 0.125) / 4);
  });
});
