import type { StorageCategory, StorageSummary } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { requestBackupRestore } from './BackupRestoreDialog.js';
import { requestStorageCleanup } from './StorageCleanupDialog.js';
import { formatBytes } from './model-memory-copy.js';

/**
 * Settings → About → "Storage on this device".
 *
 * The point of showing this is that uninstalling Gezel does not reclaim any
 * of it. An npm uninstall gets no hook at all, and the Windows and Linux
 * installers deliberately leave the home folder alone — so without a place
 * to see the number, people remove the app and strand tens of gigabytes of
 * downloaded models they will never think about again.
 */

function categoriesOfClass(
  summary: StorageSummary,
  cls: StorageCategory['class'],
): StorageCategory[] {
  return summary.categories
    .filter((c) => c.class === cls && c.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

export function StorageUsageCard() {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      setSummary(await api.storageSummary(refresh ? { refresh: true } : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const redownloadable = summary ? categoriesOfClass(summary, 'redownloadable') : [];
  const userContent = summary ? categoriesOfClass(summary, 'user-content') : [];
  const programFiles = summary ? categoriesOfClass(summary, 'uninstaller-owned') : [];
  const externalPaths = summary
    ? summary.categories.flatMap((c) => c.external).filter((e) => e.bytes > 0)
    : [];

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h3>Storage on this device</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything Gezel keeps lives in <code>{summary?.home ?? '~/.gezel'}</code>. Uninstalling
        Gezel does not remove it, so clear out what you no longer need before you uninstall.
      </p>

      {error && <p className="error">{error}</p>}

      {summary && (
        <>
          <dl>
            <dt>Downloads Gezel can fetch again</dt>
            <dd>{formatBytes(summary.redownloadableBytes)}</dd>
            <dt>Your gezels, projects, and documents</dt>
            <dd>{formatBytes(summary.userContentBytes)}</dd>
          </dl>

          <button
            type="button"
            className="link-button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide the breakdown' : 'Show what is using the space'}
          </button>

          {expanded && (
            <div className="storage-breakdown">
              <StorageGroup
                heading="Can be downloaded again"
                note="Deleting these costs a download, not your work."
                categories={redownloadable}
              />
              <StorageGroup
                heading="Your content"
                note="Only you can replace these. Back them up before deleting anything."
                categories={userContent}
              />
              {programFiles.length > 0 && (
                <StorageGroup
                  heading="Gezel program files"
                  note="Removed by the uninstaller and re-created on launch."
                  categories={programFiles}
                />
              )}
              {externalPaths.length > 0 && (
                <div className="storage-group">
                  <h4>Stored outside the Gezel folder</h4>
                  <p className="muted small">
                    Gezel never deletes these — they are folders you chose.
                  </p>
                  <ul className="storage-list">
                    {externalPaths.map((entry) => (
                      <li key={entry.path}>
                        <span className="storage-list-label">
                          <code>{entry.path}</code>
                        </span>
                        <span className="storage-list-bytes">{formatBytes(entry.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="storage-actions">
        <button type="button" onClick={() => requestStorageCleanup()}>
          Free up space…
        </button>
        <button type="button" onClick={() => requestBackupRestore({ tab: 'backup' })}>
          Back up my content…
        </button>
        <button type="button" onClick={() => requestBackupRestore({ tab: 'restore' })}>
          Restore from a backup…
        </button>
      </div>

      <p className="muted small" style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          className="link-button"
          onClick={() => void load(true)}
          disabled={busy}
        >
          {busy ? 'Measuring…' : 'Measure again'}
        </button>
        {summary && !busy && ` · measured ${new Date(summary.measuredAt).toLocaleTimeString()}`}
      </p>
    </section>
  );
}

function StorageGroup({
  heading,
  note,
  categories,
}: {
  heading: string;
  note: string;
  categories: StorageCategory[];
}) {
  if (categories.length === 0) return null;
  return (
    <div className="storage-group">
      <h4>{heading}</h4>
      <p className="muted small">{note}</p>
      <ul className="storage-list">
        {categories.map((c) => (
          <li key={c.id}>
            <span className="storage-list-label">
              {c.label}
              <span className="muted small"> — {c.description}</span>
            </span>
            <span className="storage-list-bytes">{formatBytes(c.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
