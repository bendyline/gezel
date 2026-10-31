import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';
import { scoreModel } from './report.js';

const runId = '2026-10-28-dgx-spark-class';
const results = SCORECARD.results.filter((result) => result.runId === runId);
const groups = results.flatMap((result) => result.taskMeasurements ?? []);

describe('published DGX Spark round', () => {
  it('keeps all 258 trials, three per model and scenario, with raw verdicts', () => {
    const run = SCORECARD.runs.find((entry) => entry.id === runId);
    expect(run?.scope).toBe('suite');
    expect(run?.memoryCoverage).toBe('incomplete');
    const cells = results.flatMap((result) => result.cells);
    expect(cells).toHaveLength(86);
    expect(cells.every((cell) => cell.trials === 3)).toBe(true);
    expect(cells.reduce((n, cell) => n + cell.successes, 0)).toBe(196);
    expect(cells.reduce((n, cell) => n + cell.nonModelFailures, 0)).toBe(3);
    expect(results.every((result) => scoreModel(result, 3).passRate !== null)).toBe(true);
  });

  it('shows engine-log task speeds, not the admission probe, a pooled judge mean or memory', () => {
    expect(results.every((result) => !result.judge && !result.performance)).toBe(true);
    expect(groups).toHaveLength(8);
    for (const group of groups) {
      expect(group.trials).toBe(group.durationMs?.samples);
      expect(group.outputTokensPerSec?.samples).toBe(group.trials);
      expect(group.prefillTokensPerSec?.samples).toBe(group.trials);
      expect(group.peakRssMb).toBeUndefined();
      expect(group.peakGpuMemMb).toBeUndefined();
    }
  });

  it('accounts for every review and keeps mismatched or incidental ones out of the means', () => {
    const reviewed = groups.reduce(
      (n, group) => n + group.judgments.reduce((sum, judge) => sum + judge.artifacts, 0),
      0,
    );
    expect(reviewed).toBe(108);
    expect(groups.reduce((n, group) => n + group.excludedReviews, 0)).toBe(13);
    expect(groups.reduce((n, group) => n + group.noArtifact, 0)).toBe(0);
    expect(groups.reduce((n, group) => n + (group.notApplicableReviews ?? 0), 0)).toBe(137);
    const rubricIds = new Set(groups.flatMap((group) => group.judgments.map((j) => j.rubricId)));
    expect(rubricIds.has('craftbook-ab-test-readout')).toBe(false);
    expect(rubricIds.has('craftbook-find-vs-create')).toBe(false);
  });
});
