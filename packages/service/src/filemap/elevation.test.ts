import { describe, expect, it } from 'vitest';
import { computeLevels, landmarkLevels, prominenceScore, selectLandmarks } from './elevation.js';

describe('computeLevels', () => {
  it('floors at 1 for a zero-signal file', () => {
    expect(computeLevels({ importance: 0, loc: 0, churnCommits: 0 })).toBe(1);
  });

  it('caps at 5 for a maxed-out hub', () => {
    expect(computeLevels({ importance: 1, loc: 5000, churnCommits: 100 })).toBe(5);
  });

  it('treats git-absent (churn 0) identically to zero-history git', () => {
    for (const importance of [0, 0.3, 0.7, 1]) {
      for (const loc of [10, 400, 2000]) {
        expect(computeLevels({ importance, loc, churnCommits: 0 })).toBe(
          computeLevels({ importance, loc, churnCommits: 0 }),
        );
      }
    }
  });

  it('grows monotonically with importance', () => {
    const at = (importance: number) => computeLevels({ importance, loc: 200, churnCommits: 5 });
    expect(at(1)).toBeGreaterThan(at(0));
    expect(prominenceScore({ importance: 1, loc: 200, churnCommits: 5 })).toBeGreaterThan(
      prominenceScore({ importance: 0.5, loc: 200, churnCommits: 5 }),
    );
  });

  it('lands mid-range files on 2-3 storeys, not a flat city', () => {
    const mid = computeLevels({ importance: 0.4, loc: 300, churnCommits: 8 });
    expect(mid).toBeGreaterThanOrEqual(2);
    expect(mid).toBeLessThanOrEqual(3);
  });
});

describe('landmarkLevels', () => {
  it('bumps to at least 4 and never lowers', () => {
    expect(landmarkLevels(1)).toBe(4);
    expect(landmarkLevels(5)).toBe(5);
  });
});

describe('selectLandmarks', () => {
  const civic = (path: string, importance: number, churnCommits = 0) => ({
    path,
    zone: 'civic',
    importance,
    churnCommits,
  });

  it('returns empty when there are no civic candidates', () => {
    expect(
      selectLandmarks([{ path: 'a', zone: 'residential', importance: 1, churnCommits: 9 }], 100)
        .size,
    ).toBe(0);
  });

  it('never selects non-civic blocks', () => {
    const got = selectLandmarks(
      [
        civic('hub.ts', 0.9),
        { path: 'big.ts', zone: 'industrial', importance: 1, churnCommits: 0 },
      ],
      100,
    );
    expect(got.has('hub.ts')).toBe(true);
    expect(got.has('big.ts')).toBe(false);
  });

  it('scales K with map size: min 3, ceil(N/50), max 12', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      civic(`f${String(i).padStart(2, '0')}.ts`, 1 - i / 100),
    );
    expect(selectLandmarks(many, 10).size).toBe(3);
    expect(selectLandmarks(many, 200).size).toBe(4);
    expect(selectLandmarks(many, 2000).size).toBe(12);
  });

  it('caps at the civic pool size when smaller than K', () => {
    expect(selectLandmarks([civic('a.ts', 0.5)], 2000).size).toBe(1);
  });

  it('ranks by importance, then churn, then path — deterministically', () => {
    const got = selectLandmarks(
      [civic('c.ts', 0.5, 1), civic('b.ts', 0.5, 9), civic('a.ts', 0.9), civic('d.ts', 0.5, 1)],
      50,
    );
    expect([...got]).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
