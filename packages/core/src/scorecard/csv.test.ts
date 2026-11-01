import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCORECARD_CSV_COLUMNS,
  SCORECARD_CSV_FILE,
  scorecardCsvRows,
  scorecardResultsCsv,
} from './csv.js';
import { SCORECARD } from './index.js';
import type {
  ScorecardDataset,
  ScorecardModelResult,
  ScorecardRun,
  ScorecardTaskMeasurement,
} from './schema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function run(id: string, startedAt: string, overrides: Partial<ScorecardRun> = {}): ScorecardRun {
  return {
    id,
    provenance: {
      startedAt,
      device: {
        label: 'Mac · Apple M4 Max',
        platform: 'darwin',
        arch: 'arm64',
        memoryGb: 64,
        cpuModel: 'Apple M4 Max',
      },
      harnessCommit: 'abc1234',
      gildeVersion: '0.3.1',
      count: 3,
      judgeModelId: null,
    },
    suites: ['core'],
    scenariosBySuite: { core: ['a', 'b'] },
    ...overrides,
  };
}

function result(
  runId: string,
  overrides: Partial<ScorecardModelResult> = {},
): ScorecardModelResult {
  return {
    modelId: 'qwen3.8-27b-q4',
    label: 'Qwen 3.8 (27B, Q4)',
    engine: 'llama-cpp',
    tier: 'medium',
    runId,
    suiteId: 'core',
    cells: [
      { scenarioId: 'a', trials: 3, successes: 2, nonModelFailures: 0 },
      { scenarioId: 'b', trials: 3, successes: 1, nonModelFailures: 1 },
    ],
    ...overrides,
  };
}

function period(
  id: string,
  overrides: Partial<ScorecardTaskMeasurement> = {},
): ScorecardTaskMeasurement {
  return {
    id,
    label: id,
    trials: 6,
    source: 'engine-log',
    outputTokensPerSec: { samples: 6, median: 28.68, min: 18, max: 36 },
    prefillTokensPerSec: { samples: 6, median: 591.7, min: 370, max: 670 },
    judgments: [],
    noArtifact: 0,
    excludedReviews: 0,
    notApplicableReviews: 6,
    ...overrides,
  };
}

const dataset = (runs: ScorecardRun[], results: ScorecardModelResult[]): ScorecardDataset => ({
  schemaVersion: 1,
  runs,
  results,
});

describe('scorecard results CSV', () => {
  it('scores over attributable trials, as the published tables do', () => {
    const [row] = scorecardCsvRows(dataset([run('r1', '2026-10-01')], [result('r1')]));
    // 3 successes over 5 attributable trials: the non-model failure leaves
    // numerator and denominator alike.
    expect(row).toMatchObject({
      pass_rate_pct: '60.0',
      successes: '3',
      attributable_trials: '5',
      excluded_trials: '1',
      rate_quotable: 'yes',
      run_id: 'r1',
      device: 'M4 Max / 64 GB',
      scope: 'suite',
    });
  });

  it('flags a rate the sample cannot support', () => {
    const once = result('r1', {
      cells: [{ scenarioId: 'a', trials: 1, successes: 1, nonModelFailures: 0 }],
    });
    const [row] = scorecardCsvRows(dataset([run('r1', '2026-10-01')], [once]));
    expect(row).toMatchObject({ pass_rate_pct: '100.0', rate_quotable: 'no' });
  });

  it('carries an older round’s overall judge and admission probe', () => {
    const older = result('r1', {
      performance: { prefillTokensPerSec: 410.25, decodeTokensPerSec: 31.04, samples: 4 },
      judge: { meanScore: 7.125, artifacts: 8, judgeModel: 'claude-sonnet' },
    });
    const [row] = scorecardCsvRows(dataset([run('r1', '2026-08-09')], [older]));
    expect(row).toMatchObject({
      judge_score: '7.13',
      judge_artifacts: '8',
      judge_rubrics: '',
      judge_model: 'claude-sonnet',
      decode_tok_s: '31.0',
      prefill_tok_s: '410.3',
      perf_samples: '4',
      perf_source: 'probe mean',
    });
  });

  it('weights rubric means by artifact and keeps the breakdown beside them', () => {
    const newer = result('r1', {
      performance: { prefillTokensPerSec: 1, decodeTokensPerSec: 1, samples: 1 },
      taskMeasurements: [
        period('original', {
          judgments: [
            { rubricId: 'default-html-v1', meanScore: 6, artifacts: 3, judgeModel: 'j' },
            { rubricId: 'campaign-doc-v1', meanScore: 8, artifacts: 1, judgeModel: 'j' },
          ],
        }),
      ],
    });
    const [row] = scorecardCsvRows(dataset([run('r1', '2026-10-28')], [newer]));
    expect(row).toMatchObject({
      judge_score: '6.50',
      judge_artifacts: '4',
      judge_rubrics: 'campaign-doc-v1 8.00 (1); default-html-v1 6.00 (3)',
      judge_model: 'j',
      // Per-trial engine-log medians win over the averaged probe.
      decode_tok_s: '28.7',
      prefill_tok_s: '591.7',
      perf_samples: '6',
      perf_source: 'engine-log median',
    });
  });

  it('never averages separate hardware periods into one speed', () => {
    const split = result('r1', {
      taskMeasurements: [
        period('N1', { trials: 3 }),
        period('N2', {
          trials: 3,
          outputTokensPerSec: { samples: 3, median: 4.4, min: 3, max: 5 },
        }),
      ],
    });
    const [row] = scorecardCsvRows(dataset([run('r1', '2026-10-20')], [split]));
    expect(row).toMatchObject({
      decode_tok_s: '',
      prefill_tok_s: '',
      perf_source: 'engine-log, 2 periods (not combined)',
    });
  });

  it('lists newest sweeps first and quotes only fields that need it', () => {
    const csv = scorecardResultsCsv(
      dataset(
        [run('old', '2026-08-01'), run('new', '2026-10-01', { scope: 'subset' })],
        [result('old'), result('new', { label: 'Tiny, "fast"', modelId: 'tiny' })],
      ),
    );
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(SCORECARD_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',"Tiny, ""fast""",');
    expect(lines[1]).toContain(',subset,');
    expect(lines[2]).toContain(',"Qwen 3.8 (27B, Q4)",');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('has a published file that matches the checked-in sweeps', () => {
    // The CSV is generated and committed, like the barrel: a sweep added
    // without regenerating it is a result missing from the download and the
    // all-results table, with no error anywhere else.
    const committed = readFileSync(
      join(repoRoot, 'docs/handboek/assets/scorecards', SCORECARD_CSV_FILE),
      'utf8',
    );
    expect(committed, 'stale — run `pnpm scorecard:csv`').toBe(scorecardResultsCsv(SCORECARD));
  });

  it('stays plain ASCII, so a spreadsheet never has to guess the encoding', () => {
    // Excel opens a UTF-8 file without a byte-order mark as Windows-1252:
    // the published tables' "·" became "Â·" in every device name.
    const offenders = [...scorecardResultsCsv(SCORECARD)].filter((ch) => ch > '\u007f');
    expect([...new Set(offenders)]).toEqual([]);
  });
});
