import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRuns } from '../RunsContext.js';
import { ArtifactGallery } from '../components/ArtifactGallery.js';
import { OutcomeBadge, ScoreBadge } from '../components/Badge.js';
import { LogTail } from '../components/LogTail.js';
import { MarkdownView } from '../components/Markdown.js';
import { MovieTab } from '../components/MovieTab.js';
import { findTrial, formatDuration } from '../data.js';

export function TrialView() {
  const runs = useRuns();
  const { trialId } = useParams<{ trialId: string }>();
  const trial = trialId ? findTrial(runs, trialId) : undefined;
  const [tab, setTab] = useState<'postmortem' | 'movie' | 'artifacts' | 'log' | 'related'>(
    'postmortem',
  );

  // Sibling trials in the same group (matrix or batch) and other trials of
  // the same (scenario, model) combo elsewhere in time.
  const related = useMemo(() => {
    if (!trial) return { siblings: [], history: [] };
    const siblings = runs.trials.filter(
      (t) => t.group === trial.group && t.trialId !== trial.trialId,
    );
    const history = runs.trials
      .filter(
        (t) =>
          t.scenarioId === trial.scenarioId &&
          t.modelId === trial.modelId &&
          t.trialId !== trial.trialId,
      )
      .slice(0, 10);
    return { siblings, history };
  }, [runs, trial]);

  if (!trial) {
    return (
      <div className="empty">
        Trial not found. <Link to="/">Back home</Link>
      </div>
    );
  }

  const postmortemUrl = `${trial.runUrl}/postmortem.md`;
  const logUrl = `${trial.runUrl}/log.txt`;
  const resultUrl = `${trial.runUrl}/result.json`;

  return (
    <div className="trialview">
      <header className="trialhead">
        <div className="trialhead-row">
          <ScoreBadge trial={trial} />
          <OutcomeBadge trial={trial} />
          <h1 className="trialid">{trial.trialId}</h1>
        </div>
        <div className="trialhead-meta">
          <span>
            <strong>Scenario:</strong>{' '}
            <Link to={`/scenario/${trial.scenarioId}`}>{trial.scenarioId}</Link>
          </span>
          <span>
            <strong>Model:</strong> {trial.modelId ?? '—'}
          </span>
          <span>
            <strong>Duration:</strong> {formatDuration(trial.durationMs)}
          </span>
          <span>
            <strong>Started:</strong>{' '}
            {trial.startedAt ? new Date(trial.startedAt).toLocaleString() : '—'}
          </span>
          <span>
            <strong>Group:</strong> {trial.group}
          </span>
          {trial.host && (
            <span>
              <strong>Host:</strong> {trial.host.cpuModel}
              {trial.host.totalRamGb ? ` · ${trial.host.totalRamGb}GB` : ''}
              {trial.host.framework ? ` · ${trial.host.framework}` : ''}
            </span>
          )}
          {trial.perf && trial.perf.peakRssMb != null && (
            <span>
              <strong>Peak RSS:</strong> {trial.perf.peakRssMb}MB
            </span>
          )}
        </div>
        {trial.reason && <p className="trialhead-reason">{trial.reason}</p>}
      </header>

      <nav className="trialtabs">
        <button
          type="button"
          className={tab === 'postmortem' ? 'active' : ''}
          onClick={() => setTab('postmortem')}
        >
          Postmortem{trial.hasPostmortem ? '' : ' (none)'}
        </button>
        {trial.hasRecording && (
          <button
            type="button"
            className={tab === 'movie' ? 'active' : ''}
            onClick={() => setTab('movie')}
          >
            Transcript
          </button>
        )}
        <button
          type="button"
          className={tab === 'artifacts' ? 'active' : ''}
          onClick={() => setTab('artifacts')}
        >
          Artifacts ({trial.artifacts.length})
        </button>
        <button
          type="button"
          className={tab === 'log' ? 'active' : ''}
          onClick={() => setTab('log')}
        >
          Log
        </button>
        <button
          type="button"
          className={tab === 'related' ? 'active' : ''}
          onClick={() => setTab('related')}
        >
          Related ({related.siblings.length + related.history.length})
        </button>
        <a className="trialtab-raw" href={trial.runUrl} target="_blank" rel="noreferrer">
          browse files →
        </a>
      </nav>

      <section className="trialbody">
        {tab === 'postmortem' &&
          (trial.hasPostmortem ? (
            <MarkdownView url={postmortemUrl} />
          ) : (
            <div className="empty">
              No postmortem.md. Run <code>score-trial.ts</code> then write one (see{' '}
              <code>.claude/skills/eval-run</code>).
            </div>
          ))}
        {tab === 'movie' && <MovieTab trial={trial} />}
        {tab === 'artifacts' && <ArtifactGallery artifacts={trial.artifacts} />}
        {tab === 'log' && (
          <div>
            <p className="logmeta">
              <a href={logUrl} target="_blank" rel="noreferrer">
                open full log
              </a>{' '}
              ·{' '}
              <a href={resultUrl} target="_blank" rel="noreferrer">
                result.json
              </a>
            </p>
            <LogTail url={logUrl} lines={300} />
          </div>
        )}
        {tab === 'related' && (
          <div>
            <h3>Sibling trials (same {trial.groupKind} run)</h3>
            {related.siblings.length === 0 ? (
              <div className="empty">No siblings.</div>
            ) : (
              <RelatedTable trials={related.siblings} />
            )}
            <h3>Same scenario × model, other runs</h3>
            {related.history.length === 0 ? (
              <div className="empty">No prior history for this scenario × model.</div>
            ) : (
              <RelatedTable trials={related.history} />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function RelatedTable({ trials }: { trials: import('../types.js').Trial[] }) {
  return (
    <table className="trials">
      <thead>
        <tr>
          <th>Score</th>
          <th>Outcome</th>
          <th>Trial</th>
          <th>Model</th>
          <th>Scenario</th>
          <th>Duration</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {trials.map((t) => (
          <tr key={t.trialId}>
            <td>
              <ScoreBadge trial={t} />
            </td>
            <td>
              <OutcomeBadge trial={t} />
            </td>
            <td>
              <Link to={`/trial/${t.trialId}`}>{t.trialId}</Link>
            </td>
            <td>{t.modelId ?? '—'}</td>
            <td>{t.scenarioId ?? '—'}</td>
            <td>{formatDuration(t.durationMs)}</td>
            <td>{t.startedAt ? new Date(t.startedAt).toLocaleString() : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
