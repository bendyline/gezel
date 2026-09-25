import { describe, expect, it } from 'vitest';
import type { UnifiedSearchResult } from './schemas/api.js';
import {
  MERGE_WEIGHTS,
  STRONG_TIER_MIN_RELEVANCE,
  dedupeSearchResults,
  ftsRankRelevance,
  lexicalRelevance,
  pageSearchResults,
  scoreResult,
} from './search-ranking.js';

const hit = (
  id: string,
  score: number,
  extra: Partial<UnifiedSearchResult> = {},
): UnifiedSearchResult => ({ kind: 'file', id, title: id, score, ...extra }) as UnifiedSearchResult;

describe('scoreResult', () => {
  it('keeps tier and score derived from one calibrated relevance', () => {
    for (const relevance of [0, 0.3, 0.59, 0.6, 0.61, 1, 7, -2, Number.NaN]) {
      const r = scoreResult('content', relevance);
      expect(r.relevance).toBeGreaterThanOrEqual(0);
      expect(r.relevance).toBeLessThanOrEqual(1);
      expect(r.tier).toBe(r.relevance >= STRONG_TIER_MIN_RELEVANCE ? 'strong' : 'weak');
      expect(r.score).toBe(r.relevance * MERGE_WEIGHTS.content);
    }
  });

  it('anchors an FTS-only corpus so its top hit is a strong 0.6', () => {
    expect(ftsRankRelevance(0)).toBe(0.6);
    expect(ftsRankRelevance(5)).toBeLessThan(ftsRankRelevance(0));
  });
});

describe('lexicalRelevance', () => {
  it('lets only a full term match reach the strong tier', () => {
    expect(scoreResult('content', lexicalRelevance(1)).tier).toBe('strong');
    expect(scoreResult('content', lexicalRelevance(2 / 3)).tier).toBe('weak');
    expect(scoreResult('content', lexicalRelevance(3 / 4)).tier).toBe('weak');
    expect(lexicalRelevance(0)).toBe(0);
  });
});

describe('dedupeSearchResults', () => {
  it('keeps the best copy per id and, for memories, per text', () => {
    const out = dedupeSearchResults([
      hit('a', 1),
      hit('a', 5),
      hit('m1', 2, { kind: 'memory', snippet: 'The launch is  Friday' }),
      hit('m2', 3, { kind: 'memory', snippet: 'the launch is friday' }),
      hit('m3', 1, { kind: 'memory', snippet: 'Something else' }),
    ]);
    expect(out.map((r) => [r.id, r.score])).toEqual(
      expect.arrayContaining([
        ['a', 5],
        ['m2', 3],
        ['m3', 1],
      ]),
    );
    expect(out).toHaveLength(3);
  });
});

describe('pageSearchResults', () => {
  it('orders by score then id, and reports more only past the boundary', () => {
    const rows = [hit('b', 1), hit('a', 1), hit('c', 9)];
    const one = pageSearchResults(rows, { limit: 3 });
    expect(one.results.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(one.hasMore).toBe(false);
    const two = pageSearchResults(rows, { limit: 2 });
    expect(two.results.map((r) => r.id)).toEqual(['c', 'a']);
    expect(two.hasMore).toBe(true);
    const offset = pageSearchResults(rows, { offset: 2, limit: 5 });
    expect(offset.results.map((r) => r.id)).toEqual(['b']);
    expect(offset.hasMore).toBe(false);
  });
});
