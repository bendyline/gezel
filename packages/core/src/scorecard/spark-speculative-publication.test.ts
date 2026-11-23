import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';
import { measuredResultFor, measuredRowsFor } from './lookup.js';
import { scoreModel } from './report.js';

const runId = '2026-11-13-spark-speculative-decoding';
const results = SCORECARD.results.filter((result) => result.runId === runId);
const groups = results.flatMap((result) => result.taskMeasurements ?? []);
const spark = { platform: 'linux', arch: 'arm64', label: 'DGX Spark Class' };

describe('published DGX Spark speculative decoding round', () => {
  it('keeps all 903 trials, three per arm and scenario, with raw verdicts', () => {
    const run = SCORECARD.runs.find((entry) => entry.id === runId);
    expect(run?.scope).toBe('suite');
    expect(run?.memoryCoverage).toBe('incomplete');
    expect(results).toHaveLength(28);
    const cells = results.flatMap((result) => result.cells);
    expect(cells).toHaveLength(301);
    expect(cells.every((cell) => cell.trials === 3)).toBe(true);
    expect(cells.reduce((n, cell) => n + cell.successes, 0)).toBe(809);
    expect(cells.reduce((n, cell) => n + cell.nonModelFailures, 0)).toBe(0);
    expect(results.every((result) => scoreModel(result, 3).passRate !== null)).toBe(true);
  });

  it('gives only the catalog-default arms the plain model id', () => {
    const ids = [...new Set(results.map((result) => result.modelId))].sort();
    expect(ids).toEqual([
      'gemma4-12b-q4',
      'gemma4-12b-q4.none',
      'muse-glimmer-30b-q4',
      'muse-glimmer-30b-q4.none',
      'qwen3.8-27b-q4',
      'qwen3.8-27b-q4.mtp',
      'qwen3.8-27b-q4.none',
    ]);
    for (const result of results) {
      expect(result.label.endsWith('(default)')).toBe(!/\.(none|mtp)$/.test(result.modelId));
    }
  });

  it('lets model pages quote the default setting, never a speculation arm', () => {
    const qwen = measuredResultFor(SCORECARD, 'qwen3.8-27b-q4', spark);
    expect(qwen?.run.id).toBe(runId);
    expect(qwen?.result.label).toContain('DFlash2');
    for (const modelId of ['qwen3.8-27b-q4', 'gemma4-12b-q4', 'muse-glimmer-30b-q4']) {
      const rows = measuredRowsFor(SCORECARD, modelId).filter((row) => row.run.id === runId);
      expect(rows.length).toBe(4);
      expect(rows.every((row) => row.result.modelId === modelId)).toBe(true);
    }
  });

  it('shows engine-log task speeds, not a probe, a pooled judge mean or memory', () => {
    expect(results.every((result) => !result.judge && !result.performance)).toBe(true);
    expect(groups).toHaveLength(28);
    for (const group of groups) {
      expect(group.trials).toBe(group.durationMs?.samples);
      expect(group.outputTokensPerSec?.samples).toBe(group.trials);
      expect(group.prefillTokensPerSec?.samples).toBe(group.trials);
      expect(group.peakRssMb).toBeUndefined();
      expect(group.peakGpuMemMb).toBeUndefined();
    }
  });

  it('accounts for every review, one column per rubric', () => {
    const reviewed = groups.reduce(
      (n, group) => n + group.judgments.reduce((sum, judge) => sum + judge.artifacts, 0),
      0,
    );
    expect(reviewed).toBe(397);
    expect(groups.reduce((n, group) => n + group.excludedReviews, 0)).toBe(0);
    expect(groups.reduce((n, group) => n + group.noArtifact, 0)).toBe(2);
    expect(groups.reduce((n, group) => n + (group.notApplicableReviews ?? 0), 0)).toBe(504);
    const judges = new Set(groups.flatMap((group) => group.judgments.map((j) => j.judgeModel)));
    expect([...judges]).toEqual(['anthropic-cli/claude-sonnet-5-5']);
  });
});
