import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScorecardDatasetSchema, buildSuiteScoreboard } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureDevice,
  cellFromBatch,
  mergeScorecard,
  modelResultFromMatrix,
  runIdFor,
} from './scorecard.ts';
import type { BatchSummary, MatrixSummary } from './types.ts';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function batch(
  scenarioId: string,
  perTrial: Array<{ success: boolean; failureMode?: string; durationMs?: number }>,
): BatchSummary {
  const successes = perTrial.filter((t) => t.success).length;
  return {
    scenarioId,
    modelId: 'm',
    startedAt: '2026-08-09T00:00:00.000Z',
    finishedAt: '2026-08-09T01:00:00.000Z',
    status: 'complete',
    requestedTrials: perTrial.length,
    trials: perTrial.length,
    successes,
    successRate: successes / perTrial.length,
    trialIds: perTrial.map((_, i) => `t${i}`),
    perTrial: perTrial.map((t, i) => ({
      trialId: `t${i}`,
      success: t.success,
      durationMs: t.durationMs ?? 1000,
      reason: '',
      ...(t.failureMode ? { failureMode: t.failureMode as never } : {}),
    })),
  } as BatchSummary;
}

describe('cellFromBatch', () => {
  it('discards a failed trial the harness classified as infra', () => {
    const cell = cellFromBatch(
      batch('tictactoe', [{ success: true }, { success: false }, { success: false }]),
      (id) => (id === 't2' ? 'infra' : 'model'),
    );
    expect(cell).toMatchObject({ trials: 3, successes: 1, nonModelFailures: 1 });
  });

  it('never discards a PASSING trial, however it was classified', () => {
    const cell = cellFromBatch(batch('tictactoe', [{ success: true }]), () => 'infra');
    expect(cell.nonModelFailures).toBe(0);
  });

  it('falls back to the failure mode when no result.json is readable', () => {
    const cell = cellFromBatch(
      batch('tictactoe', [
        { success: false, failureMode: 'engine-crash' },
        { success: false, failureMode: 'success-check-false' },
      ]),
      () => null,
    );
    // engine-crash is unambiguously infra; a failed success-check is the
    // model's problem and must keep counting against it.
    expect(cell.nonModelFailures).toBe(1);
  });

  it('records a median duration', () => {
    const cell = cellFromBatch(
      batch('tictactoe', [
        { success: true, durationMs: 100 },
        { success: true, durationMs: 300 },
        { success: true, durationMs: 200 },
      ]),
      () => null,
    );
    expect(cell.medianDurationMs).toBe(200);
  });
});

describe('modelResultFromMatrix', () => {
  it('reads per-trial classes off disk and builds a scoreable result', async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-scorecard-'));
    const matrixRoot = join(root, 'matrix');
    await mkdir(join(matrixRoot, 'tictactoe', 't0'), { recursive: true });
    await mkdir(join(matrixRoot, 'tictactoe', 't1'), { recursive: true });
    await writeFile(
      join(matrixRoot, 'tictactoe', 'summary.json'),
      JSON.stringify(batch('tictactoe', [{ success: true }, { success: false }])),
    );
    await writeFile(
      join(matrixRoot, 'tictactoe', 't1', 'result.json'),
      JSON.stringify({ failureClass: 'infra' }),
    );

    const matrix = {
      modelId: 'm',
      scenarios: [
        {
          scenarioId: 'tictactoe',
          trials: 2,
          successes: 1,
          successRate: 0.5,
          summaryPath: 'tictactoe/summary.json',
        },
      ],
    } as unknown as MatrixSummary;

    const result = modelResultFromMatrix(
      {
        modelId: 'm',
        label: 'M',
        engine: 'llama-cpp',
        tier: 'medium',
        suiteId: 'core',
        matrix,
        matrixRoot,
      },
      'run-1',
    );
    expect(result.cells[0]).toMatchObject({ trials: 2, successes: 1, nonModelFailures: 1 });
  });

  it('attributes nothing away when the batch summary is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-scorecard-'));
    const matrix = {
      modelId: 'm',
      scenarios: [
        {
          scenarioId: 'gone',
          trials: 3,
          successes: 0,
          successRate: 0,
          summaryPath: 'gone/summary.json',
        },
      ],
    } as unknown as MatrixSummary;
    const result = modelResultFromMatrix(
      {
        modelId: 'm',
        label: 'M',
        engine: 'llama-cpp',
        tier: 'medium',
        suiteId: 'core',
        matrix,
        matrixRoot: root,
      },
      'run-1',
    );
    // Harsh rather than forgiving: an unreadable cell must not become a
    // free pass-rate boost.
    expect(result.cells[0]).toMatchObject({ trials: 3, successes: 0, nonModelFailures: 0 });
  });
});

describe('mergeScorecard', () => {
  const device = captureDevice();
  const run = (id: string, startedAt: string) => ({
    id,
    provenance: {
      startedAt,
      device,
      harnessCommit: 'abc1234',
      gildeVersion: '0.1.15',
      count: 3,
      judgeModelId: null,
    },
    suites: ['core'],
    scenariosBySuite: { core: ['tictactoe'] },
  });
  const result = (modelId: string, runId: string, successes: number) => ({
    modelId,
    label: modelId,
    engine: 'llama-cpp',
    tier: 'medium',
    runId,
    suiteId: 'core',
    cells: [{ scenarioId: 'tictactoe', trials: 3, successes, nonModelFailures: 0 }],
  });

  const empty = ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [], results: [] });

  it('adds a first sweep', () => {
    const merged = mergeScorecard(empty, run('r1', '2026-08-01T00:00:00Z'), [result('a', 'r1', 3)]);
    expect(merged.runs).toHaveLength(1);
    expect(merged.results).toHaveLength(1);
  });

  it('re-running one cell corrects it instead of duplicating', () => {
    const first = mergeScorecard(empty, run('r1', '2026-08-01T00:00:00Z'), [result('a', 'r1', 1)]);
    const second = mergeScorecard(first, run('r1', '2026-08-01T00:00:00Z'), [result('a', 'r1', 3)]);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]!.cells[0]!.successes).toBe(3);
  });

  it('keeps a later sweep separate and makes it the headline', () => {
    const first = mergeScorecard(empty, run('r1', '2026-08-01T00:00:00Z'), [result('a', 'r1', 3)]);
    const second = mergeScorecard(first, run('r2', '2026-08-09T00:00:00Z'), [result('b', 'r2', 1)]);
    expect(second.runs.map((r) => r.id)).toEqual(['r2', 'r1']);

    const board = buildSuiteScoreboard(second, 'core');
    expect(board?.run.id).toBe('r2');
    // The older model is NOT promoted into the new table just because it
    // scored higher — different sweep, different experiment.
    expect(board?.scores.map((s) => s.result.modelId)).toEqual(['b']);
    expect(board?.otherRunScores.map((s) => s.result.modelId)).toEqual(['a']);
  });

  it('adding a model to the current sweep puts it in the same table', () => {
    // The "we got a new model, test it and add it in" path.
    const first = mergeScorecard(empty, run('r1', '2026-08-01T00:00:00Z'), [result('a', 'r1', 3)]);
    const withNew = mergeScorecard(first, run('r1', '2026-08-01T00:00:00Z'), [
      result('new', 'r1', 2),
    ]);
    const board = buildSuiteScoreboard(withNew, 'core');
    expect(board?.scores.map((s) => s.result.modelId)).toEqual(['a', 'new']);
    expect(board?.otherRunScores).toHaveLength(0);
  });
});

describe('runIdFor', () => {
  it('is stable and filesystem-safe', () => {
    expect(
      runIdFor('2026-08-09T12:00:00.000Z', {
        label: 'Mac · Apple M4 Max',
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe('2026-08-09-mac-apple-m4-max');
  });
});
