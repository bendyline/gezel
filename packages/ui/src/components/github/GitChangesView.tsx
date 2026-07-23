import type { GithubFileDiffResponse, GithubWorkingChange } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { ChangedFileList } from './ChangedFileList.js';
import { GitDiffView } from './GitDiffView.js';
import { SaveChangesBox } from './SaveChangesBox.js';
import { GIT_COPY, changeKindWord, friendlyDate, plural } from './gitCopy.js';
import { GITHUB_CHANGED_EVENT, notifyGithubChanged } from './useGitSync.js';

/**
 * The Changes sub-tab: changed files + save box on the left, the
 * selected file's diff on the right. All-or-nothing saves — no staging
 * area, no checkboxes; "save my work" is the whole mental model.
 */

interface Props {
  projectId: string;
  /** Sync trigger shared with the shell (so toasts/conflicts route once). */
  onSyncRequested: () => void;
  syncing: boolean;
  lastSyncedAt?: string;
  showToast: (kind: 'ok' | 'err', text: string) => void;
}

export function GitChangesView({
  projectId,
  onSyncRequested,
  syncing,
  lastSyncedAt,
  showToast,
}: Props) {
  const [changes, setChanges] = useState<GithubWorkingChange[] | null>(null);
  const [truncatedList, setTruncatedList] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GithubFileDiffResponse | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'discard'>('');
  const [confirmDiscard, setConfirmDiscard] = useState<GithubWorkingChange | null>(null);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const diffCacheRef = useRef(new Map<string, GithubFileDiffResponse>());

  const refresh = useCallback(async () => {
    try {
      const res = await api.getProjectGithubChanges(projectId);
      diffCacheRef.current.clear();
      setChanges(res.changes);
      setTruncatedList(res.truncated);
      setSelectedPath((prev) => {
        if (prev && res.changes.some((c) => c.path === prev)) return prev;
        return res.changes[0]?.path ?? null;
      });
    } catch {
      // Best-effort: the list keeps its last good state.
    }
  }, [projectId]);

  // Mount + 15s cadence + cross-surface invalidation events.
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === projectId) void refresh();
    };
    window.addEventListener(GITHUB_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(GITHUB_CHANGED_EVENT, onChanged);
    };
  }, [refresh, projectId]);

  // Load (and cache) the selected file's diff.
  useEffect(() => {
    if (!selectedPath) {
      setDiff(null);
      return;
    }
    const cached = diffCacheRef.current.get(selectedPath);
    if (cached) {
      setDiff(cached);
      return;
    }
    let cancelled = false;
    setDiff(null);
    void api
      .getProjectGithubFileDiff(projectId, selectedPath)
      .then((d) => {
        diffCacheRef.current.set(selectedPath, d);
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) {
          setDiff({
            path: selectedPath,
            kind: 'modified',
            binary: false,
            truncated: false,
            diff: '',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedPath]);

  const onSave = useCallback(
    async (message: string, alsoSync: boolean) => {
      setBusy('save');
      try {
        await api.commitProjectGithub(projectId, message);
        showToast('ok', GIT_COPY.saveToast);
        await refresh();
        notifyGithubChanged(projectId);
        if (alsoSync) onSyncRequested();
      } catch (err) {
        showToast('err', `Save failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy('');
      }
    },
    [projectId, refresh, showToast, onSyncRequested],
  );

  const runDiscard = useCallback(
    async (args: { paths?: string[]; all?: boolean }) => {
      setBusy('discard');
      try {
        const res = await api.discardProjectGithubChanges(projectId, args);
        showToast('ok', `Undid ${plural(res.discarded, 'change')}.`);
        await refresh();
        notifyGithubChanged(projectId);
      } catch (err) {
        showToast('err', `Undo failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy('');
      }
    },
    [projectId, refresh, showToast],
  );

  const selected = changes?.find((c) => c.path === selectedPath) ?? null;
  const fileName = (p: string) => p.split('/').pop() ?? p;

  if (changes === null) {
    return <p className="muted gh-changes-loading">Loading changes…</p>;
  }

  if (changes.length === 0) {
    return (
      <div className="gh-changes-empty">
        <div className="gh-changes-empty-title">{GIT_COPY.changesEmptyTitle}</div>
        <p className="muted">{GIT_COPY.changesEmptyBody}</p>
        <button type="button" onClick={onSyncRequested} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        {lastSyncedAt && <p className="muted small">Last synced {friendlyDate(lastSyncedAt)}</p>}
      </div>
    );
  }

  return (
    <div className="gh-changes-layout">
      <div className="gh-changes-rail">
        <div className="gh-changes-rail-header">
          <strong>{plural(changes.length, 'changed file')}</strong>
          <button
            type="button"
            className="gh-changes-discard-all small"
            onClick={() => setConfirmDiscardAll(true)}
            disabled={busy !== ''}
          >
            Undo all…
          </button>
        </div>
        {truncatedList && (
          <p className="muted small gh-changes-truncated">
            Showing the first {changes.length} files.
          </p>
        )}
        <div className="gh-changes-rail-list">
          <ChangedFileList
            changes={changes}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            onDiscard={setConfirmDiscard}
            disabled={busy !== ''}
          />
        </div>
        <SaveChangesBox
          projectId={projectId}
          changes={changes}
          busy={busy === 'save'}
          onSave={onSave}
        />
      </div>
      <div className="gh-changes-diff-pane">
        {selected ? (
          <>
            <div className="gh-changes-diff-header">
              <code className="gh-changes-diff-path" title={selected.path}>
                {selected.path}
              </code>
              <span className="muted small">{changeKindWord(selected.kind)}</span>
              {!selected.binary &&
                (selected.additions !== undefined || selected.deletions !== undefined) && (
                  <span className="small">
                    <span className="gh-change-add">+{selected.additions ?? 0}</span>{' '}
                    <span className="gh-change-rem">−{selected.deletions ?? 0}</span>
                  </span>
                )}
            </div>
            {diff ? (
              <GitDiffView
                diff={diff.diff}
                kind={diff.kind}
                oldPath={diff.oldPath}
                binary={diff.binary}
                truncated={diff.truncated}
              />
            ) : (
              <p className="muted gh-changes-loading">Loading…</p>
            )}
          </>
        ) : (
          <p className="placeholder">Pick a file to see what changed.</p>
        )}
      </div>
      <ConfirmDialog
        open={confirmDiscard !== null}
        title={`Undo changes to ${confirmDiscard ? fileName(confirmDiscard.path) : ''}?`}
        message="This puts the file back to how it was at your last save. This can't be undone."
        confirmLabel="Undo changes"
        danger
        onConfirm={async () => {
          const target = confirmDiscard;
          setConfirmDiscard(null);
          if (target) await runDiscard({ paths: [target.path] });
        }}
        onCancel={() => setConfirmDiscard(null)}
      />
      <ConfirmDialog
        open={confirmDiscardAll}
        title="Undo all changes?"
        message={`This puts all ${plural(changes.length, 'file')} back to how they were at your last save. This can't be undone.`}
        confirmLabel="Undo everything"
        danger
        onConfirm={async () => {
          setConfirmDiscardAll(false);
          await runDiscard({ all: true });
        }}
        onCancel={() => setConfirmDiscardAll(false)}
      />
    </div>
  );
}
