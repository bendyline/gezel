import type { EvalTrialSummary } from '@bendyline/gezel/eval';
import { useMemo, useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../../relative-time.js';
import {
  OUTCOME_LABELS,
  type TrialOutcome,
  formatDuration,
  providerLabel,
  targetKey,
  trialOutcome,
} from './format.js';

const PAGE = 100;

export interface TrialsTableProps {
  trials: EvalTrialSummary[];
  modelLabel: (provider: string, modelId: string) => string;
  /** Narrow to one job (from the Runs list); cleared by the caller. */
  jobFilter: { id: string; title: string } | null;
  onClearJobFilter: () => void;
  onOpenTrial: (trialId: string) => void;
}

export function TrialsTable({
  trials,
  modelLabel,
  jobFilter,
  onClearJobFilter,
  onOpenTrial,
}: TrialsTableProps) {
  const [scenario, setScenario] = useState('');
  const [model, setModel] = useState('');
  const [outcome, setOutcome] = useState<'' | TrialOutcome>('');
  const [shown, setShown] = useState(PAGE);

  const scenarios = useMemo(() => [...new Set(trials.map((t) => t.scenarioId))].sort(), [trials]);
  const models = useMemo(() => {
    const seen = new Map<string, EvalTrialSummary>();
    for (const t of trials) if (!seen.has(targetKey(t))) seen.set(targetKey(t), t);
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [trials]);

  const filtered = trials.filter(
    (t) =>
      (!jobFilter || t.jobId === jobFilter.id) &&
      (!scenario || t.scenarioId === scenario) &&
      (!model || targetKey(t) === model) &&
      (!outcome || trialOutcome(t) === outcome),
  );

  if (trials.length === 0) {
    return <p className="muted small">No trials yet.</p>;
  }

  return (
    <div>
      <div className="bench-results-toolbar">
        {jobFilter && (
          <span className="bench-filter-chip">
            Run: {jobFilter.title}
            <button type="button" className="link-button" onClick={onClearJobFilter}>
              Show all runs
            </button>
          </span>
        )}
        <select
          aria-label="Scenario"
          value={scenario}
          onChange={(e) => setScenario(e.currentTarget.value)}
        >
          <option value="">All scenarios</option>
          {scenarios.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select aria-label="Model" value={model} onChange={(e) => setModel(e.currentTarget.value)}>
          <option value="">All models</option>
          {models.map(([key, t]) => (
            <option key={key} value={key}>
              {modelLabel(t.provider ?? '', t.modelId)} ({providerLabel(t.provider)})
            </option>
          ))}
        </select>
        <select
          aria-label="Outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.currentTarget.value as '' | TrialOutcome)}
        >
          <option value="">Any outcome</option>
          {(Object.keys(OUTCOME_LABELS) as TrialOutcome[]).map((key) => (
            <option key={key} value={key}>
              {OUTCOME_LABELS[key]}
            </option>
          ))}
        </select>
        <span className="muted small">
          {filtered.length} trial{filtered.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="bench-table-scroll">
        <table className="bench-table">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">Model</th>
              <th scope="col">Outcome</th>
              <th scope="col" className="bench-numeric">
                Score
              </th>
              <th scope="col" className="bench-numeric">
                Time
              </th>
              <th scope="col" className="bench-numeric">
                Speed
              </th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, shown).map((t) => {
              const result = trialOutcome(t);
              return (
                <tr key={t.trialId}>
                  <th scope="row">
                    <button
                      type="button"
                      className="bench-row-link"
                      onClick={() => onOpenTrial(t.trialId)}
                    >
                      <code>{t.scenarioId}</code>
                    </button>
                  </th>
                  <td>
                    {modelLabel(t.provider ?? '', t.modelId)}
                    <span className="muted small"> · {providerLabel(t.provider)}</span>
                  </td>
                  <td>
                    <OutcomePill outcome={result} />
                  </td>
                  <td className="bench-numeric">
                    {t.composite !== undefined ? t.composite.toFixed(1) : '—'}
                  </td>
                  <td className="bench-numeric">{formatDuration(t.durationMs)}</td>
                  <td className="bench-numeric">
                    {t.decodeTokensPerSec !== undefined
                      ? `${t.decodeTokensPerSec.toFixed(1)} tok/s`
                      : '—'}
                  </td>
                  <td title={formatAbsoluteTime(t.startedAt)}>{formatRelativeTime(t.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > shown && (
        <button type="button" className="link-button" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, filtered.length - shown)} more
        </button>
      )}
    </div>
  );
}

export function OutcomePill({ outcome }: { outcome: TrialOutcome }) {
  const tone =
    outcome === 'passed'
      ? 'gz-status-pill--ok'
      : outcome === 'failed'
        ? 'bench-pill--fail'
        : 'gz-status-pill--info';
  return <span className={`gz-status-pill ${tone}`}>{OUTCOME_LABELS[outcome]}</span>;
}
