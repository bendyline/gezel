import { describe, expect, it } from 'vitest';
import { scorecardCsvRows } from './csv.js';
import {
  docbenchResultFor,
  docbenchRowsFor,
  measuredResultFor,
  measuredRowsFor,
} from './lookup.js';
import {
  DOCBENCH_SUITE_ID,
  type ScorecardDataset,
  ScorecardDatasetSchema,
  type ScorecardDocbench,
  type ScorecardModelResult,
  type ScorecardRun,
} from './schema.js';

const device = { label: 'Rig', platform: 'win32', arch: 'arm64', osRelease: 'win32 10' };

function run(id: string, startedAt: string, suite: string): ScorecardRun {
  return {
    id,
    provenance: {
      startedAt,
      device,
      harnessCommit: 'abc1234',
      gildeVersion: '0.3.8',
      count: 3,
      judgeModelId: null,
    },
    suites: [suite],
    scenariosBySuite: { [suite]: ['task-a'] },
  };
}

function docbench(score: number): ScorecardDocbench {
  return {
    packVersion: '0.2.1',
    score,
    ci: [score - 2, score + 2],
    band: 1,
    usableRate: 1,
    families: { review: { score, ci: [score - 3, score + 3] } },
    tasks: {
      'review-general': {
        score,
        ci: [score - 3, score + 3],
        usableRate: 1,
        medianOutputTokens: 800,
        findings: { low: 3, medium: 1, high: 0.5, trivial: 0.25, wrong: 0 },
      },
    },
    judge: { model: 'claude-opus-5-5', promptVersion: 2, validityPassed: true },
  };
}

function result(
  runId: string,
  suiteId: string,
  extra: Partial<ScorecardModelResult> = {},
): ScorecardModelResult {
  return {
    modelId: 'demo-q4',
    label: 'Demo',
    engine: 'llama-cpp',
    tier: 'small',
    runId,
    suiteId,
    cells: [{ scenarioId: 'task-a', trials: 3, successes: 3, nonModelFailures: 0 }],
    ...extra,
  };
}

const dataset: ScorecardDataset = ScorecardDatasetSchema.parse({
  schemaVersion: 1,
  runs: [
    run('docbench-new', '2026-11-11T00:00:00Z', DOCBENCH_SUITE_ID),
    run('docbench-old', '2026-10-01T00:00:00Z', DOCBENCH_SUITE_ID),
    run('core-round', '2026-09-01T00:00:00Z', 'core'),
  ],
  results: [
    result('docbench-new', DOCBENCH_SUITE_ID, { docbench: docbench(72) }),
    result('docbench-new', DOCBENCH_SUITE_ID, {
      engine: 'mlx',
      docbench: docbench(70),
    }),
    result('docbench-old', DOCBENCH_SUITE_ID, { docbench: docbench(61) }),
    // A sibling quantization: its score is its own and never stands in.
    result('docbench-new', DOCBENCH_SUITE_ID, { modelId: 'demo-q8', docbench: docbench(80) }),
    result('core-round', 'core', {
      cells: [{ scenarioId: 'task-a', trials: 3, successes: 2, nonModelFailures: 0 }],
    }),
  ],
});

describe('docbench results in the scorecard', () => {
  it('are read per exact build, newest first', () => {
    const rows = docbenchRowsFor(dataset, 'demo-q4');
    expect(rows.map((row) => [row.run.id, row.result.engine, row.docbench.score])).toEqual([
      ['docbench-new', 'llama-cpp', 72],
      ['docbench-new', 'mlx', 70],
      ['docbench-old', 'llama-cpp', 61],
    ]);
    expect(docbenchResultFor(dataset, 'demo-q4', 'mlx')?.docbench.score).toBe(70);
    expect(docbenchResultFor(dataset, 'demo-q8')?.docbench.score).toBe(80);
    expect(docbenchResultFor(dataset, 'other-q4')).toBeNull();
  });

  it('never feed a pass-rate claim', () => {
    expect(measuredResultFor(dataset, 'demo-q4')?.result.suiteId).toBe('core');
    expect(measuredRowsFor(dataset, 'demo-q4').map((row) => row.result.suiteId)).toEqual(['core']);
  });

  it('stay out of the pass-rate CSV', () => {
    expect(scorecardCsvRows(dataset).map((row) => row.suite)).toEqual(['core']);
  });

  it('must use 0–100 scores', () => {
    const bad = {
      ...dataset,
      results: [result('docbench-new', DOCBENCH_SUITE_ID, { docbench: docbench(140) })],
    };
    expect(() => ScorecardDatasetSchema.parse(bad)).toThrow();
  });
});
