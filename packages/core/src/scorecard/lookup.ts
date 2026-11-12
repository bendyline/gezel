/**
 * "Has this model been measured, and how did it do?" — the one question the
 * model catalog, `gezel model list` and `gezel doctor` all need answered
 * from the published scorecard, with the same preference order everywhere:
 * the newest headline-suite result on hardware like the reader's, else the
 * newest anywhere, else nothing. Never a number without saying where it
 * came from.
 */

import { scorecardHardwareKey, scorecardModelFamilyId } from './filter.js';
import { type ModelScore, hardwareSummary, scoreModel } from './report.js';
import {
  DOCBENCH_SUITE_ID,
  type ScorecardDataset,
  type ScorecardDevice,
  type ScorecardDocbench,
  type ScorecardModelResult,
  type ScorecardRun,
} from './schema.js';

/**
 * docbench rows are judged quality scores, not pass rates: they never feed a
 * "passed N%" claim. Read them with {@link docbenchResultFor}.
 */
function isPassRateResult(result: ScorecardModelResult): boolean {
  return result.suiteId !== DOCBENCH_SUITE_ID;
}

export interface DocbenchResult {
  result: ScorecardModelResult;
  run: ScorecardRun;
  docbench: ScorecardDocbench;
}

/**
 * Every docbench result for exactly this build (a quant's score is its own,
 * so sibling quantizations never stand in), newest first.
 */
export function docbenchRowsFor(dataset: ScorecardDataset, modelId: string): DocbenchResult[] {
  const runs = new Map(dataset.runs.map((run) => [run.id, run]));
  return dataset.results
    .filter((result) => result.modelId === modelId && result.docbench)
    .map((result): DocbenchResult | null => {
      const run = runs.get(result.runId);
      return run && result.docbench ? { result, run, docbench: result.docbench } : null;
    })
    .filter((row): row is DocbenchResult => row !== null)
    .sort((a, b) => b.run.provenance.startedAt.localeCompare(a.run.provenance.startedAt));
}

/** The newest docbench result for this build, optionally on one engine. */
export function docbenchResultFor(
  dataset: ScorecardDataset,
  modelId: string,
  engine?: string,
): DocbenchResult | null {
  return (
    docbenchRowsFor(dataset, modelId).find((row) => !engine || row.result.engine === engine) ?? null
  );
}

/** The suite a one-line "measured" claim quotes first. */
export const MEASURED_HEADLINE_SUITE = 'core';

export interface MeasuredResult {
  result: ScorecardModelResult;
  run: ScorecardRun;
  score: ModelScore;
  /** True when the run's device is the same platform as the reader's. */
  sameHardwareClass: boolean;
}

/** Whether the result is for this exact model id, or a sibling quantization. */
function matches(result: ScorecardModelResult, modelId: string, exact: boolean): boolean {
  return exact
    ? result.modelId === modelId
    : scorecardModelFamilyId(result.modelId) === scorecardModelFamilyId(modelId);
}

/**
 * The scorecard's own publishing rule: a result with any task that measured
 * nothing is left out of the tables rather than shown with a gap, so it is
 * not quoted anywhere else either.
 */
export function isPublishable(score: ModelScore): boolean {
  return score.attributableTrials > 0 && score.unmeasuredScenarios.length === 0;
}

/**
 * The published result to quote for a model. Exact-id results win over
 * same-family quantizations; within those, a run on the reader's platform
 * wins; within those, the headline suite wins; then the newest run.
 */
export function measuredResultFor(
  dataset: ScorecardDataset,
  modelId: string,
  device?: Pick<ScorecardDevice, 'platform' | 'arch' | 'label'> | null,
  suiteId: string = MEASURED_HEADLINE_SUITE,
): MeasuredResult | null {
  const runs = new Map(dataset.runs.map((run) => [run.id, run]));
  const key = device ? scorecardHardwareKey(device) : null;
  const candidates = dataset.results
    .filter(isPassRateResult)
    .map((result): MeasuredResult | null => {
      const run = runs.get(result.runId);
      if (!run || run.scope === 'subset') return null;
      const score = scoreModel(result, run.provenance.count);
      if (!isPublishable(score)) return null;
      return {
        result,
        run,
        score,
        sameHardwareClass: key !== null && scorecardHardwareKey(run.provenance.device) === key,
      };
    })
    .filter((c): c is MeasuredResult => c !== null);
  const rank = (c: MeasuredResult): [number, number, number, string] => [
    matches(c.result, modelId, true) ? 0 : 1,
    c.sameHardwareClass ? 0 : 1,
    c.result.suiteId === suiteId ? 0 : 1,
    c.run.provenance.startedAt,
  ];
  const mine = candidates.filter((c) => matches(c.result, modelId, false));
  mine.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return (ra[i] as number) - (rb[i] as number);
    // Newest first.
    return rb[3].localeCompare(ra[3]);
  });
  return mine[0] ?? null;
}

/**
 * One short phrase for a table column: `94% general (M4 Max)`,
 * `12/13 office (DGX Spark Class)`, or `not measured`. Names the suite in
 * the Handboek's words and the hardware it was measured on, so a reader on
 * a laptop does not mistake a workstation's number for a promise.
 */
export function measuredClaim(measured: MeasuredResult | null): string {
  if (!measured) return 'not measured';
  const { score, result, run } = measured;
  const suite = MEASURED_SUITE_WORDS[result.suiteId] ?? result.suiteId;
  const fraction =
    score.passRate === null
      ? `${score.successes}/${score.attributableTrials}`
      : `${Math.round(score.passRate * 100)}%`;
  return `${fraction} ${suite} (${measuredWhere(run.provenance.device)})`;
}

/**
 * The shortest name for the hardware a number came from: the chip on a Mac,
 * the graphics card elsewhere, the CPU when there is no card. Parentheticals
 * and marketing suffixes go, so the phrase fits a table column.
 */
export function measuredWhere(device: ScorecardDevice): string {
  const trim = (s: string) =>
    s
      .replace(/\s*\(.*\)\s*$/, '')
      .replace(/\s+\d+-Core Processor$/i, '')
      .trim();
  const cpu = device.cpuModel ? trim(device.cpuModel).replace(/^Apple\s+/, '') : null;
  const gpu = device.gpuModel ? trim(device.gpuModel) : null;
  const fallback = hardwareSummary(device).split(' · ')[0] ?? device.label;
  if (device.platform === 'darwin') return cpu ?? fallback;
  return gpu ?? cpu ?? fallback;
}

/** Short suite words for a narrow column. */
export const MEASURED_SUITE_WORDS: Readonly<Record<string, string>> = {
  core: 'general',
  productivity: 'office',
  developer: 'engineering',
  'complex-work': 'workflows',
};

/**
 * Every published row for a model (and its sibling quantizations), newest
 * first, for a model page or `gezel doctor`. Subset rounds are included and
 * labelled by the caller through `run.scope`; results the scorecard withholds
 * are not.
 */
export function measuredRowsFor(dataset: ScorecardDataset, modelId: string): MeasuredResult[] {
  const runs = new Map(dataset.runs.map((run) => [run.id, run]));
  return dataset.results
    .filter((result) => isPassRateResult(result) && matches(result, modelId, false))
    .map((result): MeasuredResult | null => {
      const run = runs.get(result.runId);
      if (!run) return null;
      const score = scoreModel(result, run.provenance.count);
      if (!isPublishable(score)) return null;
      return { result, run, score, sameHardwareClass: false };
    })
    .filter((r): r is MeasuredResult => r !== null)
    .sort((a, b) => b.run.provenance.startedAt.localeCompare(a.run.provenance.startedAt));
}
