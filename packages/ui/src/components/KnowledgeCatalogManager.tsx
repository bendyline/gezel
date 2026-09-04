import type {
  CatalogItemSummary,
  KnowledgeCatalogItemManifest,
  KnowledgeInstallRequest,
} from '@bendyline/gezel';
import {
  GezelApiError,
  type IncompleteKnowledgeDownload,
  type KnowledgeAvailableCatalog,
  type KnowledgeCatalogStatus,
  type KnowledgeInstallEvent,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  MODEL_INVENTORY_CHANGED_EVENT,
  announceInventoryChanged,
  changedInventoryKey,
} from '../model-inventory.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HuggingFaceRepoLink, huggingFaceRepoUrl } from './HuggingFaceRepoLink.js';
import { IncompleteDownloads } from './IncompleteDownloads.js';
import { InstallProgressRow } from './InstallProgressRow.js';
import { LicenseButton } from './LicenseButton.js';
import { formatBytes } from './engine-pill-stats.js';

/**
 * Settings → Knowledge: the knowledge-catalog twin of LlamaCppModelManager.
 * Installs are background jobs on the daemon — this view starts them (SSE for
 * the ones it kicks off, a 2 s poll for the ones another window or the
 * auto-updater started), shows progress, cancels explicitly, resumes partial
 * downloads, and browses the gilde catalog of `.gezk` files with the same
 * card chrome the model downloader uses. Everything the daemon knows about
 * a catalog (installed, downloading, partial, shared on this device, newer
 * version) arrives pre-joined from `/api/knowledge/available`.
 */

type InstallSource = KnowledgeInstallRequest['source'];

interface ActiveInstall {
  jobId: string;
  /** The catalog id for catalog installs; a file or URL install learns it at `done`. */
  catalogId?: string;
  phase: 'download' | 'verifying' | 'extract' | 'embedder' | 'retrying';
  bytesDone: number;
  bytesTotal: number;
  retrying?: { attempt: number; maxAttempts: number; delayMs: number; reason: string };
  error?: string;
  /**
   * `local` — this view started the job and holds its SSE controller;
   * `remote` — discovered through the active-installs poll. Cancel works
   * for both: the job lives on the daemon either way.
   */
  origin: 'local' | 'remote';
  controller?: AbortController;
  /** Kept so Retry can resubmit a file or URL install. */
  source?: InstallSource;
}

const NETWORK_BLOCKED_MESSAGE =
  'Downloading knowledge catalogs needs app network access, which the security policy turns off (Settings → Security).';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function installErrorMessage(err: unknown): string {
  if (err instanceof GezelApiError && err.status === 403) return NETWORK_BLOCKED_MESSAGE;
  return `download failed: ${describe(err)}`;
}

function catalogStateLabel(c: KnowledgeCatalogStatus): string {
  if (c.disabledReason) return `quarantined — ${c.disabledReason}`;
  if (!c.enabled) return 'disabled';
  if (!c.mounted) return 'enabled (not mounted)';
  return c.vectorCompatible === false ? 'active · keyword search only' : 'active';
}

function searchModeLabel(c: KnowledgeCatalogStatus): string {
  if (c.semanticSearch === 'keyword-only' || c.vectorCompatible === false) return 'Keyword only';
  return 'Semantic';
}

function formatReleased(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

function progressLabel(inst: ActiveInstall): string {
  if (inst.error) return inst.error;
  if (inst.retrying) {
    const delaySec = Math.max(1, Math.round(inst.retrying.delayMs / 1000));
    return `${inst.retrying.reason} — retrying in ${delaySec}s (attempt ${inst.retrying.attempt}/${inst.retrying.maxAttempts})`;
  }
  switch (inst.phase) {
    case 'download':
      return inst.bytesTotal > 0
        ? `Downloading ${formatBytes(inst.bytesDone)} of ${formatBytes(inst.bytesTotal)}`
        : inst.bytesDone > 0
          ? `Downloading ${formatBytes(inst.bytesDone)}…`
          : 'Preparing download…';
    case 'retrying':
      return 'Connection dropped — retrying…';
    case 'verifying':
      return 'Checking download…';
    case 'extract':
      return 'Unpacking and verifying the catalog…';
    case 'embedder':
      return 'Fetching the search model for this catalog…';
  }
}

function progressPercent(inst: ActiveInstall): number | null {
  if (inst.error || inst.retrying || inst.phase !== 'download' || inst.bytesTotal <= 0) return null;
  return (inst.bytesDone / inst.bytesTotal) * 100;
}

function asKnowledgeEntry(
  manifest: CatalogItemSummary['manifest'],
): KnowledgeCatalogItemManifest | null {
  return manifest.kind === 'knowledge-catalog' ? manifest : null;
}

type KnowledgeSourceKind = 'file' | 'url';

/**
 * The renderer cannot check whether a local file exists, but it can avoid
 * presenting an install action for text that is not an absolute `.gezk`
 * path or a well-formed HTTP(S) URL.
 */
function knowledgeSourceKind(source: string): KnowledgeSourceKind | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return 'url';
    } catch {
      // Keep malformed URLs hidden while the user finishes typing.
    }
  }

  if (!/\.gezk$/i.test(trimmed)) return null;
  const isWindowsDrivePath = /^[a-z]:[\\/]/i.test(trimmed);
  const isUncPath = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(trimmed);
  const isPosixPath = trimmed.startsWith('/');
  return isWindowsDrivePath || isUncPath || isPosixPath ? 'file' : null;
}

export function KnowledgeCatalogManager() {
  const [catalogs, setCatalogs] = useState<KnowledgeCatalogStatus[] | null>(null);
  const [available, setAvailable] = useState<Map<string, KnowledgeAvailableCatalog>>(new Map());
  const [incomplete, setIncomplete] = useState<IncompleteKnowledgeDownload[]>([]);
  const [installs, setInstalls] = useState<Map<string, ActiveInstall>>(new Map());
  const [installError, setInstallError] = useState<string | null>(null);
  const [installWarning, setInstallWarning] = useState<{ id: string; message: string } | null>(
    null,
  );
  // A pinned-digest mismatch on a commit-pinned URL means the catalog entry
  // is wrong or the download was tampered with. Unlike model files, there is
  // no "download anyway": nothing was installed and nothing should be.
  const [installMismatch, setInstallMismatch] = useState<{
    id: string;
    expected: string;
    actual: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState('');
  const [digestDraft, setDigestDraft] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const hadRemoteInstallRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [installed, offered, partial] = await Promise.all([
        api.listKnowledgeCatalogs(),
        api.listAvailableKnowledgeCatalogs().catch(() => ({ catalogs: [] })),
        api.listIncompleteKnowledgeDownloads().catch(() => ({ incomplete: [] })),
      ]);
      setCatalogs(installed.catalogs);
      setAvailable(new Map(offered.catalogs.map((c) => [c.id, c])));
      setIncomplete(partial.incomplete);
    } catch (err) {
      setError(describe(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = (event: Event) => {
      if (changedInventoryKey(event) === 'knowledge') void refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // Installs another path started (the auto-updater, another window) show
  // up through the polled snapshot; rows this view started keep their own
  // finer-grained SSE state.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.listKnowledgeActiveInstalls();
        if (cancelled) return;
        setInstalls((prev) => {
          const next = new Map(prev);
          const seen = new Set<string>();
          for (const remote of res.installs) {
            seen.add(remote.jobId);
            const existing = next.get(remote.jobId);
            if (existing?.origin === 'local') continue;
            next.set(remote.jobId, {
              jobId: remote.jobId,
              ...(remote.catalogId ? { catalogId: remote.catalogId } : {}),
              phase: remote.phase,
              bytesDone: remote.bytesDone,
              bytesTotal: remote.bytesTotal,
              origin: 'remote',
            });
          }
          for (const [id, entry] of next) {
            if (entry.origin === 'remote' && !seen.has(id)) next.delete(id);
          }
          return next;
        });
        const hadRemoteInstall = hadRemoteInstallRef.current;
        hadRemoteInstallRef.current = res.installs.length > 0;
        if (hadRemoteInstall && res.installs.length === 0) void refresh();
      } catch {
        /* service blip — try again on the next tick */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const handleEvent = useCallback((jobId: string, ev: KnowledgeInstallEvent) => {
    if (ev.type === 'progress') {
      setInstalls((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        const { retrying: _retrying, error: _error, ...rest } = cur;
        next.set(jobId, {
          ...rest,
          phase: ev.phase,
          bytesDone: ev.bytesDone,
          bytesTotal: ev.bytesTotal || (ev.phase === cur.phase ? cur.bytesTotal : 0),
        });
        return next;
      });
    } else if (ev.type === 'retrying') {
      setInstalls((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, {
          ...cur,
          retrying: {
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            reason: ev.reason,
          },
        });
        return next;
      });
    } else if (ev.type === 'verifying') {
      setInstalls((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, { ...cur, phase: 'verifying' });
        return next;
      });
    } else if (ev.type === 'done') {
      if (ev.warning) setInstallWarning({ id: ev.ref.catalogId, message: ev.warning });
    } else if (ev.type === 'error') {
      if (ev.mismatch) {
        setInstalls((prev) => {
          const next = new Map(prev);
          next.delete(jobId);
          return next;
        });
        setInstallMismatch({ id: jobId, ...ev.mismatch });
        return;
      }
      // Keep the row so the user can Retry inline; the next attempt resumes
      // the `.partial` the daemon kept.
      setInstalls((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, { ...cur, error: ev.error, retrying: undefined });
        return next;
      });
      setInstallError(ev.error);
    }
  }, []);

  const finishJob = useCallback(
    (jobId: string) => {
      setInstalls((prev) => {
        const next = new Map(prev);
        const cur = next.get(jobId);
        if (cur?.error) {
          next.set(jobId, { ...cur, controller: undefined });
          return next;
        }
        next.delete(jobId);
        return next;
      });
      announceInventoryChanged('knowledge');
      void refresh();
    },
    [refresh],
  );

  const failJob = useCallback((jobId: string, controller: AbortController, err: unknown) => {
    if (controller.signal.aborted) return;
    const message = installErrorMessage(err);
    setInstallError(message);
    setInstalls((prev) => {
      const cur = prev.get(jobId);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(jobId, { ...cur, error: cur.error ?? message, retrying: undefined });
      return next;
    });
  }, []);

  /** Install a gilde entry; the job id is the catalog id, so a repeat click attaches. */
  const startCatalogInstall = useCallback(
    (catalogId: string, opts?: { version?: string }) => {
      if (installs.has(catalogId)) return;
      setInstallError(null);
      setInstallMismatch(null);
      const controller = new AbortController();
      setInstalls((prev) => {
        const next = new Map(prev);
        next.set(catalogId, {
          jobId: catalogId,
          catalogId,
          phase: 'download',
          bytesDone: 0,
          bytesTotal: 0,
          origin: 'local',
          controller,
        });
        return next;
      });
      void (async () => {
        try {
          await api.installKnowledgeCatalogFromCatalog(
            catalogId,
            (ev) => handleEvent(catalogId, ev),
            controller.signal,
            opts?.version ? { version: opts.version } : undefined,
          );
        } catch (err) {
          failJob(catalogId, controller, err);
        } finally {
          finishJob(catalogId);
        }
      })();
    },
    [installs, handleEvent, failJob, finishJob],
  );

  /** Install from a file path or URL: start the job, then follow its stream. */
  const startSourceInstall = useCallback(
    async (source: InstallSource) => {
      setInstallError(null);
      setInstallMismatch(null);
      let jobId: string;
      try {
        ({ jobId } = await api.installKnowledgeCatalog({ source }));
      } catch (err) {
        setInstallError(installErrorMessage(err));
        return;
      }
      const controller = new AbortController();
      setInstalls((prev) => {
        const next = new Map(prev);
        next.set(jobId, {
          jobId,
          phase: source.kind === 'file' ? 'verifying' : 'download',
          bytesDone: 0,
          bytesTotal: 0,
          origin: 'local',
          controller,
          source,
        });
        return next;
      });
      try {
        await api.subscribeKnowledgeInstall(
          jobId,
          (ev) => handleEvent(jobId, ev),
          controller.signal,
        );
        setSourceDraft('');
        setDigestDraft('');
      } catch (err) {
        failJob(jobId, controller, err);
      } finally {
        finishJob(jobId);
      }
    },
    [handleEvent, failJob, finishJob],
  );

  const cancelInstall = useCallback(
    (jobId: string) => {
      const inflight = installs.get(jobId);
      inflight?.controller?.abort();
      void api.cancelKnowledgeJob(jobId).catch(() => {});
      setInstalls((prev) => {
        const next = new Map(prev);
        next.delete(jobId);
        return next;
      });
      void refresh();
    },
    [installs, refresh],
  );

  const retryInstall = useCallback(
    (inst: ActiveInstall) => {
      setInstalls((prev) => {
        const next = new Map(prev);
        next.delete(inst.jobId);
        return next;
      });
      setInstallError(null);
      if (inst.catalogId) startCatalogInstall(inst.catalogId);
      else if (inst.source) void startSourceInstall(inst.source);
    },
    [startCatalogInstall, startSourceInstall],
  );

  const startDraftInstall = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      const sourceKind = knowledgeSourceKind(trimmed);
      if (!sourceKind) return;
      setError(null);
      const expectedSha256 = digestDraft.trim().toLowerCase();
      if (sourceKind === 'url' && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        setError('Paste the publisher-provided SHA-256 digest before installing a URL.');
        return;
      }
      await startSourceInstall(
        sourceKind === 'url'
          ? { kind: 'url', url: trimmed, expectedSha256 }
          : { kind: 'file', path: trimmed },
      );
    },
    [digestDraft, startSourceInstall],
  );

  const browseForArchive = useCallback(async () => {
    const picked = await window.__GEZEL__?.selectKnowledgeArchive?.();
    if (picked) {
      setSourceDraft(picked);
      await startDraftInstall(picked);
    }
  }, [startDraftInstall]);

  const setEnabled = useCallback(
    async (catalogId: string, enabled: boolean) => {
      setError(null);
      try {
        await api.updateKnowledgeCatalog(catalogId, { enabled });
      } catch (err) {
        setError(describe(err));
      }
      announceInventoryChanged('knowledge');
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (catalogId: string) => {
      setConfirmRemove(null);
      setError(null);
      try {
        await api.removeKnowledgeCatalog(catalogId);
      } catch (err) {
        setError(describe(err));
      }
      announceInventoryChanged('knowledge');
      await refresh();
    },
    [refresh],
  );

  const deleteIncomplete = useCallback(
    async (key: string) => {
      setError(null);
      setIncomplete((cur) => cur.filter((d) => d.key !== key));
      try {
        await api.deleteIncompleteKnowledgeDownload(key);
      } catch (err) {
        setError(describe(err));
      }
      await refresh();
    },
    [refresh],
  );

  const incompleteRows = useMemo(
    () =>
      incomplete
        .filter((d) => !(d.catalogId && installs.has(d.catalogId)))
        .map((d) => ({
          id: d.key,
          name: d.name ?? d.catalogId ?? d.key,
          bytes: d.bytes,
          updatedAt: d.updatedAt,
          hasPartial: true,
          resumable: d.resumable,
        })),
    [incomplete, installs],
  );
  const incompleteByKey = useMemo(() => new Map(incomplete.map((d) => [d.key, d])), [incomplete]);

  const removing = catalogs?.find((c) => c.ref.catalogId === confirmRemove);
  const sourceKind = knowledgeSourceKind(sourceDraft);
  const isUrlSource = sourceKind === 'url';
  const hasValidDigest = /^[a-fA-F0-9]{64}$/.test(digestDraft.trim());
  const draftInstalling = [...installs.values()].some((i) => i.source && !i.error);
  const canInstall = sourceKind !== null && (!isUrlSource || hasValidDigest) && !draftInstalling;

  return (
    <div className="ollama-model-manager" data-testid="knowledge-catalog-manager">
      {installs.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(installs.values()).map((inst) => (
              <InstallProgressRow
                key={inst.jobId}
                title={<code>{inst.catalogId ?? inst.source?.kind ?? inst.jobId}</code>}
                status={progressLabel(inst)}
                percent={progressPercent(inst)}
                tone={inst.error ? 'error' : inst.retrying ? 'warning' : 'normal'}
                onCancel={() => cancelInstall(inst.jobId)}
                {...(inst.catalogId || inst.source ? { onRetry: () => retryInstall(inst) } : {})}
              />
            ))}
          </div>
        </div>
      )}

      <IncompleteDownloads
        items={incompleteRows}
        onResume={(key) => {
          const row = incompleteByKey.get(key);
          if (row?.catalogId) startCatalogInstall(row.catalogId);
        }}
        onDelete={(key) => void deleteIncomplete(key)}
      />

      {installMismatch && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            The download of <code>{installMismatch.id}</code> did not match the catalog's pinned
            checksum
          </div>
          <p style={{ marginBottom: '0.5rem' }}>
            Nothing was installed. The bytes Gezel received are not the release this build's catalog
            vouches for, so either the catalog entry is wrong or the download was tampered with. Try
            again later, or wait for a Gezel update with a refreshed catalog.
          </p>
          <button type="button" className="gz-link-button" onClick={() => setInstallMismatch(null)}>
            Dismiss
          </button>
        </div>
      )}

      {installError && (
        <div className="ollama-section">
          <p className="error" style={{ marginBottom: '0.5rem' }}>
            {installError}
          </p>
        </div>
      )}

      {installWarning && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            {installWarning.id}: {installWarning.message}
          </div>
        </div>
      )}

      <div className="ollama-section">
        <h4>Installed catalogs</h4>
        {catalogs === null && <p className="muted small">loading…</p>}
        {catalogs?.length === 0 && (
          <p className="muted small">
            Nothing installed yet. Download one below, build one from a folder of Markdown with{' '}
            <code>gezel knowledge init</code> and <code>gezel knowledge build</code>, or install a
            published .gezk file.
          </p>
        )}
        {catalogs && catalogs.length > 0 && (
          <div className="ollama-model-table-wrap">
            <table className="ollama-model-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Documents</th>
                  <th>Size</th>
                  <th title="Semantic search embeds your question with the catalog's own model; keyword-only catalogs match words">
                    Search
                  </th>
                  <th>Storage</th>
                  <th>Status</th>
                  <th>Enabled</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {catalogs.map((c) => {
                  const updating = installs.has(c.ref.catalogId);
                  return (
                    <tr key={c.ref.catalogId} data-testid={`knowledge-catalog-${c.ref.catalogId}`}>
                      <td className="model-name-table-cell">
                        <div className="model-name-cell">
                          <strong>{c.name ?? c.ref.catalogId}</strong>
                          <div className="model-name-meta">
                            <code>{c.ref.catalogId}</code>
                            {c.language && <span className="muted small">{c.language}</span>}
                            {c.updateAvailable && (
                              <span
                                className="gz-status-pill gz-status-pill--warn"
                                title={`A newer release is available in the catalog (→ v${c.availableVersion ?? ''}).`}
                              >
                                update available
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>v{c.ref.version}</td>
                      <td>{c.documents !== undefined ? c.documents.toLocaleString() : '—'}</td>
                      <td>{c.sizeBytes ? formatBytes(c.sizeBytes) : '—'}</td>
                      <td>{c.mounted ? searchModeLabel(c) : '—'}</td>
                      <td
                        title={
                          c.ref.storageScope === 'machine-shared'
                            ? 'Installed once for everyone on this device; removing it only drops it from your account.'
                            : 'Stored in your own home folder.'
                        }
                      >
                        {c.ref.storageScope === 'machine-shared'
                          ? 'Shared on this device'
                          : 'Only for you'}
                      </td>
                      <td className={c.disabledReason ? 'error' : undefined}>
                        {catalogStateLabel(c)}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Enable ${c.name ?? c.ref.catalogId}`}
                          checked={c.enabled}
                          onChange={(e) => void setEnabled(c.ref.catalogId, e.target.checked)}
                        />
                      </td>
                      <td className="model-actions-table-cell">
                        <div className="model-action-links">
                          {c.updateAvailable && c.source === 'gilde' && (
                            <button
                              type="button"
                              className="gz-link-button"
                              disabled={updating}
                              onClick={() => startCatalogInstall(c.ref.catalogId)}
                            >
                              Update
                            </button>
                          )}
                          <button
                            type="button"
                            className="gz-link-button danger"
                            disabled={updating}
                            onClick={() => setConfirmRemove(c.ref.catalogId)}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ollama-section ollama-section--flat ollama-section--download">
        <h4>Download a catalog</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Knowledge catalogs are hosted by{' '}
          <a
            href="https://huggingface.co"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit' }}
          >
            Hugging Face
          </a>{' '}
          as open datasets in the gezk format. Your device downloads them directly and checks every
          byte against the checksum this version of Gezel pinned.
        </p>
        <CatalogBrowser
          kind="knowledge-catalog"
          emptyMessage="No knowledge catalogs in the catalog for this build yet."
          action={(item: CatalogItemSummary) => {
            const m = asKnowledgeEntry(item.manifest);
            if (!m) return null;
            const state = available.get(m.id);
            const inflight = installs.get(m.id);
            const pct = inflight ? progressPercent(inflight) : null;
            const installed = state?.installed;
            const updateAvailable = installed?.updateAvailable ?? false;
            const disabled = Boolean(inflight) || (Boolean(installed) && !updateAvailable);
            const label = inflight
              ? inflight.phase === 'download'
                ? pct !== null
                  ? `Downloading… ${Math.round(pct)}%`
                  : 'Downloading…'
                : inflight.phase === 'embedder'
                  ? 'Fetching search model…'
                  : 'Installing…'
              : installed
                ? updateAvailable
                  ? `Update to v${m.version}`
                  : 'Installed'
                : state?.incompleteDownload
                  ? 'Resume download'
                  : state?.sharedOnDevice
                    ? 'Add'
                    : 'Download';
            const released = formatReleased(m.releasedAt);
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <HuggingFaceRepoLink repo={m.huggingface.repo} repoType="dataset" />
                    <span>·</span>
                    <span>{formatBytes(m.archiveBytes)}</span>
                    <span>·</span>
                    <span>{m.documents.toLocaleString()} documents</span>
                    <span>·</span>
                    <span>{m.language}</span>
                    {released && (
                      <>
                        <span>·</span>
                        <span>{released}</span>
                      </>
                    )}
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton
                      manifest={m}
                      fallbackHref={huggingFaceRepoUrl(m.huggingface.repo, 'dataset')}
                    />
                    {m.parquet && (
                      <a
                        className="hf-repo-link"
                        href={`${huggingFaceRepoUrl(m.parquet.repo, 'dataset')}/tree/${encodeURIComponent(m.parquet.revision)}/${m.parquet.dir.split('/').map(encodeURIComponent).join('/')}`}
                        target="_blank"
                        rel="noreferrer"
                        title="The same documents, chunks and embeddings as Parquet tables, for data tools"
                      >
                        Parquet
                      </a>
                    )}
                    {state?.sharedOnDevice && !installed && (
                      <span
                        className="gz-status-pill gz-status-pill--ok"
                        title="Another account on this device already installed it; adding it to yours takes no download."
                      >
                        on this device
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  title={
                    installed && !updateAvailable
                      ? `Installed (v${installed.version})`
                      : state?.incompleteDownload
                        ? 'A partial download is on disk; installing picks up where it stopped.'
                        : undefined
                  }
                  onClick={() => startCatalogInstall(m.id)}
                >
                  {label}
                </button>
              </div>
            );
          }}
        />
      </div>

      <div className="ollama-section ollama-section--flat">
        <h4>Add from a file or URL</h4>
        <div className="new-row" style={{ alignItems: 'center' }}>
          <input
            type="text"
            style={{ flex: 1 }}
            placeholder="Path to a .gezk file, or an https:// URL"
            aria-label="Catalog file path or URL"
            value={sourceDraft}
            onChange={(e) => setSourceDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canInstall) void startDraftInstall(sourceDraft);
            }}
          />
          {window.__GEZEL__?.selectKnowledgeArchive && (
            <button type="button" onClick={() => void browseForArchive()}>
              Browse…
            </button>
          )}
          {sourceKind !== null && (
            <button
              type="button"
              disabled={!canInstall}
              onClick={() => void startDraftInstall(sourceDraft)}
            >
              Install
            </button>
          )}
        </div>
        {isUrlSource && (
          <div style={{ marginTop: '0.5rem' }}>
            <input
              type="text"
              style={{ width: '100%' }}
              placeholder="Publisher SHA-256 digest (64 hexadecimal characters)"
              aria-label="Catalog SHA-256 digest"
              value={digestDraft}
              spellCheck={false}
              autoCapitalize="none"
              onChange={(e) => setDigestDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canInstall) void startDraftInstall(sourceDraft);
              }}
            />
            <p className="muted small" style={{ margin: '0.35rem 0 0' }}>
              Remote catalogs are installed only when their bytes match a SHA-256 digest you
              received from the publisher.
            </p>
          </div>
        )}
      </div>

      {error && <p className="error small">{error}</p>}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove ${removing?.name ?? confirmRemove ?? ''}?`}
        message={
          removing?.ref.storageScope === 'machine-shared'
            ? 'Removes this catalog from your account. The shared copy other people on this device use is not touched.'
            : removing?.source === 'gilde'
              ? 'Deletes this catalog and its files from your account. You can download it again from the catalog any time.'
              : 'Deletes this catalog and its files from your account. If you built it yourself and no longer have the .gezk, this is the only copy.'
        }
        confirmLabel="Remove catalog"
        danger
        onConfirm={() => {
          if (confirmRemove) void remove(confirmRemove);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
