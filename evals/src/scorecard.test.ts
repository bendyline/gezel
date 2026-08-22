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
  readModelPerformance,
  runIdFor,
  resolveScorecardStartedAt,
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

describe('resolveScorecardStartedAt', () => {
  const NOW = '2026-09-01T12:00:00.000Z';
  const dataset = {
    runs: [
      { id: '2026-08-19-gb10-spark', provenance: { startedAt: '2026-08-20T03:12:45.603Z' } },
    ],
  } as never;

  it('reuses an existing run\'s recorded start when re-ingesting it', () => {
    // Regression: defaulting to `now` moved the perf window off the run's own
    // probes, so an --ingest-only rebuild silently dropped throughput from
    // every cell. Nothing errored — the column just stopped rendering.
    expect(
      resolveScorecardStartedAt({ dataset, runId: '2026-08-19-gb10-spark', now: NOW }),
    ).toEqual({ startedAt: '2026-08-20T03:12:45.603Z', reusedFromRun: true });
  });

  it('starts a fresh sweep at now for an unknown run id', () => {
    expect(resolveScorecardStartedAt({ dataset, runId: '2026-09-01-new-box', now: NOW })).toEqual({
      startedAt: NOW,
      reusedFromRun: false,
    });
    expect(resolveScorecardStartedAt({ dataset, now: NOW })).toEqual({
      startedAt: NOW,
      reusedFromRun: false,
    });
  });

  it('lets an explicit --started-at win over the recorded one', () => {
    expect(
      resolveScorecardStartedAt({
        dataset,
        runId: '2026-08-19-gb10-spark',
        explicitStartedAt: '2026-08-15T00:00:00.000Z',
        now: NOW,
      }),
    ).toEqual({ startedAt: '2026-08-15T00:00:00.000Z', reusedFromRun: false });
  });
});

describe('readModelPerformance', () => {
  async function probe(
    preflightRoot: string,
    dirName: string,
    report: { promptTokensPerSec: number; genTokensPerSec: number },
  ): Promise<void> {
    await mkdir(join(preflightRoot, dirName), { recursive: true });
    await writeFile(
      join(preflightRoot, dirName, 'preflight-report.json'),
      JSON.stringify(report),
      'utf8',
    );
  }

  const WINDOW = { fromIso: '2026-08-11T00:00:00.000Z', toIso: '2026-08-13T00:00:00.000Z' };

  it('finds a ds4 probe, whose directory carries the provider segment', async () => {
    // Regression: `makeTrialId` omits the provider segment only for
    // llama-cpp, so a ds4 probe is `preflight-ds4-<slug>-...`. Matching the
    // bare id dropped throughput for every non-llama-cpp model, and — like
    // the dotted-id bug below — the column just silently stopped rendering.
    root = await mkdtemp(join(tmpdir(), 'gezel-scorecard-perf-'));
    await probe(root, 'preflight-ds4-deepseek-v4-flash-284b-q2-2026-08-11T23-31-52-491Z-bosr', {
      promptTokensPerSec: 679.8,
      genTokensPerSec: 16.91,
    });

    // Rounded on read: prefill to whole tokens/sec, decode to one decimal.
    expect(readModelPerformance(root, 'deepseek-v4-flash-284b-q2', WINDOW, 'ds4')).toEqual({
      prefillTokensPerSec: 680,
      decodeTokensPerSec: 16.9,
      samples: 1,
    });
    // Without the engine the probe is invisible — proving the segment, not
    // some looser match, is what finds it.
    expect(readModelPerformance(root, 'deepseek-v4-flash-284b-q2', WINDOW)).toBeNull();
  });

  it('finds probes for a dotted model id, whose directory slugifies the dot', async () => {
    // Regression: the probe directory for `qwen3.6-27b-q4` is written as
    // `preflight-qwen3-6-27b-q4-...`. Prefix-matching the raw id found
    // nothing, and the failure was invisible — a model with no performance
    // simply stops contributing the column rather than erroring.
    root = await mkdtemp(join(tmpdir(), 'gezel-scorecard-perf-'));
    await probe(root, 'preflight-qwen3-6-27b-q4-2026-08-11T23-31-52-491Z-qxi4', {
      promptTokensPerSec: 400,
      genTokensPerSec: 18.5,
    });

    expect(readModelPerformance(root, 'qwen3.6-27b-q4', WINDOW)).toEqual({
      prefillTokensPerSec: 400,
      decodeTokensPerSec: 18.5,
      samples: 1,
    });
  });

  it('still matches an undotted id directly, and averages repeat probes', async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-scorecard-perf-'));
    await probe(root, 'preflight-gemma4-31b-q4-2026-08-12T05-28-24-721Z-3ejs', {
      promptTokensPerSec: 200,
      genTokensPerSec: 23.3,
    });
    await probe(root, 'preflight-gemma4-31b-q4-2026-08-12T06-28-24-721Z-abcd', {
      promptTokensPerSec: 210,
      genTokensPerSec: 23.5,
    });

    expect(readModelPerformance(root, 'gemma4-31b-q4', WINDOW)).toEqual({
      prefillTokensPerSec: 205,
      decodeTokensPerSec: 23.4,
      samples: 2,
    });
  });

  it('excludes probes outside the sweep window rather than publishing a stale machine state', async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-scorecard-perf-'));
    await probe(root, 'preflight-qwen3-6-27b-q4-2026-07-30T10-51-53-649Z-qwxg', {
      promptTokensPerSec: 999,
      genTokensPerSec: 99,
    });

    expect(readModelPerformance(root, 'qwen3.6-27b-q4', WINDOW)).toBeNull();
  });
});

describe('modelResultFromMatrix — kvCacheType', () => {
  /**
   * KV precision is not uniform across a sweep: the Gemma family launches
   * f16 (a quantized KV garbles its stored prompt tokens) while every other
   * family runs q8_0. A published table that omits it invites comparing a
   * Gemma row's wall-clock against a Qwen row as if they were measured the
   * same way — they were not.
   */
  const matrixFor = (root: string) => ({
    modelId: 'qwen3.8-27b-q8',
    label: 'Qwen 3.8',
    engine: 'llama-cpp',
    tier: 'medium',
    suiteId: 'core',
    matrixRoot: root,
    matrix: {
      scenarios: [
        { scenarioId: 'tictactoe', summaryPath: 'tictactoe/batch.json', trials: 2, successes: 2 },
      ],
    } as never,
  });

  const seed = async (root: string, kvByTrial: Record<string, string>) => {
    for (const [trialId, kv] of Object.entries(kvByTrial)) {
      const dir = join(root, 'tictactoe', trialId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'result.json'),
        JSON.stringify({ engineContext: { grantedPerSlotTokens: 262144, kvCacheType: kv } }),
      );
      await writeFile(join(dir, 'metrics.json'), JSON.stringify({ process: { peakRssMb: 18270 } }));
    }
    const trialIds = Object.keys(kvByTrial);
    await writeFile(
      join(root, 'tictactoe', 'batch.json'),
      JSON.stringify({
        scenarioId: 'tictactoe',
        trials: trialIds.length,
        successes: trialIds.length,
        trialIds,
        perTrial: trialIds.map((trialId) => ({ trialId, success: true, durationMs: 1000 })),
      }),
    );
  };

  it('records the KV cache type every trial agreed on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scorecard-kv-'));
    try {
      await seed(root, { t1: 'q8_0', t2: 'q8_0' });
      const result = modelResultFromMatrix(matrixFor(root), 'run-1');
      expect(result.runtime?.kvCacheType).toBe('q8_0');
      expect(result.runtime?.contextTokens).toBe(262144);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits the KV type when trials disagree rather than picking a winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scorecard-kv-mixed-'));
    try {
      await seed(root, { t1: 'q8_0', t2: 'f16' });
      const result = modelResultFromMatrix(matrixFor(root), 'run-1');
      // A cell that mixed two cache regimes has no honest single label.
      expect(result.runtime?.kvCacheType).toBeUndefined();
      expect(result.runtime?.contextTokens).toBe(262144);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
