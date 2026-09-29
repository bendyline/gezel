import {
  type EvalCatalog,
  type EvalMatrixCell,
  type EvalTrialSummary,
  buildEvalMatrix,
} from '@bendyline/gezel/eval';
import { useMemo, useState } from 'react';
import { providerLabel } from './format.js';

export interface ResultsMatrixProps {
  trials: EvalTrialSummary[];
  catalog: EvalCatalog | null;
  modelLabel: (provider: string, modelId: string) => string;
  onOpenTrial: (trialId: string) => void;
}

/**
 * Scenarios down, models across, scored exactly like the published model
 * scorecard: failures that were not the model's fault leave the fraction,
 * and fewer than three trials is a count, never a rate. A blank cell is
 * information too — it was not measured.
 */
export function ResultsMatrix({ trials, catalog, modelLabel, onOpenTrial }: ResultsMatrixProps) {
  const suitesWithResults = useMemo(() => {
    if (!catalog) return [];
    const measured = new Set(trials.map((t) => t.scenarioId));
    return catalog.suites.filter((s) => s.scenarioIds.some((id) => measured.has(id)));
  }, [catalog, trials]);
  const [suiteId, setSuiteId] = useState<string>('');
  const suite = suitesWithResults.find((s) => s.id === suiteId);

  const matrix = useMemo(() => {
    const members = suite ? new Set(suite.scenarioIds) : null;
    const scoped = members ? trials.filter((t) => members.has(t.scenarioId)) : trials;
    return buildEvalMatrix(scoped, suite ? { scenarioOrder: suite.scenarioIds } : {});
  }, [trials, suite]);

  if (trials.length === 0) {
    return <p className="muted small">No results yet. Finished trials appear here.</p>;
  }

  return (
    <div className="bench-matrix-wrap">
      <div className="bench-results-toolbar">
        <select
          aria-label="Suite"
          value={suiteId}
          onChange={(e) => setSuiteId(e.currentTarget.value)}
        >
          <option value="">Every scenario measured</option>
          {suitesWithResults.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} suite
            </option>
          ))}
        </select>
        {suite && (
          <span className="muted small">
            {matrix.scenarioIds.length} of {suite.scenarioIds.length} scenarios measured
          </span>
        )}
      </div>
      <div className="bench-table-scroll">
        <table className="bench-table bench-matrix">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              {matrix.columns.map((column) => (
                <th key={column.key} scope="col">
                  <span className="bench-matrix-model">
                    {modelLabel(column.provider ?? '', column.modelId)}
                  </span>
                  <span className="bench-matrix-engine">
                    {providerLabel(column.provider)}
                    {column.generalistMode ? ` · generalist ${column.generalistMode}` : ''}
                  </span>
                  <span className={`bench-claim ${toneFor(column.passRate)}`}>{column.claim}</span>
                  {column.discardedTrials > 0 && (
                    <span className="bench-matrix-engine">
                      {column.discardedTrials} not counted
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.scenarioIds.map((scenarioId) => (
              <tr key={scenarioId}>
                <th scope="row">
                  <code>{scenarioId}</code>
                </th>
                {matrix.columns.map((column) => (
                  <td key={column.key}>
                    <MatrixCell
                      cell={matrix.cell(scenarioId, column.key)}
                      onOpenTrial={onOpenTrial}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Rates leave out trials that failed for reasons other than the model — an engine crash, a
        grader this computer could not run, a stopped run — the same rules as the published model
        scorecard. With fewer than three trials a cell shows a count, not a rate. Select a cell for
        its latest trial.
      </p>
    </div>
  );
}

function toneFor(rate: number | null): string {
  if (rate === null) return 'bench-tone-neutral';
  if (rate >= 0.75) return 'bench-tone-good';
  if (rate >= 0.5) return 'bench-tone-mid';
  return 'bench-tone-poor';
}

function MatrixCell({
  cell,
  onOpenTrial,
}: {
  cell: EvalMatrixCell | undefined;
  onOpenTrial: (trialId: string) => void;
}) {
  if (!cell) return <span className="muted">—</span>;
  const attributable = cell.trials - cell.nonModelFailures;
  const rate =
    attributable >= 3 ? cell.successes / attributable : attributable > 0 ? null : undefined;
  const latest = cell.latest;
  const label = [
    cell.claim,
    cell.nonModelFailures > 0 ? `${cell.nonModelFailures} not counted` : '',
    cell.running > 0 ? `${cell.running} running` : '',
    cell.medianComposite !== undefined ? `median score ${cell.medianComposite.toFixed(1)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const body = (
    <>
      <span className={`bench-claim ${rate === undefined ? 'bench-tone-neutral' : toneFor(rate)}`}>
        {attributable > 0 ? `${cell.successes}/${attributable}` : cell.running > 0 ? '…' : '—'}
      </span>
      {cell.medianComposite !== undefined && (
        <span className="bench-cell-score">{cell.medianComposite.toFixed(1)}</span>
      )}
      {cell.running > 0 && <span className="bench-cell-running">running</span>}
    </>
  );
  return latest ? (
    <button
      type="button"
      className="bench-cell"
      title={label}
      aria-label={label}
      onClick={() => onOpenTrial(latest.trialId)}
    >
      {body}
    </button>
  ) : (
    <span className="bench-cell" title={label}>
      {body}
    </span>
  );
}
