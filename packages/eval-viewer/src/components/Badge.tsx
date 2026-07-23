import { bandColor } from '../data.js';
import type { Trial } from '../types.js';

export function ScoreBadge({ trial }: { trial: Trial }) {
  if (trial.composite == null) {
    return (
      <span className="badge badge-unscored" title="No postmortem.md found in this trial dir">
        unscored
      </span>
    );
  }
  return (
    <span
      className="badge"
      style={{ background: bandColor(trial.band), color: 'white' }}
      title={`band: ${trial.band ?? '—'}`}
    >
      {trial.composite.toFixed(1)}
    </span>
  );
}

export function OutcomeBadge({ trial }: { trial: Trial }) {
  if (trial.running) {
    return (
      <span className="pill pill-running" title="Trial in flight">
        ● running
      </span>
    );
  }
  if (trial.success) return <span className="pill pill-pass">PASS</span>;
  return <span className="pill pill-fail">{trial.failureMode ?? 'FAIL'}</span>;
}
