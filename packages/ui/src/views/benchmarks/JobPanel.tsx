import type { EvalCatalog, EvalJob, EvalJobTargetProgress } from '@bendyline/gezel/eval';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { JOB_STATUS_LABELS, formatDuration, jobTitle, providerLabel } from './format.js';

const LOG_LINES = 400;

export interface JobPanelProps {
  jobs: EvalJob[];
  catalog: EvalCatalog | null;
  /** Labels for model ids the targets list knows (the installed model name). */
  modelLabel: (provider: string, modelId: string) => string;
  onJobChanged: (job: EvalJob) => void;
  onCancel: (job: EvalJob) => Promise<void>;
}

/**
 * The run in progress and anything queued behind it. Follows the running job
 * over its stream so the log and counts move live; closing Settings stops
 * watching, never the run.
 */
export function JobPanel({ jobs, catalog, modelLabel, onJobChanged, onCancel }: JobPanelProps) {
  const active = jobs.find((j) => j.status === 'running' || j.status === 'waiting-for-device');
  const queued = jobs.filter((j) => j.status === 'queued');
  if (!active && queued.length === 0) return null;
  return (
    <section className="bench-section" aria-label="Evaluation in progress">
      <h3>In progress</h3>
      {active && (
        <ActiveJob
          key={active.id}
          job={active}
          catalog={catalog}
          modelLabel={modelLabel}
          onJobChanged={onJobChanged}
          onCancel={onCancel}
        />
      )}
      {queued.length > 0 && (
        <ul className="bench-queue">
          {queued.map((job) => (
            <li key={job.id}>
              <span>
                <strong>{jobTitle(job, catalog)}</strong>
                <span className="muted small">
                  {' '}
                  · {job.targets.map((t) => modelLabel(t.provider, t.modelId)).join(', ')} ·{' '}
                  {job.spec.count} trial{job.spec.count === 1 ? '' : 's'} each
                </span>
              </span>
              <button type="button" className="subtle" onClick={() => void onCancel(job)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveJob({
  job: initial,
  catalog,
  modelLabel,
  onJobChanged,
  onCancel,
}: {
  job: EvalJob;
  catalog: EvalCatalog | null;
  modelLabel: (provider: string, modelId: string) => string;
  onJobChanged: (job: EvalJob) => void;
  onCancel: (job: EvalJob) => Promise<void>;
}) {
  const [job, setJob] = useState(initial);
  const [log, setLog] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  const onJobChangedRef = useRef(onJobChanged);
  onJobChangedRef.current = onJobChanged;

  useEffect(() => {
    const controller = new AbortController();
    void api
      .streamEvalJob(
        initial.id,
        (event) => {
          if (event.type === 'snapshot') {
            setJob(event.job);
            setLog(event.log.slice(-LOG_LINES));
          } else if (event.type === 'job') {
            setJob(event.job);
            onJobChangedRef.current(event.job);
          } else {
            setLog((prev) => [...prev, event.line].slice(-LOG_LINES));
          }
        },
        controller.signal,
      )
      .catch(() => {
        // The job keeps running; the list poll picks up where the stream stopped.
      });
    return () => controller.abort();
  }, [initial.id]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current && log.length > 0) el.scrollTop = el.scrollHeight;
  }, [log]);

  const stop = async () => {
    setStopping(true);
    try {
      await onCancel(job);
    } finally {
      setStopping(false);
    }
  };

  const startedAt = job.startedAt ? Date.parse(job.startedAt) : undefined;
  return (
    <div className="bench-job">
      <div className="bench-job-header">
        <div>
          <strong>{jobTitle(job, catalog)}</strong>
          <span className="muted small">
            {' '}
            · {job.spec.count} trial{job.spec.count === 1 ? '' : 's'} per scenario
            {startedAt ? ` · started ${formatDuration(now - startedAt)} ago` : ''}
          </span>
        </div>
        <span
          className={`gz-status-pill ${job.status === 'running' ? 'gz-status-pill--ok' : 'gz-status-pill--info'}`}
        >
          {JOB_STATUS_LABELS[job.status]}
        </span>
      </div>
      {job.status === 'waiting-for-device' && (
        <p className="muted small">
          Waiting for {job.waitingOn ?? 'another eval'} to finish with this computer's engines. It
          starts on its own when the device is free.
        </p>
      )}
      <ul className="bench-targets">
        {job.targets.map((target) => (
          <TargetProgress
            key={target.runDir}
            target={target}
            label={modelLabel(target.provider, target.modelId)}
            now={now}
          />
        ))}
      </ul>
      <details className="bench-disclosure">
        <summary>Live log</summary>
        <pre
          ref={logRef}
          className="bench-log"
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {log.length > 0 ? log.join('\n') : 'Waiting for output…'}
        </pre>
      </details>
      <div className="bench-actions">
        <button type="button" onClick={() => void stop()} disabled={stopping}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
        <span className="muted small">
          Stopping finishes the current trial's cleanup; finished trials keep their results.
        </span>
      </div>
    </div>
  );
}

function TargetProgress({
  target,
  label,
  now,
}: {
  target: EvalJobTargetProgress;
  label: string;
  now: number;
}) {
  const planned = target.plannedTrials;
  const pct = planned ? Math.min(100, Math.round((target.completedTrials / planned) * 100)) : 0;
  const current = target.currentTrial;
  return (
    <li className={`bench-target bench-target--${target.status}`}>
      <div className="bench-target-line">
        <span>
          <strong>{label}</strong>
          <span className="muted small"> · {providerLabel(target.provider)}</span>
        </span>
        <span className="small bench-numeric">
          {target.status === 'pending'
            ? 'Up next'
            : planned !== undefined
              ? `${target.completedTrials} of ${planned} trials · ${target.passedTrials} passed`
              : target.status === 'running'
                ? 'Preparing…'
                : ''}
        </span>
      </div>
      {planned !== undefined && target.status !== 'pending' && (
        <progress
          className="bench-progress"
          max={planned || 1}
          value={target.completedTrials}
          aria-label={`${label}: ${pct}% of trials finished`}
        />
      )}
      {current && (
        <p className="muted small bench-target-current">
          Now running <code>{current.scenarioId}</code> — trial {current.trialIndex}
          {planned ? ` of ${planned}` : ''}, {formatDuration(now - Date.parse(current.startedAt))}
        </p>
      )}
      {target.preflight?.decodeTokensPerSec !== undefined && (
        <p className="muted small">
          Preflight measured {target.preflight.decodeTokensPerSec.toFixed(1)} tokens/s; time limits
          are scaled to it.
        </p>
      )}
      {target.error && <p className="error small">{target.error}</p>}
    </li>
  );
}
