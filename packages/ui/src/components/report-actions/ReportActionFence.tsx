import type { ReportActionView } from '@bendyline/gezel';
import { parseReportActionBlock } from '@bendyline/gezel';
import type { FenceRenderContext, FenceRendererMap } from '@bendyline/squisq/fence';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { GitDiffView } from '../github/GitDiffView.js';
import { parseUnifiedDiff } from '../github/diffModel.js';
import {
  readReportActions,
  refreshReportActions,
  subscribeReportActions,
} from './reportActionsStore.js';

/**
 * The `gezel-action` fence renderer — report recommendations rendered as
 * fireable cards wherever squisq renders markdown (chat references rail,
 * report panels, and live inside the artifacts WYSIWYG editor).
 *
 * Each card parses its OWN fence body and matches the server overlay by
 * resolved action id — no fence-index alignment to break. The overlay is
 * shared through a module store because editor-hosted cards live in
 * separate React roots where context can't reach.
 */
export function makeReportActionFenceRenderers(args: {
  projectId: string;
  reportPath: string;
}): FenceRendererMap {
  const { projectId, reportPath } = args;
  return {
    'gezel-action': (ctx: FenceRenderContext) => (
      <ReportActionCard projectId={projectId} reportPath={reportPath} body={ctx.value} />
    ),
  };
}

function ReportActionCard({
  projectId,
  reportPath,
  body,
}: {
  projectId: string;
  reportPath: string;
  body: string;
}) {
  const parsed = useMemo(() => parseReportActionBlock(body, 0), [body]);
  const [, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(
    () => subscribeReportActions(projectId, reportPath, () => setVersion((v) => v + 1)),
    [projectId, reportPath],
  );

  const overlay = readReportActions(projectId, reportPath);
  const view: ReportActionView | undefined =
    parsed.ok && overlay.data
      ? overlay.data.actions.find((a) => a.id === parsed.action.id)
      : undefined;

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        await refreshReportActions(projectId, reportPath);
      } catch (err) {
        setActionError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [projectId, reportPath],
  );

  if (!parsed.ok) {
    return (
      <div className="report-action-card report-action-card-invalid">
        <div className="report-action-title">Unreadable action block</div>
        <p className="muted small report-action-reason">{parsed.issue.message}</p>
        <button type="button" className="subtle small" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? 'Hide raw block' : 'Show raw block'}
        </button>
        {showRaw && <pre className="report-action-raw">{parsed.issue.raw}</pre>}
      </div>
    );
  }

  const action = parsed.action;
  const state = view?.state ?? 'suggested';
  const kindLabel =
    action.kind === 'fire-craftbook'
      ? `Craftbook: ${action.craftbookId}`
      : action.kind === 'create-task'
        ? `Delegate task${action.role ? ` — ${action.role}` : ''}`
        : `Apply ${action.edits.length} file edit${action.edits.length === 1 ? '' : 's'}`;
  const target = action.projectId && action.projectId !== projectId ? action.projectId : null;
  const fireLabel = action.kind === 'apply-edits' ? 'Apply edits' : 'Fire';

  if (state === 'dismissed') {
    return (
      <div className="report-action-card report-action-card-dismissed">
        <span className="report-action-title">{action.title}</span>
        <span className="muted small">Dismissed.</span>
        <button
          type="button"
          className="subtle small"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api.fireReportAction(projectId, { path: reportPath, actionId: action.id }),
            )
          }
        >
          {fireLabel} anyway
        </button>
      </div>
    );
  }

  return (
    <div className={`report-action-card report-action-card-${state}`}>
      <div className="report-action-head">
        <span className="report-action-kind">{kindLabel}</span>
        {target && <span className="report-action-target">→ project {target}</span>}
        {view?.contentChanged && (
          <span className="report-action-changed" title="This block changed since you acted on it">
            changed
          </span>
        )}
      </div>
      <div className="report-action-title">{action.title}</div>
      {action.reason && <p className="muted small report-action-reason">{action.reason}</p>}

      {action.kind === 'apply-edits' && (
        <div className="report-action-edits">
          {action.edits.map((edit) => (
            <EditDiffRow
              key={`${edit.path}:${edit.diffArtifact}`}
              reportProjectId={projectId}
              edit={edit}
              result={view?.results?.find((r) => r.path === edit.path)}
            />
          ))}
        </div>
      )}

      {state === 'fired' && view?.taskRef && (
        <button
          type="button"
          className="report-action-task-chip"
          onClick={() => {
            const parsedRef = /^(.+)\/(\d+)$/.exec(view.taskRef ?? '');
            window.dispatchEvent(
              new CustomEvent('gezel:open-tab', {
                detail: { kind: 'task', ref: view.taskRef, projectId: parsedRef?.[1] },
              }),
            );
          }}
        >
          {view.outcome === 'complete'
            ? `Task finished — ${view.taskRef}`
            : view.outcome === 'canceled'
              ? `Task canceled — ${view.taskRef}`
              : `Task running — ${view.taskRef}`}
        </button>
      )}
      {state === 'applied' && <p className="small report-action-applied">Edits applied.</p>}
      {state === 'failed' && (
        <p className="error small">Apply failed — see per-file results above.</p>
      )}

      {actionError && <p className="error small">{actionError}</p>}
      {overlay.error && !view && (
        <p className="muted small">Actions unavailable: {overlay.error}</p>
      )}

      {(state === 'suggested' || state === 'failed' || view?.contentChanged) && (
        <div className="report-action-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                api.fireReportAction(projectId, { path: reportPath, actionId: action.id }),
              )
            }
          >
            {busy ? 'Working…' : fireLabel}
          </button>
          {state === 'suggested' && (
            <button
              type="button"
              className="subtle small"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.dismissReportAction(projectId, { path: reportPath, actionId: action.id }),
                )
              }
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One proposed edit: target path, collapsed diff (always viewable before Apply). */
function EditDiffRow({
  reportProjectId,
  edit,
  result,
}: {
  reportProjectId: string;
  edit: { path: string; diffArtifact: string };
  result?: { path: string; ok: boolean; error?: string };
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || diff !== null || error !== null) return;
    api
      .readProjectArtifact(reportProjectId, edit.diffArtifact)
      .then((res) => setDiff(res.content))
      .catch((err) => setError((err as Error).message));
  }, [open, diff, error, reportProjectId, edit.diffArtifact]);

  const stats = useMemo(() => {
    if (!diff) return null;
    const parsed = parseUnifiedDiff(diff);
    return { additions: parsed.additions, deletions: parsed.deletions };
  }, [diff]);

  return (
    <div className="report-action-edit">
      <button
        type="button"
        className="report-action-edit-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <code>{edit.path}</code>
        {stats && (
          <span className="report-action-edit-stats">
            +{stats.additions} −{stats.deletions}
          </span>
        )}
        {result && (
          <span className={result.ok ? 'report-action-edit-ok' : 'report-action-edit-err'}>
            {result.ok
              ? result.error === 'no-op'
                ? 'no-op'
                : 'applied'
              : (result.error ?? 'failed')}
          </span>
        )}
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="report-action-edit-diff">
          {error && <p className="error small">{error}</p>}
          {diff !== null && <GitDiffView diff={diff} />}
          {diff === null && !error && <p className="muted small">Loading diff…</p>}
        </div>
      )}
    </div>
  );
}
