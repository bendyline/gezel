import { Link } from 'react-router-dom';
import { useNow } from '../RunsContext.js';
import { formatDuration } from '../data.js';
import type { Trial } from '../types.js';
import { OutcomeBadge, ScoreBadge } from './Badge.js';

export function TrialRow({ trial }: { trial: Trial }) {
  const when = trial.startedAt ? new Date(trial.startedAt).toLocaleString() : '—';
  return (
    <tr className={trial.running ? 'row-running' : undefined}>
      <td className="cell-score">
        <ScoreBadge trial={trial} />
      </td>
      <td className="cell-outcome">
        <OutcomeBadge trial={trial} />
      </td>
      <td>
        <Link to={`/trial/${trial.trialId}`} className="trialid">
          {trial.trialId}
        </Link>
      </td>
      <td>{trial.scenarioId ?? '—'}</td>
      <td className="cell-model">{trial.modelId ?? '—'}</td>
      <td className="cell-duration">
        {trial.running ? (
          <LiveElapsed startedAt={trial.startedAt} />
        ) : (
          formatDuration(trial.durationMs)
        )}
      </td>
      <td className="cell-when">{when}</td>
      <td className="cell-group">
        <span title={trial.group}>{trial.groupKind}</span>
      </td>
    </tr>
  );
}

// Ticking elapsed time for an in-flight trial. Owns its own 1s clock so
// only running rows re-render each second, never the whole table.
function LiveElapsed({ startedAt }: { startedAt: string | null }) {
  const now = useNow();
  if (!startedAt) return <>—</>;
  return <span className="live-elapsed">{formatDuration(now - Date.parse(startedAt))}</span>;
}
