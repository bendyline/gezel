import { describe, expect, it } from 'vitest';
import { ScorecardTaskMeasurementSchema } from './schema.js';

const period = {
  id: 'A',
  label: 'Original runtime',
  trials: 4,
  source: 'engine-log',
  outputTokensPerSec: { samples: 4, min: 3, median: 20, max: 50 },
  judgments: [{ rubricId: 'code-v1', meanScore: 7.5, artifacts: 2, judgeModel: 'reviewer' }],
  noArtifact: 1,
  excludedReviews: 1,
};

describe('task measurement periods', () => {
  it('accounts for inapplicable rubrics without calling them missing or excluded artifacts', () => {
    const mixed = { ...period, trials: 7, notApplicableReviews: 3 };
    const parsed = ScorecardTaskMeasurementSchema.parse(mixed);
    expect(parsed.notApplicableReviews).toBe(3);
    expect(parsed.noArtifact).toBe(1);
    expect(parsed.excludedReviews).toBe(1);
    expect(
      ScorecardTaskMeasurementSchema.safeParse({ ...mixed, notApplicableReviews: 2 }).success,
    ).toBe(false);
    expect(
      ScorecardTaskMeasurementSchema.safeParse({ ...mixed, notApplicableReviews: -1 }).success,
    ).toBe(false);
  });
  it('accounts for scored artifacts, missing artifacts, and excluded reviews separately', () => {
    expect(ScorecardTaskMeasurementSchema.parse(period).judgments[0]?.artifacts).toBe(2);
    expect(ScorecardTaskMeasurementSchema.safeParse({ ...period, noArtifact: 0 }).success).toBe(
      false,
    );
    expect(ScorecardTaskMeasurementSchema.safeParse({ ...period, judgments: [] }).success).toBe(
      false,
    );
  });
  it('rejects impossible ranges, excess samples and duplicate rubric means', () => {
    for (const outputTokensPerSec of [
      { samples: 4, min: 30, median: 20, max: 50 },
      { samples: 4, min: 3, median: 20, max: 10 },
      { samples: 5, min: 3, median: 20, max: 50 },
    ])
      expect(
        ScorecardTaskMeasurementSchema.safeParse({ ...period, outputTokensPerSec }).success,
      ).toBe(false);
    expect(
      ScorecardTaskMeasurementSchema.safeParse({
        ...period,
        trials: 6,
        judgments: [...period.judgments, ...period.judgments],
      }).success,
    ).toBe(false);
  });
});
