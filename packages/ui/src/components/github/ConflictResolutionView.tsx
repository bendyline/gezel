import type { GitConflictFile } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { ConflictFileCard, type Resolution } from './ConflictFileCard.js';
import { GIT_COPY, plural } from './gitCopy.js';
import { notifyGitChanged } from './useGitSync.js';

/**
 * Guided conflict flow that takes over the Changes pane while a sync is
 * waiting on overlapping edits. Left rail lists the files with their
 * resolution state; the right side hosts one file's keep-mine /
 * keep-GitHub's / AI-combine cards. Nothing is final until "Finish
 * sync"; "Cancel sync" puts everything back via merge --abort.
 */

interface Props {
  projectId: string;
  /** True when re-entering after an app restart (vs a fresh sync). */
  resumed: boolean;
  showToast: (kind: 'ok' | 'err', text: string) => void;
  /** Finish committed the merge — the shell re-syncs to send it. */
  onFinished: () => void;
  /** Cancelled (or the merge vanished) — the shell returns to Changes. */
  onExited: () => void;
}

const RESOLUTION_LABEL: Record<Resolution, string> = {
  mine: 'Kept yours',
  theirs: "Kept GitHub's",
  combined: 'Combined',
};

export function ConflictResolutionView({
  projectId,
  resumed,
  showToast,
  onFinished,
  onExited,
}: Props) {
  const [conflicts, setConflicts] = useState<GitConflictFile[] | null>(null);
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'resolve' | 'finish' | 'cancel'>('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getProjectGitMergeState(projectId)
      .then((state) => {
        if (cancelled) return;
        if (!state.inMerge) {
          onExited();
          return;
        }
        setConflicts(state.conflicts);
        setSelectedPath(state.conflicts[0]?.path ?? null);
      })
      .catch(() => {
        if (!cancelled) onExited();
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, onExited]);

  const resolve = useCallback(
    async (path: string, choice: 'mine' | 'theirs' | 'custom', content?: string) => {
      setBusy('resolve');
      try {
        await api.resolveProjectGitConflict(projectId, {
          path,
          choice,
          ...(content !== undefined ? { content } : {}),
        });
        setResolutions((prev) => {
          const next = new Map(prev);
          next.set(path, choice === 'custom' ? 'combined' : choice);
          return next;
        });
        // Auto-advance to the next unresolved file.
        setSelectedPath(() => {
          const remaining = (conflicts ?? []).filter(
            (c) => c.path !== path && !resolutions.has(c.path),
          );
          return remaining[0]?.path ?? null;
        });
        notifyGitChanged(projectId);
      } catch (err) {
        showToast('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy('');
      }
    },
    [projectId, conflicts, resolutions, showToast],
  );

  const finish = useCallback(async () => {
    setBusy('finish');
    try {
      await api.completeProjectGitMerge(projectId);
      notifyGitChanged(projectId);
      showToast('ok', GIT_COPY.conflictFinishToast);
      onFinished();
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : String(err));
      setBusy('');
    }
  }, [projectId, showToast, onFinished]);

  const cancel = useCallback(async () => {
    setBusy('cancel');
    try {
      await api.abandonProjectGitMerge(projectId);
      notifyGitChanged(projectId);
      onExited();
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : String(err));
      setBusy('');
    }
  }, [projectId, showToast, onExited]);

  if (conflicts === null) {
    return <p className="muted gh-conflict-loading">Loading…</p>;
  }

  const resolvedCount = conflicts.filter((c) => resolutions.has(c.path)).length;
  const allResolved = resolvedCount === conflicts.length;
  const selected = conflicts.find((c) => c.path === selectedPath) ?? null;

  return (
    <div className="gh-conflicts">
      <header className="gh-conflicts-header">
        <h3>Your changes and GitHub's changes overlap in {plural(conflicts.length, 'file')}</h3>
        <p className="muted">{resumed ? GIT_COPY.conflictResume : GIT_COPY.conflictSub}</p>
      </header>
      <div className="gh-conflicts-body">
        <ul className="gh-conflicts-rail">
          {conflicts.map((c) => {
            const resolution = resolutions.get(c.path);
            return (
              <li key={c.path}>
                <button
                  type="button"
                  className={`gh-conflicts-rail-item${c.path === selectedPath ? ' is-selected' : ''}`}
                  onClick={() => setSelectedPath(c.path)}
                >
                  <span
                    className={`gh-conflicts-dot${resolution ? ' is-resolved' : ''}`}
                    aria-hidden
                  >
                    {resolution ? '✓' : '○'}
                  </span>
                  <span className="gh-conflicts-rail-path" title={c.path}>
                    {c.path.split('/').pop()}
                  </span>
                  {resolution && (
                    <span className="muted small">{RESOLUTION_LABEL[resolution]}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="gh-conflicts-detail">
          {selected ? (
            resolutions.has(selected.path) ? (
              <p className="muted gh-conflict-settled">
                {RESOLUTION_LABEL[resolutions.get(selected.path)!]} for <code>{selected.path}</code>
                . To change your mind, cancel the sync and start over.
              </p>
            ) : (
              <ConflictFileCard
                projectId={projectId}
                path={selected.path}
                kind={selected.kind}
                busy={busy !== ''}
                onResolve={(choice, content) => void resolve(selected.path, choice, content)}
              />
            )
          ) : (
            <p className="muted gh-conflict-settled">
              {allResolved
                ? 'All files are sorted out — press Finish sync.'
                : 'Pick a file on the left.'}
            </p>
          )}
        </div>
      </div>
      <footer className="gh-conflicts-footer">
        <span className="muted small">
          {resolvedCount} of {conflicts.length} sorted out
        </span>
        <div className="gh-conflicts-footer-actions">
          <button type="button" onClick={() => setConfirmCancel(true)} disabled={busy !== ''}>
            {GIT_COPY.conflictCancel}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void finish()}
            disabled={!allResolved || busy !== ''}
          >
            {busy === 'finish' ? 'Finishing…' : GIT_COPY.conflictFinish}
          </button>
        </div>
      </footer>
      <ConfirmDialog
        open={confirmCancel}
        title={GIT_COPY.conflictCancelTitle}
        message={GIT_COPY.conflictCancelBody}
        confirmLabel={GIT_COPY.conflictCancelConfirm}
        cancelLabel={GIT_COPY.conflictCancelKeep}
        danger
        onConfirm={async () => {
          setConfirmCancel(false);
          await cancel();
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
