import type { StorageCategory, StorageJob, StorageSummary } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { AlertDialog } from '../primitives/index.js';
import { formatBytes } from './model-memory-copy.js';

/**
 * The dialog that reclaims disk space, opened from Settings → About and from
 * the uninstall flow.
 *
 * Its shape carries the argument: downloads are pre-selected and described as
 * costing a download, while the user's own work sits behind a collapsed
 * section and a second, explicit confirmation. Someone clearing space before
 * an uninstall should land on the safe choice without reading carefully;
 * losing their gezels should take deliberate effort.
 */

export const SHOW_STORAGE_CLEANUP_EVENT = 'gezel:show-storage-cleanup';

export interface StorageCleanupRequestDetail {
  /** Pre-tick every re-downloadable category — the pre-uninstall entry. */
  preselectRedownloadable?: boolean;
}

export function requestStorageCleanup(detail: StorageCleanupRequestDetail = {}): void {
  window.dispatchEvent(new CustomEvent(SHOW_STORAGE_CLEANUP_EVENT, { detail }));
}

const POLL_MS = 400;

function isSettled(job: StorageJob): boolean {
  return job.status === 'done' || job.status === 'error' || job.status === 'cancelled';
}

export function StorageCleanupDialog() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [contentExpanded, setContentExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<StorageJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const show = useCallback((event: Event) => {
    const detail = (event as CustomEvent<StorageCleanupRequestDetail>).detail ?? {};
    setError(null);
    setJob(null);
    setBusy(false);
    setContentExpanded(false);
    setSelected(new Set());
    setOpen(true);
    void (async () => {
      try {
        // Settings already starts this measurement when it mounts. Reuse its
        // in-flight or one-minute-cached result instead of launching a second
        // full filesystem walk as soon as the dialog opens.
        const next = await api.storageSummary();
        setSummary(next);
        if (detail.preselectRedownloadable) {
          setSelected(
            new Set(
              next.categories
                .filter((c) => c.class === 'redownloadable' && c.deletable && c.bytes > 0)
                .map((c) => c.id),
            ),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    window.addEventListener(SHOW_STORAGE_CLEANUP_EVENT, show);
    return () => window.removeEventListener(SHOW_STORAGE_CLEANUP_EVENT, show);
  }, [show]);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback((jobId: string) => {
    pollTimer.current = setTimeout(async () => {
      try {
        const next = await api.getStorageJob(jobId);
        setJob(next);
        if (isSettled(next)) {
          setBusy(false);
          // The summary behind this dialog is now wrong by exactly what we
          // freed, so re-read it rather than leave a stale number on screen.
          api.storageSummary({ refresh: true }).then(setSummary, () => {});
          return;
        }
        poll(jobId);
      } catch (e) {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_MS);
  }, []);

  const deletable = (summary?.categories ?? []).filter((c) => c.deletable);
  const redownloadable = deletable.filter((c) => c.class === 'redownloadable');
  const userContent = deletable.filter((c) => c.class === 'user-content');
  const chosen = deletable.filter((c) => selected.has(c.id));
  const chosenUserContent = chosen.filter((c) => c.class === 'user-content');
  const freeing = chosen.reduce((total, c) => total + c.bytes, 0);
  const destroysUserContent = chosenUserContent.length > 0;

  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const start = async () => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { jobId } = await api.startCleanup({
        categories: chosen.map((c) => c.id),
        ...(destroysUserContent ? { confirmUserContent: true } : {}),
      });
      poll(jobId);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const finished = job !== null && isSettled(job);

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          stopPolling();
          setOpen(false);
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content className="gz-dialog-wide gz-cleanup-dialog">
          <AlertDialog.Title asChild>
            <h3>Free up space</h3>
          </AlertDialog.Title>
          <AlertDialog.Description className="muted small">
            Uninstalling Gezel leaves everything here on disk. Clear out what you no longer need —
            downloads come back on their own if you keep using Gezel.
          </AlertDialog.Description>

          <div className="gz-cleanup-body">
            {!summary && !error && <p className="muted small">Measuring…</p>}

            {summary && !finished && (
              <>
                <fieldset className="gz-cleanup-choices" disabled={busy}>
                  <legend>Downloads Gezel can fetch again</legend>
                  {redownloadable.map((category) => (
                    <CategoryChoice
                      key={category.id}
                      category={category}
                      checked={selected.has(category.id)}
                      onChange={(on) => toggle(category.id, on)}
                    />
                  ))}
                  {redownloadable.every((c) => c.bytes === 0) && (
                    <p className="muted small">Nothing downloaded yet.</p>
                  )}
                </fieldset>

                <div className="gz-cleanup-content-group">
                  <button
                    type="button"
                    className="link-button"
                    aria-expanded={contentExpanded}
                    onClick={() => setContentExpanded((v) => !v)}
                    disabled={busy}
                  >
                    {contentExpanded ? 'Hide my content' : 'Delete my content instead…'}
                  </button>
                  {contentExpanded && (
                    <fieldset className="gz-cleanup-choices" disabled={busy}>
                      <legend>Your content</legend>
                      <p className="gz-cleanup-warning small" role="alert">
                        Gezel cannot bring these back. Back them up first if you may want them
                        again.
                      </p>
                      {userContent.map((category) => (
                        <CategoryChoice
                          key={category.id}
                          category={category}
                          checked={selected.has(category.id)}
                          onChange={(on) => toggle(category.id, on)}
                        />
                      ))}
                    </fieldset>
                  )}
                </div>

                {chosen.some((c) => c.external.length > 0) && (
                  <p className="muted small">
                    Folders you chose that live outside Gezel’s own storage are never deleted.
                  </p>
                )}
              </>
            )}

            {busy && job && (
              <p className="muted small" aria-live="polite">
                {job.phase === 'quiesce' && 'Checking nothing is in use…'}
                {job.phase === 'delete' && `Deleting ${job.currentLabel ?? '…'}`}
                {job.phase === 'verify-recovery' && 'Tidying up…'}
                {job.totalItems > 0 && ` (${job.itemsDone}/${job.totalItems})`}
              </p>
            )}

            {finished && job && <CleanupOutcome job={job} />}

            {error && (
              <p className="gz-dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>

          <AlertDialog.Actions>
            <AlertDialog.Cancel asChild>
              <button type="button" className="secondary" disabled={busy}>
                {finished ? 'Close' : 'Cancel'}
              </button>
            </AlertDialog.Cancel>
            {!finished && (
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || chosen.length === 0}
                  onClick={(event) => {
                    event.preventDefault();
                    void start();
                  }}
                >
                  {busy
                    ? 'Deleting…'
                    : destroysUserContent
                      ? 'Delete selected content permanently'
                      : `Free ${formatBytes(freeing)}`}
                </button>
              </AlertDialog.Action>
            )}
          </AlertDialog.Actions>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function CategoryChoice({
  category,
  checked,
  onChange,
}: {
  category: StorageCategory;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={category.bytes === 0}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>
          {category.label} — {formatBytes(category.bytes)}
        </strong>
        <small>{category.description}</small>
      </span>
    </label>
  );
}

function CleanupOutcome({ job }: { job: StorageJob }) {
  if (job.status === 'error') {
    return (
      <p className="gz-dialog-error" role="alert">
        {job.error ?? 'Cleanup failed.'}
      </p>
    );
  }
  return (
    <div className="gz-cleanup-outcome">
      <p>
        {job.status === 'cancelled'
          ? `Stopped early after freeing ${formatBytes(job.bytesDone)}.`
          : `Freed ${formatBytes(job.bytesDone)}.`}
      </p>
      {job.skippedExternal.length > 0 && (
        <>
          <p className="muted small">Left alone, because they live outside Gezel’s storage:</p>
          <ul className="storage-list">
            {job.skippedExternal.map((skipped) => (
              <li key={skipped.path}>
                <span className="storage-list-label">
                  {skipped.label} — <code>{skipped.path}</code>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {job.restartRequired && <p className="muted small">Restart Gezel to pick up the changes.</p>}
    </div>
  );
}
