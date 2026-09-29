import type { EvalTrialDetail } from '@bendyline/gezel/eval';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { MarkdownField } from '../../components/MarkdownField.js';
import { Dialog } from '../../primitives/index.js';
import { formatAbsoluteTime } from '../../relative-time.js';
import { OutcomePill } from './TrialsTable.js';
import {
  BAND_LABELS,
  FAILURE_CLASS_EXPLANATIONS,
  formatDuration,
  providerLabel,
  trialOutcome,
} from './format.js';

const noop = () => {};

const AXES = [
  ['completion', 'Task completion', '40%'],
  ['quality', 'Output quality', '25%'],
  ['efficiency', 'Process efficiency', '20%'],
  ['behavior', 'Behavior', '15%'],
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TrialDetailDialog({
  trialId,
  modelLabel,
  onClose,
}: {
  trialId: string | null;
  modelLabel: (provider: string, modelId: string) => string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<EvalTrialDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!trialId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .getEvalTrial(trialId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [trialId]);

  const trial = detail?.trial;
  const openPath = window.__GEZEL__?.openPath;
  return (
    <Dialog.Root open={trialId !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gz-dialog-wide bench-detail">
          <Dialog.Title asChild>
            <h3>
              <code>{trial?.scenarioId ?? 'Trial'}</code>
            </h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            {trial
              ? `${modelLabel(trial.provider ?? '', trial.modelId)} on ${providerLabel(trial.provider)} · ${formatAbsoluteTime(trial.startedAt)}`
              : 'Loading…'}
          </Dialog.Description>
          {error && <p className="error small">{error}</p>}
          {trial && detail && (
            <div className="bench-detail-body">
              <div className="bench-detail-verdict">
                <OutcomePill outcome={trialOutcome(trial)} />
                {trial.failureClass && FAILURE_CLASS_EXPLANATIONS[trial.failureClass] && (
                  <span className="muted small">
                    {FAILURE_CLASS_EXPLANATIONS[trial.failureClass]}
                  </span>
                )}
              </div>
              {trial.reason && <p className="bench-detail-reason">{trial.reason}</p>}
              {detail.failureClassEvidence && (
                <p className="muted small">Evidence: {detail.failureClassEvidence}</p>
              )}

              <dl className="bench-facts">
                <dt>Time</dt>
                <dd>{formatDuration(trial.durationMs)}</dd>
                {trial.decodeTokensPerSec !== undefined && (
                  <>
                    <dt>Speed</dt>
                    <dd>{trial.decodeTokensPerSec.toFixed(1)} tokens/s</dd>
                  </>
                )}
                {trial.modelTier && (
                  <>
                    <dt>Model size class</dt>
                    <dd>{trial.modelTier}</dd>
                  </>
                )}
                {trial.generalistMode && (
                  <>
                    <dt>Generalist mode</dt>
                    <dd>{trial.generalistMode}</dd>
                  </>
                )}
              </dl>

              {detail.rubric && trial.composite !== undefined && (
                <section>
                  <h4>
                    Score {trial.composite.toFixed(1)} / 10
                    {trial.band && (
                      <span className="muted small">
                        {' '}
                        · {BAND_LABELS[trial.band] ?? trial.band}
                      </span>
                    )}
                  </h4>
                  <table className="bench-table bench-rubric">
                    <tbody>
                      {AXES.map(([key, label, weight]) => (
                        <tr key={key}>
                          <th scope="row">
                            {label} <span className="muted small">{weight}</span>
                          </th>
                          <td className="bench-numeric">{detail.rubric?.[key].score}</td>
                          <td className="small">{detail.rubric?.[key].summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!detail.rubric.includedInModelAggregate && (
                    <p className="muted small">
                      This trial is left out of the model's aggregate because it failed for a reason
                      other than the model.
                    </p>
                  )}
                </section>
              )}

              {detail.postmortemMarkdown && (
                <details className="bench-disclosure">
                  <summary>Postmortem</summary>
                  <MarkdownField
                    value={detail.postmortemMarkdown}
                    readOnly
                    minHeight="0"
                    maxHeight="50vh"
                    onCommit={noop}
                  />
                </details>
              )}

              {detail.artifacts.length > 0 && (
                <details className="bench-disclosure">
                  <summary>
                    What it produced ({detail.artifacts.length} file
                    {detail.artifacts.length === 1 ? '' : 's'})
                  </summary>
                  <ul className="storage-list">
                    {detail.artifacts.map((a) => (
                      <li key={a.path}>
                        <span className="storage-list-label">
                          <code>{a.path}</code>
                        </span>
                        <span className="storage-list-bytes">{formatBytes(a.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {detail.logTail.length > 0 && (
                <details className="bench-disclosure">
                  <summary>Trial log (last {detail.logTail.length} lines)</summary>
                  <pre className="bench-log">{detail.logTail.join('\n')}</pre>
                </details>
              )}

              <p className="muted small bench-detail-path">
                <code>{trial.runDir}</code>
              </p>
            </div>
          )}
          <Dialog.Actions>
            {trial && openPath && (
              <button type="button" className="subtle" onClick={() => void openPath(trial.runDir)}>
                Open folder
              </button>
            )}
            <Dialog.Close asChild>
              <button type="button">Close</button>
            </Dialog.Close>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
