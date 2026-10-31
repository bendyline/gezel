import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';
import { scoreModel } from './report.js';

const ids = [
  '2026-10-28-spark-native-0-1-54-original',
  '2026-10-29-spark-native-0-1-54-continuation',
  '2026-10-30-spark-native-0-1-54-final-six',
];
const results = SCORECARD.results.filter((result) => ids.includes(result.runId));

describe('published Spark comparison', () => {
  it('registers all attempts in separate rounds without claiming three repeats per condition', () => {
    const runs = SCORECARD.runs.filter((run) => ids.includes(run.id));
    expect(runs).toHaveLength(3);
    expect(runs.find((run) => run.id === ids[1])?.scope).toBe('subset');
    expect(runs.find((run) => run.id === ids[2])?.scenariosBySuite).toEqual({
      'complex-work': [
        'craftbook-author-params',
        'craftbook-author-gate-script',
        'craftbook-author-fanout',
      ],
    });
    expect(results.flatMap((result) => result.cells).reduce((n, cell) => n + cell.trials, 0)).toBe(
      258,
    );
    expect(results.every((result) => scoreModel(result, 3).passRate === null)).toBe(true);
    const counts = new Map<string, number>();
    for (const result of results) {
      for (const cell of result.cells) {
        const key = `${result.modelId}/${result.suiteId}/${cell.scenarioId}`;
        counts.set(key, (counts.get(key) ?? 0) + cell.trials);
      }
    }
    expect(counts.size).toBe(86);
    expect([...counts.values()].every((count) => count === 3)).toBe(true);
  });

  it('sets aside the admission-blocked observation while preserving all attempt measurements', () => {
    const result = results.find(
      (entry) => entry.runId === ids[2] && entry.modelId === 'gemma4-12b-q4',
    )!;
    expect(
      result.cells.find((cell) => cell.scenarioId === 'craftbook-author-fanout'),
    ).toMatchObject({
      trials: 1,
      successes: 0,
      nonModelFailures: 1,
    });
    expect(scoreModel(result).attributableTrials).toBe(2);
    expect(result.taskMeasurements?.[0]).toMatchObject({
      trials: 3,
      durationMs: { samples: 3 },
      outputTokensPerSec: { samples: 2 },
      prefillTokensPerSec: { samples: 2 },
      judgments: [],
      notApplicableReviews: 3,
    });
    expect(
      results.flatMap((entry) => entry.cells).reduce((n, cell) => n + cell.nonModelFailures, 0),
    ).toBe(3);
  });

  it('accounts for every review without averaging incompatible rubrics or fabricating probes', () => {
    const groups = results.flatMap((result) => result.taskMeasurements ?? []);
    expect(
      groups.reduce(
        (n, group) => n + group.judgments.reduce((sum, judge) => sum + judge.artifacts, 0),
        0,
      ),
    ).toBe(106);
    expect(groups.reduce((n, group) => n + group.excludedReviews, 0)).toBe(6);
    expect(groups.reduce((n, group) => n + group.noArtifact, 0)).toBe(2);
    expect(groups.reduce((n, group) => n + (group.notApplicableReviews ?? 0), 0)).toBe(144);
    expect(results.every((result) => !result.judge && !result.performance)).toBe(true);
    expect(
      groups.every((group) =>
        group.judgments.every((judge) => judge.rubricId !== 'craftbook-ab-test-readout'),
      ),
    ).toBe(true);
  });
});
