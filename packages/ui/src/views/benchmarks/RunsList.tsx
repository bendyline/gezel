import type { EvalCatalog, EvalJob } from '@bendyline/gezel/eval';
import { formatAbsoluteTime, formatRelativeTime } from '../../relative-time.js';
import { JOB_STATUS_LABELS, isJobActive, jobTitle } from './format.js';

export interface RunsListProps {
  jobs: EvalJob[];
  catalog: EvalCatalog | null;
  modelLabel: (provider: string, modelId: string) => string;
  onShowTrials: (job: EvalJob) => void;
  onCancel: (job: EvalJob) => Promise<void>;
}

/** Every in-app run, newest first, with what it asked for and how it ended. */
export function RunsList({ jobs, catalog, modelLabel, onShowTrials, onCancel }: RunsListProps) {
  if (jobs.length === 0) {
    return <p className="muted small">No runs yet.</p>;
  }
  const openPath = window.__GEZEL__?.openPath;
  return (
    <ul className="bench-runs">
      {jobs.map((job) => (
        <li key={job.id} className="bench-run">
          <div className="bench-run-line">
            <span>
              <strong>{jobTitle(job, catalog)}</strong>
              <span className="muted small">
                {' '}
                · {job.spec.count} trial{job.spec.count === 1 ? '' : 's'} per scenario ·{' '}
                <span title={formatAbsoluteTime(job.createdAt)}>
                  {formatRelativeTime(job.createdAt)}
                </span>
              </span>
            </span>
            <span
              className={`gz-status-pill ${
                job.status === 'completed'
                  ? 'gz-status-pill--ok'
                  : job.status === 'failed'
                    ? 'gz-status-pill--warn'
                    : 'gz-status-pill--info'
              }`}
            >
              {JOB_STATUS_LABELS[job.status]}
            </span>
          </div>
          <ul className="bench-run-targets">
            {job.targets.map((target) => (
              <li key={target.runDir}>
                {modelLabel(target.provider, target.modelId)}
                <span className="muted small">
                  {' — '}
                  {target.error
                    ? target.error
                    : target.completedTrials > 0
                      ? `${target.passedTrials} of ${target.completedTrials} passed`
                      : target.status === 'pending'
                        ? 'not started'
                        : 'no trials finished'}
                </span>
              </li>
            ))}
          </ul>
          {job.error && <p className="error small">{job.error}</p>}
          <div className="bench-run-actions">
            <button type="button" className="link-button" onClick={() => onShowTrials(job)}>
              Show its trials
            </button>
            {isJobActive(job) && (
              <button type="button" className="link-button" onClick={() => void onCancel(job)}>
                Stop
              </button>
            )}
            {openPath && (
              <button type="button" className="link-button" onClick={() => void openPath(job.dir)}>
                Open folder
              </button>
            )}
            {job.harness === 'source' && (
              <span className="muted small">Ran the harness from this source checkout</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
