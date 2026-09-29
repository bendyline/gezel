import { formatPassClaim, scoreModel } from '../scorecard/report.js';
import type { ScorecardCell } from '../scorecard/schema.js';
import type { EvalTrialSummary } from './schemas.js';

/**
 * Local eval results, scored by the published scorecard's rules.
 *
 * The in-app Benchmarks matrix and the handboek scorecard must never
 * disagree about what a number means, so this module builds scorecard cells
 * from indexed trials and hands them to `scoreModel` / `formatPassClaim`
 * rather than re-deriving a pass rate. Two rules carry over unchanged:
 * non-model failures (infra, operator, grader) leave both numerator and
 * denominator, and a cell below MIN_TRIALS_FOR_RATE is a count, not a rate.
 */

/** Failure classes that say nothing about the model under test. */
export const NON_MODEL_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'infra',
  'operator',
  'grader',
]);

export function isNonModelFailure(trial: Pick<EvalTrialSummary, 'success' | 'failureClass'>) {
  return trial.success === false && NON_MODEL_FAILURE_CLASSES.has(trial.failureClass ?? '');
}

/**
 * Stable identity for "what was measured": provider, model, and — when a run
 * pinned one — the generalist-mode arm. Two arms of an A/B are different
 * experiments on the same model, and one column would average them away.
 */
export function evalTargetKey(
  trial: Pick<EvalTrialSummary, 'provider' | 'modelId' | 'generalistMode'>,
): string {
  const arm = trial.generalistMode ? `:generalist-${trial.generalistMode}` : '';
  return `${trial.provider ?? 'unknown'}:${trial.modelId}${arm}`;
}

export interface EvalMatrixCell extends ScorecardCell {
  /** Trials still in flight; never counted until they finish. */
  running: number;
  /** Rendered, always safe to print: a count below n=3, a rate above. */
  claim: string;
  /** Median fixed-rubric composite over finished trials that were scored. */
  medianComposite?: number;
  /** Newest trial in the cell, for drill-down. */
  latest?: EvalTrialSummary;
}

export interface EvalMatrixColumn {
  key: string;
  provider?: string;
  modelId: string;
  /** The generalist-mode arm, when the run pinned one. */
  generalistMode?: string;
  attributableTrials: number;
  successes: number;
  /** Trials thrown out as infra/operator/grader failures. */
  discardedTrials: number;
  /** null when the weakest cell is too thin to quote a rate. */
  passRate: number | null;
  claim: string;
}

export interface EvalMatrix {
  scenarioIds: string[];
  columns: EvalMatrixColumn[];
  cell(scenarioId: string, columnKey: string): EvalMatrixCell | undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Aggregate trials into scenario × (provider, model) cells.
 *
 * `scenarioOrder` pins row order (a suite's run order); scenarios outside it
 * follow alphabetically so nothing measured is ever hidden.
 */
export function buildEvalMatrix(
  trials: readonly EvalTrialSummary[],
  opts: { scenarioOrder?: readonly string[] } = {},
): EvalMatrix {
  interface Acc {
    finished: EvalTrialSummary[];
    running: number;
    latest?: EvalTrialSummary;
  }
  const accs = new Map<string, Map<string, Acc>>();
  const columnMeta = new Map<
    string,
    { provider?: string; modelId: string; generalistMode?: string }
  >();
  const scenarioSet = new Set<string>();

  for (const trial of trials) {
    const columnKey = evalTargetKey(trial);
    if (!columnMeta.has(columnKey)) {
      columnMeta.set(columnKey, {
        ...(trial.provider ? { provider: trial.provider } : {}),
        modelId: trial.modelId,
        ...(trial.generalistMode ? { generalistMode: trial.generalistMode } : {}),
      });
    }
    scenarioSet.add(trial.scenarioId);
    let byColumn = accs.get(trial.scenarioId);
    if (!byColumn) {
      byColumn = new Map();
      accs.set(trial.scenarioId, byColumn);
    }
    let acc = byColumn.get(columnKey);
    if (!acc) {
      acc = { finished: [], running: 0 };
      byColumn.set(columnKey, acc);
    }
    if (trial.running) acc.running += 1;
    // Cut short with no verdict (a stopped job): it measured nothing.
    else if (trial.success !== undefined) acc.finished.push(trial);
    if (!acc.latest || trial.startedAt > acc.latest.startedAt) acc.latest = trial;
  }

  const cells = new Map<string, EvalMatrixCell>();
  const cellsByColumn = new Map<string, ScorecardCell[]>();
  for (const [scenarioId, byColumn] of accs) {
    for (const [columnKey, acc] of byColumn) {
      const successes = acc.finished.filter((t) => t.success === true).length;
      const nonModelFailures = acc.finished.filter(isNonModelFailure).length;
      const durations = acc.finished
        .map((t) => t.durationMs)
        .filter((d): d is number => typeof d === 'number');
      const scorecardCell: ScorecardCell = {
        scenarioId,
        trials: acc.finished.length,
        successes,
        nonModelFailures,
        ...(durations.length > 0 ? { medianDurationMs: median(durations) } : {}),
      };
      const medianComposite = median(
        acc.finished.map((t) => t.composite).filter((c): c is number => typeof c === 'number'),
      );
      cells.set(`${scenarioId}\u0000${columnKey}`, {
        ...scorecardCell,
        running: acc.running,
        claim: formatPassClaim(successes, acc.finished.length - nonModelFailures),
        ...(medianComposite !== undefined ? { medianComposite } : {}),
        ...(acc.latest ? { latest: acc.latest } : {}),
      });
      const list = cellsByColumn.get(columnKey) ?? [];
      list.push(scorecardCell);
      cellsByColumn.set(columnKey, list);
    }
  }

  const columns: EvalMatrixColumn[] = [...columnMeta.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, meta]) => {
      const score = scoreModel({
        modelId: meta.modelId,
        label: meta.modelId,
        engine: meta.provider ?? 'unknown',
        tier: 'unknown',
        runId: 'local',
        suiteId: 'local',
        cells: cellsByColumn.get(key) ?? [],
      });
      return {
        key,
        ...meta,
        attributableTrials: score.attributableTrials,
        successes: score.successes,
        discardedTrials: score.discardedTrials,
        passRate: score.passRate,
        claim: score.claim,
      };
    });

  const pinned = (opts.scenarioOrder ?? []).filter((id) => scenarioSet.has(id));
  const pinnedSet = new Set(pinned);
  const rest = [...scenarioSet].filter((id) => !pinnedSet.has(id)).sort();

  return {
    scenarioIds: [...pinned, ...rest],
    columns,
    cell: (scenarioId, columnKey) => cells.get(`${scenarioId}\u0000${columnKey}`),
  };
}
