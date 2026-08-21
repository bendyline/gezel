import type { KnowledgeCatalogStatus } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Settings → Knowledge: install, enable/disable, and remove `.gezk`
 * knowledge catalogs for THIS user. Mirrors GildeUpdatesCard's shape —
 * the install engine lives in the daemon; this card starts jobs and polls
 * them (the pollUntilIdle pattern), then tells the sidebar gate via
 * `gezel:knowledge-catalogs-updated`.
 */

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function catalogStateLabel(c: KnowledgeCatalogStatus): string {
  if (c.disabledReason) return `quarantined — ${c.disabledReason}`;
  if (!c.enabled) return 'disabled';
  if (!c.mounted) return 'enabled (not mounted)';
  return c.vectorCompatible === false ? 'active · keyword search only' : 'active';
}

interface InstallProgress {
  jobId: string;
  phase: string;
  pct: number | null;
  error: string | null;
}

export function KnowledgeCatalogsCard() {
  const [catalogs, setCatalogs] = useState<KnowledgeCatalogStatus[] | null>(null);
  const [sourceDraft, setSourceDraft] = useState('');
  const [install, setInstall] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const notifyChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('gezel:knowledge-catalogs-updated'));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listKnowledgeCatalogs();
      setCatalogs(r.catalogs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, [refresh]);

  const pollJob = useCallback(
    (jobId: string) => {
      let remaining = 2400; // 250ms cadence ≈ 10 minutes; large downloads take time
      const tick = async () => {
        try {
          const job = await api.getKnowledgeJob(jobId);
          const last = job.events[job.events.length - 1];
          if (last?.type === 'progress') {
            const done = Number(last.bytesDone ?? 0);
            const total = Number(last.bytesTotal ?? 0);
            setInstall({
              jobId,
              phase: String(last.phase ?? 'working'),
              pct: total > 0 ? Math.floor((done / total) * 100) : null,
              error: null,
            });
          }
          if (job.finished) {
            if (job.error) {
              setInstall({ jobId, phase: 'error', pct: null, error: job.error });
            } else {
              setInstall(null);
              setSourceDraft('');
            }
            await refresh();
            notifyChanged();
            return;
          }
        } catch {
          /* transient — keep polling */
        }
        remaining--;
        if (remaining > 0) {
          pollTimer.current = window.setTimeout(() => void tick(), 250);
        }
      };
      void tick();
    },
    [refresh, notifyChanged],
  );

  const startInstall = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;
      setError(null);
      const isUrl = /^https?:\/\//i.test(trimmed);
      try {
        const { jobId } = await api.installKnowledgeCatalog({
          source: isUrl ? { kind: 'url', url: trimmed } : { kind: 'file', path: trimmed },
        });
        setInstall({ jobId, phase: 'starting', pct: null, error: null });
        pollJob(jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [pollJob],
  );

  const browseForArchive = useCallback(async () => {
    const picked = await window.__GEZEL__?.selectKnowledgeArchive?.();
    if (picked) {
      setSourceDraft(picked);
      await startInstall(picked);
    }
  }, [startInstall]);

  const setEnabled = useCallback(
    async (catalogId: string, enabled: boolean) => {
      setError(null);
      try {
        await api.updateKnowledgeCatalog(catalogId, { enabled });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      await refresh();
      notifyChanged();
    },
    [refresh, notifyChanged],
  );

  const remove = useCallback(
    async (catalogId: string) => {
      setConfirmRemove(null);
      setError(null);
      try {
        await api.removeKnowledgeCatalog(catalogId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      await refresh();
      notifyChanged();
    },
    [refresh, notifyChanged],
  );

  const removing = catalogs?.find((c) => c.ref.catalogId === confirmRemove);

  return (
    <section style={{ marginBottom: '2rem' }} data-testid="knowledge-settings">
      <h3>Knowledge</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Knowledge catalogs are searchable, citable reference libraries — encyclopedias, manuals,
        your own notes — packaged as .gezk files. Installed catalogs appear in the Knowledge area
        and your gezellen can search them and cite their sources. Everything stays on this device.
      </p>

      <div className="ollama-section ollama-section--flat">
        <h4>Add a catalog</h4>
        <div className="new-row" style={{ alignItems: 'center' }}>
          <input
            type="text"
            style={{ flex: 1 }}
            placeholder="Path to a .gezk file, or an https:// URL"
            aria-label="Catalog file path or URL"
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void startInstall(sourceDraft);
            }}
          />
          {window.__GEZEL__?.selectKnowledgeArchive && (
            <button type="button" onClick={() => void browseForArchive()}>
              Browse…
            </button>
          )}
          <button
            type="button"
            disabled={!sourceDraft.trim() || (install !== null && !install.error)}
            onClick={() => void startInstall(sourceDraft)}
          >
            Install
          </button>
        </div>
        {install && !install.error && (
          <div className="ollama-pull" style={{ marginTop: '0.5rem' }}>
            <div className="ollama-pull-head">
              <span className="muted small">
                {install.phase === 'download' ? 'Downloading…' : 'Installing…'}
              </span>
            </div>
            {install.pct !== null ? (
              <div className="ollama-pull-bar">
                <div className="ollama-pull-bar-fill" style={{ width: `${install.pct}%` }} />
                <span className="ollama-pull-bar-label">{install.pct}%</span>
              </div>
            ) : (
              <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
                <div className="ollama-pull-bar-fill" />
              </div>
            )}
          </div>
        )}
        {install?.error && <p className="error small">{install.error}</p>}
      </div>

      <div className="ollama-section ollama-section--flat">
        <h4>Installed catalogs</h4>
        {catalogs === null && <p className="muted small">loading…</p>}
        {catalogs?.length === 0 && (
          <p className="muted small">
            Nothing installed yet. Build one from a folder of Markdown with{' '}
            <code>gezel knowledge init</code> and <code>gezel knowledge build</code>, or install a
            published .gezk above.
          </p>
        )}
        {(catalogs ?? []).map((c) => (
          <div
            key={c.ref.catalogId}
            className="ollama-pull"
            data-testid={`knowledge-catalog-${c.ref.catalogId}`}
          >
            <div className="ollama-pull-head">
              <strong>{c.name ?? c.ref.catalogId}</strong>
              <span className="muted small">
                v{c.ref.version}
                {c.documents !== undefined ? ` · ${c.documents} documents` : ''}
                {c.sizeBytes ? ` · ${formatBytes(c.sizeBytes)}` : ''}
              </span>
            </div>
            <p
              className={`small${c.disabledReason ? ' error' : ' muted'}`}
              style={{ margin: '0.15rem 0 0.35rem' }}
            >
              {catalogStateLabel(c)}
            </p>
            <div className="new-row" style={{ gap: '0.75rem' }}>
              <label className="new-row" style={{ alignItems: 'center', gap: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onChange={(e) => void setEnabled(c.ref.catalogId, e.target.checked)}
                />
                <span className="small">Enabled</span>
              </label>
              <button
                type="button"
                className="gz-link-button danger"
                onClick={() => setConfirmRemove(c.ref.catalogId)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="error small">{error}</p>}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove ${removing?.name ?? confirmRemove ?? ''}?`}
        message={
          removing?.ref.storageScope === 'machine-shared'
            ? 'Removes this catalog from your account. The shared copy other people on this device use is not touched.'
            : 'Deletes this catalog and its files from your account. If you built it yourself and no longer have the .gezk, this is the only copy.'
        }
        confirmLabel="Remove catalog"
        danger
        onConfirm={() => {
          if (confirmRemove) void remove(confirmRemove);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </section>
  );
}
