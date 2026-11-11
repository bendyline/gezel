import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';
import { scoreModel } from './report.js';

const ids = [
  '2026-11-03-windows-saluki-native-0-1-57-original',
  '2026-11-06-windows-saluki-native-0-1-57-fanout',
  '2026-11-09-windows-saluki-native-0-1-57-round3',
];
const results = SCORECARD.results.filter((result) => ids.includes(result.runId));

describe('published Saluki laptop campaign', () => {
  it('preserves the original and continuation records and incomplete repetition coverage', () => {
    const runs = SCORECARD.runs.filter((run) => ids.includes(run.id));
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.memoryCoverage === 'system-only')).toBe(true);
    expect(runs.filter((run) => run.scope === 'subset')).toHaveLength(2);
    expect(results.every((result) => scoreModel(result, 3).passRate === null)).toBe(true);
    const cells = results.flatMap((result) => result.cells);
    expect(cells.reduce((n, cell) => n + cell.trials, 0)).toBe(128);
    expect(cells.reduce((n, cell) => n + cell.successes, 0)).toBe(98);
    expect(cells.reduce((n, cell) => n + cell.nonModelFailures, 0)).toBe(3);
    const eligibleByEntry = new Map<string, number>();
    for (const result of results) {
      for (const cell of result.cells) {
        const key = `${result.suiteId}/${cell.scenarioId}`;
        eligibleByEntry.set(
          key,
          (eligibleByEntry.get(key) ?? 0) + cell.trials - cell.nonModelFailures,
        );
      }
    }
    expect(eligibleByEntry.size).toBe(43);
    expect([...eligibleByEntry.values()].filter((n) => n === 3)).toHaveLength(41);
    expect(eligibleByEntry.get('complex-work/craftbook-author-gate-script')).toBe(1);
    expect(eligibleByEntry.get('complex-work/craftbook-author-fanout')).toBe(1);
  });

  it('sets aside interruptions without inventing an outcome or counting the unstarted fanout', () => {
    const fanout = results.find((result) => result.runId === ids[1])!;
    expect(fanout.cells).toEqual([
      { scenarioId: 'craftbook-author-fanout', trials: 1, successes: 0, nonModelFailures: 1 },
    ]);
    expect(fanout.taskMeasurements?.[0]).toMatchObject({
      trials: 1,
      judgments: [],
      notApplicableReviews: 1,
    });
    expect(fanout.taskMeasurements?.[0].outputTokensPerSec).toBeUndefined();
    expect(fanout.taskMeasurements?.[0].durationMs).toBeUndefined();
    const last = results.find(
      (result) => result.runId === ids[2] && result.suiteId === 'complex-work',
    )!;
    expect(last.cells.find((cell) => cell.scenarioId === 'craftbook-author-gate-script')).toEqual({
      scenarioId: 'craftbook-author-gate-script',
      trials: 1,
      successes: 0,
      nonModelFailures: 1,
    });
    expect(last.cells.find((cell) => cell.scenarioId === 'craftbook-author-fanout')).toEqual({
      scenarioId: 'craftbook-author-fanout',
      trials: 0,
      successes: 0,
      nonModelFailures: 0,
    });
    expect(last.taskMeasurements?.[0]).toMatchObject({
      trials: 8,
      outputTokensPerSec: { samples: 7 },
    });
  });

  it('publishes Sonnet 5.5 coverage and actual task metrics separately from fixed outcomes', () => {
    const groups = results.flatMap((result) => result.taskMeasurements ?? []);
    expect(groups.reduce((n, group) => n + group.trials, 0)).toBe(128);
    expect(
      groups.reduce(
        (n, group) => n + group.judgments.reduce((s, judge) => s + judge.artifacts, 0),
        0,
      ),
    ).toBe(52);
    expect(groups.reduce((n, group) => n + group.noArtifact, 0)).toBe(17);
    expect(groups.reduce((n, group) => n + (group.notApplicableReviews ?? 0), 0)).toBe(59);
    expect(groups.reduce((n, group) => n + group.excludedReviews, 0)).toBe(0);
    expect(groups.reduce((n, group) => n + (group.outputTokensPerSec?.samples ?? 0), 0)).toBe(126);
    expect(groups.reduce((n, group) => n + (group.prefillTokensPerSec?.samples ?? 0), 0)).toBe(126);
    expect(
      groups.every((group) =>
        group.judgments.every((judge) => judge.judgeModel === 'anthropic-cli/claude-sonnet-5-5'),
      ),
    ).toBe(true);
    expect(results.every((result) => !result.performance && !result.judge)).toBe(true);
    expect(results.every((result) => result.grantedContextTokens === 65536)).toBe(true);
    expect(
      results
        .filter((result) => result.runtime)
        .every((result) => result.runtime?.kvCacheType === 'f16'),
    ).toBe(true);
  });
});
