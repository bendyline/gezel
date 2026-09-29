import { describe, expect, it } from 'vitest';
import { mcnemarExact, stratifiedBootstrap } from '../ab-stats.ts';
import {
  type JudgedRow,
  ndcgAtK,
  precisionAtK,
  reciprocalRank,
  scoreAuc,
  setPrecision,
  strictRecallAtK,
  summarizeSurface,
} from './metrics.ts';

function row(partial: Partial<JudgedRow>): JudgedRow {
  return {
    queryId: 'q',
    class: 'title',
    split: 'dev',
    surface: 'turn',
    expect: 'answer',
    kept: [],
    labels: {},
    decoys: [],
    reachableGrades: [],
    latencyMs: 10,
    ...partial,
  };
}

describe('per-row retrieval metrics', () => {
  const answered = row({
    kept: ['noise', 'gold', 'related'],
    labels: { gold: 2, related: 1 },
    reachableGrades: [2, 1],
  });

  it('scores a graded ranking', () => {
    expect(precisionAtK(answered, 3)).toBeCloseTo(2 / 3);
    expect(setPrecision(answered)).toBeCloseTo(2 / 3);
    // DCG = 3/log2(3) + 1/log2(4); IDCG = 3/log2(2) + 1/log2(3).
    const dcg = 3 / Math.log2(3) + 1 / 2;
    const idcg = 3 + 1 / Math.log2(3);
    expect(ndcgAtK(answered, 5)).toBeCloseTo(dcg / idcg);
    expect(reciprocalRank(answered)).toBeCloseTo(1 / 2);
    expect(strictRecallAtK(answered, 5)).toBe(1);
  });

  it('has nothing to measure when nothing relevant is reachable or kept', () => {
    const empty = row({ expect: 'abstain' });
    expect(ndcgAtK(empty, 5)).toBeNull();
    expect(reciprocalRank(empty)).toBeNull();
    expect(strictRecallAtK(empty, 5)).toBeNull();
    expect(setPrecision(empty)).toBeNull();
  });
});

describe('surface summary', () => {
  const rows = [
    row({ kept: ['gold'], labels: { gold: 2 }, reachableGrades: [2], tokens: 100 }),
    row({ class: 'absent', expect: 'abstain', kept: [] }),
    row({
      class: 'absent',
      expect: 'abstain',
      kept: ['decoy'],
      decoys: ['decoy'],
      tokens: 80,
    }),
  ];
  const summary = summarizeSurface('turn', rows, { iterations: 200 });

  it('separates false injections from coverage', () => {
    expect(summary.falseInjectionStrict?.estimate).toBeCloseTo(0.5);
    expect(summary.falseInjectionLenient?.estimate).toBeCloseTo(0.5);
    expect(summary.answerCoverage).toBe(1);
    expect(summary.abstentionBalancedAccuracy).toBeCloseTo(0.75);
    expect(summary.distractorItemRate).toBeCloseTo(0.5);
    expect(summary.tokensPerRelevantHit).toBeCloseTo(180);
  });
});

describe('statistics', () => {
  it('computes AUC over relevant and irrelevant scores', () => {
    expect(
      scoreAuc([
        { score: 0.9, relevant: true },
        { score: 0.8, relevant: false },
        { score: 0.7, relevant: true },
        { score: 0.1, relevant: false },
      ]),
    ).toBeCloseTo(0.75);
  });

  it('runs an exact McNemar test', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(10, 0)).toBeCloseTo(2 / 1024);
  });

  it('bootstraps deterministically around the point estimate', () => {
    const values = [0, 1, 1, 0, 1, 1, 1, 0];
    const mean = (sample: readonly number[]) =>
      sample.reduce((sum, v) => sum + v, 0) / sample.length;
    const a = stratifiedBootstrap(values, mean, { iterations: 500, seed: 7 });
    const b = stratifiedBootstrap(values, mean, { iterations: 500, seed: 7 });
    expect(a).toEqual(b);
    expect(a?.estimate).toBeCloseTo(0.625);
    expect(a!.low).toBeLessThanOrEqual(0.625);
    expect(a!.high).toBeGreaterThanOrEqual(0.625);
  });
});
