import { hardwareSummary, scoreModel, scorecardMemoryCoverage } from './report.js';
import type { ScorecardDataset, ScorecardModelResult, ScorecardRun } from './schema.js';

/**
 * Every recorded result as one flat CSV: a row per run × suite × model ×
 * engine, newest sweep first. The published tables show one round at a time;
 * this is the same data laid end to end, for spreadsheets and for the
 * all-results table at the foot of the scorecard article.
 *
 * The numbers come from the rules in report.ts, so a row can never disagree
 * with the table it was published in:
 *
 * - `pass_rate_pct` is over ATTRIBUTABLE trials — non-model failures leave
 *   numerator and denominator alike — and `rate_quotable` says whether the
 *   published table would quote it as a rate or only as a count.
 * - `judge_score` is advisory, out of 10, and averaged over the artifacts
 *   that were judged (`judge_artifacts`), weighted by artifact. Older rounds
 *   recorded one overall judge mean, which is exactly that; newer rounds
 *   judge by rubric, so the overall mean is derived and the per-rubric means
 *   travel beside it in `judge_rubrics`. Judges are not comparable with each
 *   other, which is why `judge_model` is a column.
 * - `decode_tok_s` / `prefill_tok_s` prefer the per-trial engine-log medians
 *   of newer rounds over the averaged admission probe of older ones, and
 *   `perf_source` says which a row carries — the two are never interchangeable.
 *   A result measured across several hardware periods has no single speed
 *   (the periods exist because the speed changed), so those cells stay empty
 *   rather than average a throttled period into a normal one.
 *
 * `run_id` leads, and a run's rows stay together, so a spreadsheet groups by
 * round without being asked. The text is plain ASCII: a spreadsheet given a
 * UTF-8 file without an encoding hint reads `·` as `Â·`, so the separators
 * and typography the published tables use (`Claude Sonnet 5.5 · Claude CLI`,
 * the device's parts) become their ASCII stand-ins here.
 */

/** Published beside the per-round downloads in docs/handboek/assets/scorecards/. */
export const SCORECARD_CSV_FILE = 'all-results.csv';

export const SCORECARD_CSV_COLUMNS = [
  'run_id',
  'started_at',
  'device',
  'platform',
  'arch',
  'suite',
  'model',
  'engine',
  'pass_rate_pct',
  'successes',
  'attributable_trials',
  'excluded_trials',
  'rate_quotable',
  'judge_score',
  'judge_artifacts',
  'judge_rubrics',
  'judge_model',
  'decode_tok_s',
  'prefill_tok_s',
  'perf_samples',
  'perf_source',
  'peak_memory_mb',
  'memory_coverage',
  'context_tokens',
  'kv_cache',
  'model_id',
  'tier',
  'parameters',
  'quantization',
  'scope',
  'trials_per_task',
  'harness_commit',
  'catalog_version',
] as const;

export type ScorecardCsvColumn = (typeof SCORECARD_CSV_COLUMNS)[number];
export type ScorecardCsvRow = Record<ScorecardCsvColumn, string>;

const fixed = (value: number | undefined, digits: number): string =>
  value === undefined || !Number.isFinite(value) ? '' : value.toFixed(digits);

interface JudgeColumns {
  score?: number;
  artifacts?: number;
  rubrics: string;
  model: string;
}

function judgeColumns(result: ScorecardModelResult): JudgeColumns {
  if (result.judge) {
    return {
      score: result.judge.meanScore,
      artifacts: result.judge.artifacts,
      rubrics: '',
      model: result.judge.judgeModel,
    };
  }
  const byRubric = new Map<string, { weighted: number; artifacts: number }>();
  const models = new Set<string>();
  for (const group of result.taskMeasurements ?? []) {
    for (const judgment of group.judgments) {
      const tally = byRubric.get(judgment.rubricId) ?? { weighted: 0, artifacts: 0 };
      tally.weighted += judgment.meanScore * judgment.artifacts;
      tally.artifacts += judgment.artifacts;
      byRubric.set(judgment.rubricId, tally);
      models.add(judgment.judgeModel);
    }
  }
  if (byRubric.size === 0) return { rubrics: '', model: '' };
  const rubrics = [...byRubric.entries()].sort(([a], [b]) => a.localeCompare(b));
  const artifacts = rubrics.reduce((sum, [, tally]) => sum + tally.artifacts, 0);
  const weighted = rubrics.reduce((sum, [, tally]) => sum + tally.weighted, 0);
  return {
    score: weighted / artifacts,
    artifacts,
    rubrics: rubrics
      .map(
        ([id, tally]) =>
          `${id} ${(tally.weighted / tally.artifacts).toFixed(2)} (${tally.artifacts})`,
      )
      .join('; '),
    model: [...models].sort().join('; '),
  };
}

interface PerformanceColumns {
  decode?: number;
  prefill?: number;
  samples?: number;
  source: string;
}

function performanceColumns(result: ScorecardModelResult): PerformanceColumns {
  const periods = (result.taskMeasurements ?? []).filter(
    (group) => group.outputTokensPerSec || group.prefillTokensPerSec,
  );
  if (periods.length > 1) {
    return { source: `engine-log, ${periods.length} periods (not combined)` };
  }
  const period = periods[0];
  if (period) {
    return {
      decode: period.outputTokensPerSec?.median,
      prefill: period.prefillTokensPerSec?.median,
      samples: period.outputTokensPerSec?.samples ?? period.prefillTokensPerSec?.samples,
      source: 'engine-log median',
    };
  }
  if (result.performance) {
    return {
      decode: result.performance.decodeTokensPerSec,
      prefill: result.performance.prefillTokensPerSec,
      samples: result.performance.samples,
      source: 'probe mean',
    };
  }
  return { source: '' };
}

/** The published tables' typography, each with the ASCII it stands for. */
const ASCII_STAND_INS: readonly (readonly [RegExp, string])[] = [
  [/·/g, '/'],
  [/[–—]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, '...'],
  [/ /g, ' '],
];

const plainAscii = (text: string): string =>
  ASCII_STAND_INS.reduce((out, [pattern, ascii]) => out.replace(pattern, ascii), text);

/** One result as a CSV row, scored exactly as its published table scores it. */
export function scorecardCsvRow(run: ScorecardRun, result: ScorecardModelResult): ScorecardCsvRow {
  const row = scorecardCsvFields(run, result);
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [column, plainAscii(value)]),
  ) as ScorecardCsvRow;
}

function scorecardCsvFields(run: ScorecardRun, result: ScorecardModelResult): ScorecardCsvRow {
  const p = run.provenance;
  const score = scoreModel(result, p.count);
  const judge = judgeColumns(result);
  const perf = performanceColumns(result);
  return {
    run_id: run.id,
    started_at: p.startedAt,
    device: hardwareSummary(p.device),
    platform: p.device.platform,
    arch: p.device.arch,
    suite: result.suiteId,
    model: result.label,
    engine: result.engine,
    pass_rate_pct:
      score.attributableTrials > 0
        ? fixed((100 * score.successes) / score.attributableTrials, 1)
        : '',
    successes: String(score.successes),
    attributable_trials: String(score.attributableTrials),
    excluded_trials: String(score.discardedTrials),
    rate_quotable: score.passRate === null ? 'no' : 'yes',
    judge_score: fixed(judge.score, 2),
    judge_artifacts: judge.artifacts === undefined ? '' : String(judge.artifacts),
    judge_rubrics: judge.rubrics,
    judge_model: judge.model,
    decode_tok_s: fixed(perf.decode, 1),
    prefill_tok_s: fixed(perf.prefill, 1),
    perf_samples: perf.samples === undefined ? '' : String(perf.samples),
    perf_source: perf.source,
    peak_memory_mb: result.runtime ? String(result.runtime.peakMemoryMb) : '',
    memory_coverage: result.runtime ? scorecardMemoryCoverage(run) : '',
    context_tokens: String(result.runtime?.contextTokens ?? result.grantedContextTokens ?? ''),
    kv_cache: result.runtime?.kvCacheType ?? '',
    model_id: result.modelId,
    tier: result.tier,
    parameters: result.parameterSize ?? '',
    quantization: result.quantization ?? '',
    scope: run.scope ?? 'suite',
    trials_per_task: String(p.count),
    harness_commit: p.harnessCommit,
    catalog_version: p.gildeVersion,
  };
}

/** Every result, newest sweep first, then by suite, model, and engine. */
export function scorecardCsvRows(dataset: ScorecardDataset): ScorecardCsvRow[] {
  const runs = new Map(dataset.runs.map((run) => [run.id, run]));
  return dataset.results
    .flatMap((result) => {
      const run = runs.get(result.runId);
      return run ? [{ run, result }] : [];
    })
    .sort(
      (a, b) =>
        b.run.provenance.startedAt.localeCompare(a.run.provenance.startedAt) ||
        b.run.id.localeCompare(a.run.id) ||
        a.result.suiteId.localeCompare(b.result.suiteId) ||
        a.result.label.localeCompare(b.result.label) ||
        a.result.engine.localeCompare(b.result.engine),
    )
    .map(({ run, result }) => scorecardCsvRow(run, result));
}

/** RFC 4180: quote a field only when it holds a comma, quote, or line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The whole dataset as CSV text: a header row, then one line per result. */
export function scorecardResultsCsv(dataset: ScorecardDataset): string {
  const lines = [
    SCORECARD_CSV_COLUMNS.join(','),
    ...scorecardCsvRows(dataset).map((row) =>
      SCORECARD_CSV_COLUMNS.map((column) => csvField(row[column])).join(','),
    ),
  ];
  return `${lines.join('\n')}\n`;
}
