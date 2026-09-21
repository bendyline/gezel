import type { BackupPlan, RestoreReview, StorageJob } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { AlertDialog } from '../primitives/index.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { formatBytes } from './model-memory-copy.js';

/**
 * Back up your content to a file, and put it back later.
 *
 * The two halves live in one dialog because they are one idea to the person
 * using them: the copy of my work that is not on this machine. Saved
 * credentials are deliberately never in that copy — they are bound to this
 * device, and carrying them in a file someone emails to themselves would be
 * a liability rather than a convenience.
 */

export const SHOW_BACKUP_RESTORE_EVENT = 'gezel:show-backup-restore';

export interface BackupRestoreRequestDetail {
  tab?: 'backup' | 'restore';
}

export function requestBackupRestore(detail: BackupRestoreRequestDetail = {}): void {
  window.dispatchEvent(new CustomEvent(SHOW_BACKUP_RESTORE_EVENT, { detail }));
}

const POLL_MS = 400;

function isSettled(job: StorageJob): boolean {
  return job.status === 'done' || job.status === 'error' || job.status === 'cancelled';
}

function defaultBackupName(): string {
  return `gezel-backup-${new Date().toISOString().slice(0, 10)}.zip`;
}

export function BackupRestoreDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'backup' | 'restore'>('backup');
  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [review, setReview] = useState<RestoreReview | null>(null);
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [excludeWorkspaces, setExcludeWorkspaces] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<StorageJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const portable = !runtimeCapabilities().daemonSettings;
  const pendingReview = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const reset = useCallback(() => {
    if (pendingReview.current) void api.cancelRestore(pendingReview.current).catch(() => {});
    pendingReview.current = null;
    setPlan(null);
    setReview(null);
    setReplace(new Set());
    setJob(null);
    setError(null);
    setDone(null);
    setBusy(false);
  }, []);

  const loadPlan = useCallback(async (skipWorkspaces: boolean) => {
    try {
      setPlan(await api.planBackup({ excludeWorkspaces: skipWorkspaces }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const show = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<BackupRestoreRequestDetail>).detail ?? {};
      reset();
      setTab(detail.tab ?? 'backup');
      setOpen(true);
      if ((detail.tab ?? 'backup') === 'backup') void loadPlan(false);
    },
    [loadPlan, reset],
  );

  useEffect(() => {
    window.addEventListener(SHOW_BACKUP_RESTORE_EVENT, show);
    return () => window.removeEventListener(SHOW_BACKUP_RESTORE_EVENT, show);
  }, [show]);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback((jobId: string, onDone: (job: StorageJob) => void) => {
    pollTimer.current = setTimeout(async () => {
      try {
        const next = await api.getStorageJob(jobId);
        setJob(next);
        if (isSettled(next)) {
          setBusy(false);
          onDone(next);
          return;
        }
        poll(jobId, onDone);
      } catch (e) {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_MS);
  }, []);

  const filePicker = window.__GEZEL__?.backupFile;

  const startBackup = async () => {
    if (busy) return;
    setError(null);
    if (portable) {
      setBusy(true);
      try {
        const bytes = await api.exportPortableBackup({ excludeWorkspaces });
        if (window.__GEZEL__?.saveExportedFile) {
          await window.__GEZEL__.saveExportedFile({
            name: defaultBackupName(),
            mimeType: 'application/zip',
            bytes,
          });
          setDone('Backup exported.');
        } else if (['ios', 'android', 'mobile'].includes(window.__GEZEL__?.platform ?? '')) {
          throw new Error('File export is not available in this version of the app.');
        } else {
          const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/zip' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = defaultBackupName();
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 30000);
          setDone('Backup downloaded.');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    const picked = await filePicker?.chooseSavePath(defaultBackupName());
    if (!picked?.path) return;
    setBusy(true);
    try {
      const { jobId } = await api.startBackup({ outPath: picked.path, excludeWorkspaces });
      poll(jobId, (finished) => {
        if (finished.status === 'done') setDone(`Saved to ${picked.path}`);
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickRestoreFile = async () => {
    setError(null);
    if (portable) {
      uploadInput.current?.click();
      return;
    }
    const picked = await filePicker?.chooseOpenPath();
    if (!picked?.path) return;
    setBusy(true);
    try {
      const next = await api.scanRestore({ path: picked.path });
      pendingReview.current = next.restoreId;
      setReview(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const inspectUpload = async (file?: File) => {
    if (!file || busy) return;
    setError(null);
    if (file.size > 72 * 1024 * 1024) {
      setError('Choose a backup smaller than 72 MiB.');
      return;
    }
    setBusy(true);
    try {
      if (pendingReview.current) await api.cancelRestore(pendingReview.current);
      const next = await api.scanPortableRestore(new Uint8Array(await file.arrayBuffer()));
      pendingReview.current = next.restoreId;
      setReview(next);
      setReplace(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  const startRestore = async () => {
    if (busy || !review) return;
    setBusy(true);
    setError(null);
    try {
      const items = review.items
        .filter((item) => item.conflict === 'none' || replace.has(`${item.kind}:${item.id}`))
        .map((item) => ({
          kind: item.kind,
          id: item.id,
          action: item.conflict === 'exists' ? ('replace' as const) : ('add' as const),
        }));
      const settings = items.some((item) => item.kind === 'settings-file');
      if (portable) {
        const result = await api.confirmPortableRestore(review.restoreId, { items, settings });
        pendingReview.current = null;
        setDone(`Restored ${result.restored} item(s). Reopening your workspace…`);
        window.location.reload();
        return;
      }
      const { jobId } = await api.confirmRestore(review.restoreId, {
        items,
        ...(settings ? { settings: true } : {}),
      });
      poll(jobId, (finished) => {
        if (finished.status === 'done') setDone(`Restored ${items.length} item(s).`);
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const conflicts = review?.items.filter((i) => i.conflict === 'exists') ?? [];
  const restorable =
    (review?.items.filter((i) => i.conflict === 'none').length ?? 0) + replace.size;

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          stopPolling();
          setOpen(false);
          if (pendingReview.current) void api.cancelRestore(pendingReview.current).catch(() => {});
          pendingReview.current = null;
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content className="gz-dialog-wide gz-backup-dialog">
          <AlertDialog.Title asChild>
            <h3>{tab === 'backup' ? 'Back up your content' : 'Restore from a backup'}</h3>
          </AlertDialog.Title>
          <AlertDialog.Description className="muted small">
            A backup holds your gezels, projects, and documents. Saved credentials are never
            included — reconnect your services after restoring.
          </AlertDialog.Description>

          <div className="gz-backup-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'backup'}
              disabled={busy}
              onClick={() => {
                reset();
                setTab('backup');
                void loadPlan(excludeWorkspaces);
              }}
            >
              Back up
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'restore'}
              disabled={busy}
              onClick={() => {
                reset();
                setTab('restore');
              }}
            >
              Restore
            </button>
          </div>

          <div className="gz-backup-body">
            {!filePicker && !portable && (
              <p className="muted small">
                Choosing a file needs the desktop app. From a terminal, use{' '}
                <code>gezel backup</code> and <code>gezel restore</code>.
              </p>
            )}
            {portable && (
              <input
                ref={uploadInput}
                type="file"
                accept=".zip,application/zip"
                aria-label="Backup file"
                hidden
                onChange={(event) => void inspectUpload(event.target.files?.[0])}
              />
            )}

            {tab === 'backup' && !done && (
              <>
                {plan && (
                  <>
                    <ul className="storage-list">
                      {plan.items.length === 0 && (
                        <li>
                          <span className="storage-list-label">Nothing to back up yet.</span>
                        </li>
                      )}
                      {plan.items.map((item) => (
                        <li key={`${item.kind}:${item.id}`}>
                          <span className="storage-list-label">{item.label}</span>
                          <span className="storage-list-bytes">{formatBytes(item.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="muted small">About {formatBytes(plan.totalBytes)} in total.</p>
                    <label className="gz-backup-exclude">
                      <input
                        type="checkbox"
                        checked={excludeWorkspaces}
                        disabled={busy}
                        onChange={(e) => {
                          setExcludeWorkspaces(e.target.checked);
                          void loadPlan(e.target.checked);
                        }}
                      />
                      <span>Leave out project working files (smaller backup)</span>
                    </label>
                    {plan.warnings.map((warning) => (
                      <p className="muted small" key={warning}>
                        {warning}
                      </p>
                    ))}
                  </>
                )}
                {!plan && !error && <p className="muted small">Measuring…</p>}
              </>
            )}

            {tab === 'restore' && !done && (
              <>
                {!review && (
                  <p className="muted small">
                    Choose a backup file to see what it holds. Nothing changes until you confirm.
                  </p>
                )}
                {review && (
                  <>
                    <ul className="storage-list">
                      {review.items.map((item) => (
                        <li key={`${item.kind}:${item.id}`}>
                          <span className="storage-list-label">
                            {item.label}
                            {item.conflict === 'exists' && (
                              <label className="gz-backup-replace">
                                <input
                                  type="checkbox"
                                  checked={replace.has(`${item.kind}:${item.id}`)}
                                  disabled={busy}
                                  onChange={(e) =>
                                    setReplace((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(`${item.kind}:${item.id}`);
                                      else next.delete(`${item.kind}:${item.id}`);
                                      return next;
                                    })
                                  }
                                />
                                <span>replace the one already here</span>
                              </label>
                            )}
                          </span>
                          <span className="storage-list-bytes">{formatBytes(item.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                    {conflicts.length > 0 && (
                      <p className="gz-cleanup-warning small" role="alert">
                        {conflicts.length} item(s) already exist here. They are left alone unless
                        you tick replace — replacing overwrites what is here now.
                      </p>
                    )}
                    {review.warnings.map((warning) => (
                      <p className="muted small" key={warning}>
                        {warning}
                      </p>
                    ))}
                  </>
                )}
              </>
            )}

            {busy && job && (
              <p className="muted small" aria-live="polite">
                {job.phase === 'write' && `Writing ${job.currentLabel ?? '…'}`}
                {job.phase === 'extract' && 'Reading the backup…'}
                {job.phase === 'publish' && `Restoring ${job.currentLabel ?? '…'}`}
                {job.totalItems > 0 && ` (${job.itemsDone}/${job.totalItems})`}
              </p>
            )}

            {done && (
              <div className="gz-cleanup-outcome">
                <p>{done}</p>
                {job?.restartRequired && (
                  <p className="muted small">Restart Gezel to see restored content.</p>
                )}
              </div>
            )}

            {error && (
              <p className="gz-dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>

          <AlertDialog.Actions>
            <AlertDialog.Cancel asChild>
              <button type="button" className="secondary" disabled={busy}>
                {done ? 'Close' : 'Cancel'}
              </button>
            </AlertDialog.Cancel>
            {!done && tab === 'backup' && (
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={busy || (!filePicker && !portable) || (plan?.items.length ?? 0) === 0}
                  onClick={(event) => {
                    event.preventDefault();
                    void startBackup();
                  }}
                >
                  {busy ? 'Backing up…' : 'Choose where to save…'}
                </button>
              </AlertDialog.Action>
            )}
            {!done && tab === 'restore' && (
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={
                    busy || (!filePicker && !portable) || (review !== null && restorable === 0)
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    if (review) void startRestore();
                    else void pickRestoreFile();
                  }}
                >
                  {busy
                    ? 'Working…'
                    : review
                      ? `Restore ${restorable} item(s)`
                      : 'Choose a backup file…'}
                </button>
              </AlertDialog.Action>
            )}
          </AlertDialog.Actions>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
