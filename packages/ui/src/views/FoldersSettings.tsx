import type {
  FolderMovePlan,
  FolderMoveStatus,
  FolderScope,
  FoldersStatusResponse,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

const SCOPES: { id: FolderScope; label: string; help: string }[] = [
  {
    id: 'documents',
    label: 'Documents library',
    help: 'The shared documents folder gezels read and write across projects.',
  },
  {
    id: 'gezels',
    label: 'Gezels',
    help: 'Each gezel’s about, threads, memories, and icons. Installed toolsets (npm packages) stay on this device.',
  },
  {
    id: 'projects',
    label: 'Projects (artifacts, tasks, memories, documents)',
    help: 'Working files (workspace, git checkout, scripts) and history stay on this device.',
  },
];

interface PendingPick {
  scope: FolderScope;
  destPath: string;
  plan: FolderMovePlan;
  conflictPolicy: 'overwrite-all' | 'skip-all';
}

export function FoldersSettings() {
  const [status, setStatus] = useState<FoldersStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPick | null>(null);
  const [activeJob, setActiveJob] = useState<FolderMoveStatus | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getFolders();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll the active job status while one is in flight.
  useEffect(() => {
    if (
      !activeJob ||
      activeJob.status === 'done' ||
      activeJob.status === 'error' ||
      activeJob.status === 'cancelled'
    ) {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      try {
        const next = await api.getFolderMoveStatus(activeJob.id);
        setActiveJob(next);
        if (next.status === 'done' || next.status === 'error' || next.status === 'cancelled') {
          await refresh();
        }
      } catch (err) {
        setError((err as Error).message);
      }
    }, 1000);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [activeJob, refresh]);

  const onPick = useCallback(async (scope: FolderScope, label: string) => {
    const picker = window.__GEZEL__?.selectDirectory;
    if (!picker) {
      setError('Folder picker is only available in the desktop app.');
      return;
    }
    const dest = await picker({ title: `Pick external location for ${label}` });
    if (!dest) return;
    try {
      const plan = await api.planFolderMove({ scope, destPath: dest });
      if (!plan.validation.ok) {
        setError(plan.validation.reason ?? 'destination is not valid');
        return;
      }
      setPending({
        scope,
        destPath: dest,
        plan,
        conflictPolicy: plan.conflicts > 0 ? 'overwrite-all' : 'overwrite-all',
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const onConfirmMove = useCallback(async () => {
    if (!pending) return;
    try {
      const { jobId } = await api.startFolderMove({
        scope: pending.scope,
        destPath: pending.destPath,
        conflictPolicy: pending.conflictPolicy,
      });
      setPending(null);
      // Seed an initial status so the polling effect kicks in.
      setActiveJob({
        id: jobId,
        scope: pending.scope,
        sourcePath: pending.plan.sourcePath,
        destPath: pending.destPath,
        status: 'queued',
        filesDone: 0,
        totalFiles: pending.plan.files,
        bytesDone: 0,
        totalBytes: pending.plan.bytes,
        restartRequired: false,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [pending]);

  const onReset = useCallback(
    async (scope: FolderScope) => {
      try {
        const { jobId } = await api.resetFolder(scope);
        setActiveJob({
          id: jobId,
          scope,
          sourcePath: status?.current[scope] ?? '',
          destPath: status?.defaults[scope] ?? '',
          status: 'queued',
          filesDone: 0,
          totalFiles: 0,
          bytesDone: 0,
          totalBytes: 0,
          restartRequired: false,
          startedAt: new Date().toISOString(),
        });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [status],
  );

  const onOpen = useCallback(async (path: string) => {
    const open = window.__GEZEL__?.openPath;
    if (!open) {
      setError('Opening folders is only available in the desktop app.');
      return;
    }
    const result = await open(path);
    if (result) setError(result);
  }, []);

  const onRestart = useCallback(async () => {
    const restart = window.__GEZEL__?.restartService;
    if (!restart) {
      setError('Restart is only available in the desktop app.');
      return;
    }
    try {
      const result = await restart('folders-changed');
      if (!result.ok) setError(result.error);
      // BrowserWindow auto-reloads via the supervisor restart event;
      // no need to clear state here.
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  if (!status) {
    return (
      <section className="settings-section">
        <h2>Folders</h2>
        <p className="muted small">Loading…</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>Folders</h2>
      <p className="muted small">
        Move parts of your gezel data to a folder of your choosing — for example a OneDrive, iCloud
        Drive, or Dropbox folder so it syncs across machines and gets backed up. A snapshot of the
        source is always written to <code>{status.backups.path}</code> before any move runs.
      </p>

      {error && (
        <p className="error small" role="alert">
          {error}{' '}
          <button type="button" className="home-link" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      <div className="folders-rows">
        {SCOPES.map((scope) => (
          <ScopeRow
            key={scope.id}
            label={scope.label}
            help={scope.help}
            currentPath={status.current[scope.id]}
            externalized={status.externalized[scope.id]}
            disabled={status.activeJob || activeJob !== null}
            onPick={() => onPick(scope.id, scope.label)}
            onReset={() => onReset(scope.id)}
            onOpen={() => onOpen(status.current[scope.id])}
          />
        ))}
      </div>

      <p className="muted small" style={{ marginTop: 16 }}>
        Backups: {status.backups.count} {status.backups.count === 1 ? 'snapshot' : 'snapshots'}
        {status.backups.count > 0 && ` (${formatBytes(status.backups.totalBytes)})`}
      </p>

      {activeJob && <MoveProgress job={activeJob} onRestart={onRestart} />}

      <ConfirmDialog
        open={pending !== null}
        title={pending ? `Move ${pending.plan.files} files?` : ''}
        message={
          pending && (
            <>
              <p>
                <strong>From:</strong> <code>{pending.plan.sourcePath}</code>
              </p>
              <p>
                <strong>To:</strong> <code>{pending.destPath}</code>
              </p>
              <p>
                {pending.plan.files.toLocaleString()} files ({formatBytes(pending.plan.bytes)}) will
                be copied. A backup snapshot will be saved before the move.
              </p>
              {pending.plan.conflicts > 0 && (
                <p>
                  <strong>{pending.plan.conflicts}</strong> file
                  {pending.plan.conflicts === 1 ? '' : 's'} already exist at the destination.
                  <ConflictPolicyPicker
                    value={pending.conflictPolicy}
                    onChange={(v) =>
                      setPending((prev) => (prev ? { ...prev, conflictPolicy: v } : prev))
                    }
                  />
                </p>
              )}
              <p>
                The gezel service will need to restart afterwards. Sessions on disk are preserved.
              </p>
            </>
          )
        }
        confirmLabel="Start move"
        cancelLabel="Cancel"
        onConfirm={onConfirmMove}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

function ScopeRow({
  label,
  help,
  currentPath,
  externalized,
  disabled,
  onPick,
  onReset,
  onOpen,
}: {
  label: string;
  help: string;
  currentPath: string;
  externalized: string | null;
  disabled: boolean;
  onPick: () => void;
  onReset: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="folders-row" style={{ marginTop: 24 }}>
      <div className="folders-row-head">
        <strong>{label}</strong>
      </div>
      <p className="muted small">{help}</p>
      <div className="muted small">{externalized ? 'External' : 'Default location'}</div>
      <code className="folders-row-path">{currentPath}</code>
      <div className="folders-row-actions" style={{ marginTop: 16 }}>
        <button type="button" className="primary" onClick={onPick} disabled={disabled}>
          Move to other folder…
        </button>
        {window.__GEZEL__?.openPath && (
          <button type="button" onClick={onOpen}>
            Open
          </button>
        )}
        {externalized && (
          <button type="button" onClick={onReset} disabled={disabled}>
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}

function ConflictPolicyPicker({
  value,
  onChange,
}: {
  value: 'overwrite-all' | 'skip-all';
  onChange: (next: 'overwrite-all' | 'skip-all') => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ display: 'block', marginBottom: 4 }}>
        <input
          type="radio"
          name="conflictPolicy"
          checked={value === 'overwrite-all'}
          onChange={() => onChange('overwrite-all')}
        />{' '}
        Overwrite destination files
      </label>
      <label style={{ display: 'block' }}>
        <input
          type="radio"
          name="conflictPolicy"
          checked={value === 'skip-all'}
          onChange={() => onChange('skip-all')}
        />{' '}
        Skip conflicting files (keep destination)
      </label>
    </div>
  );
}

function MoveProgress({
  job,
  onRestart,
}: {
  job: FolderMoveStatus;
  onRestart: () => void;
}) {
  const pct =
    job.totalFiles > 0 ? Math.min(100, Math.round((job.filesDone / job.totalFiles) * 100)) : 0;
  const phaseLabel = describePhase(job);
  return (
    <div className="folders-progress" style={{ marginTop: 16 }}>
      <div className="folders-progress-head">
        <strong>
          Moving {job.scope} → <code>{job.destPath}</code>
        </strong>
        <span className="muted small">{phaseLabel}</span>
      </div>
      {job.status === 'running' || job.status === 'queued' ? (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${pct}%` }} />
          <span className="ollama-pull-bar-label">{pct}%</span>
        </div>
      ) : null}
      {job.status === 'error' && <p className="error small">Error: {job.error ?? 'unknown'}</p>}
      {job.status === 'done' && job.restartRequired && (
        <p style={{ marginTop: 8 }}>
          Move complete.{' '}
          <button type="button" className="primary" onClick={onRestart}>
            Restart now
          </button>
        </p>
      )}
      {job.status === 'cancelled' && <p className="muted small">Cancelled.</p>}
    </div>
  );
}

function describePhase(job: FolderMoveStatus): string {
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'done') return 'Done';
  if (job.status === 'error') return 'Failed';
  if (job.status === 'cancelled') return 'Cancelled';
  switch (job.phase) {
    case 'scan':
      return 'Scanning…';
    case 'backup':
      return 'Creating backup…';
    case 'copy':
      return `Copying ${job.filesDone.toLocaleString()} of ${job.totalFiles.toLocaleString()} files (${formatBytes(job.bytesDone)} of ${formatBytes(job.totalBytes)})`;
    case 'verify':
      return 'Verifying…';
    case 'swap':
      return 'Updating configuration…';
    case 'cleanup':
      return 'Cleaning up source…';
    case 'prune':
      return 'Pruning old backups…';
    default:
      return 'Working…';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
