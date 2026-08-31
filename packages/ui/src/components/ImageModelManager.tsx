import type {
  ActiveImagePull,
  CatalogItemSummary,
  ImageModelHardwareTier,
  ImageModelManifest,
  ImageModelPullEvent,
  InstalledImageModel,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { LicenseButton } from './LicenseButton.js';

/**
 * Install / pull / delete flow for `image-model` catalog entries.
 * Mirrors {@link OllamaModelManager}'s structure: a list of installed
 * models, the generic {@link CatalogBrowser} for the catalog picker,
 * and a per-entry action button wired to the pull SSE stream. Simpler
 * than Ollama's version — no memory-budget filtering yet (VRAM
 * detection is nontrivial cross-platform) and no auto-resume of
 * interrupted pulls.
 */

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function hardwareTierLabel(tier: ImageModelHardwareTier, minRamGB: number): string {
  switch (tier) {
    case 'low':
      return `Runs on ${minRamGB} GB`;
    case 'mid':
      return `${minRamGB} GB+`;
    case 'high':
      return `${minRamGB} GB+ recommended`;
    case 'workstation':
      return `${minRamGB} GB+ workstation`;
  }
}

interface ActivePull {
  id: string;
  bytesWritten: number;
  totalBytes: number;
  error?: string;
  controller: AbortController;
  /**
   * Most-recent `retrying` SSE event. Present when the shared
   * downloader is waiting between attempts. Cleared on the next
   * `progress` event (resumption happened) or when the install
   * completes / errors. UI uses this to show "Connection dropped —
   * retrying in 4s (attempt 3/5)…" instead of a stuck progress bar.
   */
  retrying?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  };
}

interface Props {
  /** When true, the Install button is disabled — e.g. no engine configured. */
  disabledReason?: string;
  /** Fired after an install / delete so the parent can refresh status pills. */
  onModelsChanged?: () => void;
  /**
   * The `config.defaultImageModel['sd-cpp']` value. Drives which installed
   * row is marked active. When {@link onSetActiveModel} is also supplied the
   * Local models table grows a leading radio column for picking it.
   */
  configuredDefaultModelId?: string;
  /** Persist a new default image model. Enables the active-model radios. */
  onSetActiveModel?: (id: string) => void | Promise<void>;
}

export function ImageModelManager({
  disabledReason,
  onModelsChanged,
  configuredDefaultModelId,
  onSetActiveModel,
}: Props) {
  const [installed, setInstalled] = useState<InstalledImageModel[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Map<string, ActivePull>>(new Map());
  const [toDelete, setToDelete] = useState<string | null>(null);
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;

  const refresh = useCallback(async () => {
    try {
      const res = await api.listInstalledImageModels();
      setInstalled(res.models);
      setInstalledError(null);
    } catch (err) {
      setInstalled([]);
      setInstalledError((err as Error).message);
    }
  }, []);

  /**
   * Attach an SSE subscription for a single in-flight pull. Returns the
   * AbortController used for the fetch, recorded on the pulls map so the
   * Cancel/Retry/unmount paths can detach without cancelling the actual
   * download — the registry owns the pull, this is just a listener.
   */
  const attachSubscription = useCallback(
    (
      id: string,
      subscribe: (cb: (e: ImageModelPullEvent) => void, signal: AbortSignal) => Promise<void>,
    ) => {
      const controller = new AbortController();
      setPulls((prev) => {
        const next = new Map(prev);
        const cur = next.get(id);
        next.set(id, {
          ...(cur ?? { id, bytesWritten: 0, totalBytes: 0 }),
          controller,
        });
        return next;
      });
      void subscribe((event) => {
        if (event.type === 'progress') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (!cur) return prev;
            const { retrying: _drop, ...rest } = cur;
            next.set(id, {
              ...rest,
              bytesWritten: event.bytesWritten,
              totalBytes: event.totalBytes ?? cur.totalBytes,
            });
            return next;
          });
        } else if (event.type === 'retrying') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (!cur) return prev;
            next.set(id, {
              ...cur,
              retrying: {
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                reason: event.reason,
              },
            });
            return next;
          });
        } else if (event.type === 'error') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (cur) next.set(id, { ...cur, error: event.error, retrying: undefined });
            return next;
          });
        } else if (event.type === 'done') {
          // Brief grace window lets the bar stay at 100% before the
          // entry collapses into the Installed list above.
          setTimeout(() => {
            setPulls((prev) => {
              const next = new Map(prev);
              next.delete(id);
              return next;
            });
            void refresh();
            onModelsChanged?.();
          }, 800);
        }
      }, controller.signal).catch((err) => {
        if (controller.signal.aborted) return;
        setPulls((prev) => {
          const next = new Map(prev);
          const cur = next.get(id);
          if (cur) next.set(id, { ...cur, error: (err as Error).message });
          return next;
        });
      });
    },
    [refresh, onModelsChanged],
  );

  useEffect(() => {
    void refresh();
    // Re-attach to any pull the registry started in a previous mount.
    // Without this, leaving Settings → Image generation mid-download and
    // coming back would silently lose the progress bar.
    let cancelled = false;
    void api
      .listActiveImagePulls()
      .then(({ pulls: active }: { pulls: ActiveImagePull[] }) => {
        if (cancelled) return;
        for (const snapshot of active) {
          if (snapshot.finished) continue;
          setPulls((prev) => {
            if (prev.has(snapshot.id)) return prev;
            const next = new Map(prev);
            next.set(snapshot.id, {
              id: snapshot.id,
              bytesWritten: snapshot.bytesWritten,
              totalBytes: snapshot.totalBytes,
              controller: new AbortController(),
              ...(snapshot.retrying ? { retrying: snapshot.retrying } : {}),
              ...(snapshot.error ? { error: snapshot.error } : {}),
            });
            return next;
          });
          attachSubscription(snapshot.id, (cb, signal) =>
            api.subscribeImagePull(snapshot.id, cb, signal),
          );
        }
      })
      .catch(() => {
        /* server may be down; nothing to reattach */
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, attachSubscription]);

  const startPull = useCallback(
    (id: string) => {
      if (pullsRef.current.has(id)) return;
      attachSubscription(id, (cb, signal) => api.pullImageModel(id, cb, signal));
    },
    [attachSubscription],
  );

  const retryPull = useCallback(
    (id: string) => {
      // Retry is allowed to replace the terminal row that is still in
      // `pullsRef`. Calling startPull here would see that stale row during
      // this React tick and return without starting anything, even after a
      // queued setPulls(delete). Attach directly so the fresh subscription
      // is enqueued immediately; React applies these state updates in order.
      pullsRef.current.get(id)?.controller.abort();
      setPulls((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      attachSubscription(id, (cb, signal) => api.pullImageModel(id, cb, signal));
    },
    [attachSubscription],
  );

  const cancelPull = useCallback((id: string) => {
    // Tell the registry to actually abort the download. We optimistically
    // remove the row; the SSE will close shortly after with an error
    // event that we ignore since the entry is already gone.
    const pull = pullsRef.current.get(id);
    pull?.controller.abort();
    setPulls((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    void api.cancelImagePull(id).catch(() => {
      /* best effort — the abort above stops the local SSE either way */
    });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    try {
      await api.deleteImageModel(toDelete);
      await refresh();
      onModelsChanged?.();
    } catch (err) {
      setInstalledError((err as Error).message);
    } finally {
      setToDelete(null);
    }
  }, [toDelete, refresh, onModelsChanged]);

  const installedIds = useMemo(() => new Set(installed.map((m) => m.id)), [installed]);

  // The model sd-server actually binds: the configured default when it's
  // still installed, else the first installed model (the engine's own
  // fallback). The highlighted radio mirrors what a
  // generation would really load.
  const showActivePicker = Boolean(onSetActiveModel) && installed.length > 0;
  const activeModelId =
    configuredDefaultModelId && installedIds.has(configuredDefaultModelId)
      ? configuredDefaultModelId
      : installed[0]?.id;

  return (
    <div className="ollama-model-manager">
      {pulls.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(pulls.values()).map((pull) => (
              <ImagePullProgress
                key={pull.id}
                pull={pull}
                onCancel={() => cancelPull(pull.id)}
                // The shared downloader picks up from the existing
                // `.partial` so the user doesn't restart at zero.
                onRetry={() => retryPull(pull.id)}
              />
            ))}
          </div>
        </div>
      )}

      {(installed.length > 0 || installedError) && (
        <div className="ollama-section">
          <h4>Local models</h4>
          {installedError && <p className="error">{installedError}</p>}
          {showActivePicker && installed.length > 1 && (
            <p className="muted small">
              The <strong>active</strong> model is what the image-generator gezel and the{' '}
              <code>render_image</code> tool use by default. A gezel can still ask for a specific
              model per image; switching reloads the engine, which takes a moment.
            </p>
          )}
          {installed.length > 0 && (
            <table className="ollama-model-table">
              <thead>
                <tr>
                  {showActivePicker && (
                    <th scope="col" className="gz-active-model-column">
                      Active
                    </th>
                  )}
                  <th>Name</th>
                  <th>Size</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {installed.map((m) => (
                  <tr key={m.id}>
                    {showActivePicker && (
                      <td className="gz-active-model-column">
                        <input
                          type="radio"
                          name="active-image-model"
                          className="gz-active-model-radio"
                          aria-label={`Use ${m.id} as the active image model`}
                          checked={activeModelId === m.id}
                          onChange={() => {
                            // Re-selecting the active model would still reset the
                            // provider and cold-reload a warm engine — no-op it.
                            if (activeModelId !== m.id) void onSetActiveModel?.(m.id);
                          }}
                        />
                      </td>
                    )}
                    <td>
                      <code>{m.id}</code>
                      <div className="muted small">{m.name}</div>
                    </td>
                    <td>{formatSize(m.approxSizeBytes)}</td>
                    <td className="muted small">{new Date(m.installedAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        type="button"
                        className="gz-link-button"
                        onClick={() => setToDelete(m.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="ollama-section ollama-section--flat ollama-section--download">
        <h4>Download a model</h4>
        <CatalogBrowser
          kind="image-model"
          emptyMessage="No image models in the catalog yet. Remote catalog sources can add entries without an app update."
          action={(item: CatalogItemSummary) => {
            if (item.manifest.kind !== 'image-model') return null;
            const m = item.manifest as ImageModelManifest;
            const already = installedIds.has(m.id);
            const active = pulls.get(m.id);
            const pulling = Boolean(active);
            const pct =
              active && active.totalBytes > 0
                ? Math.min(100, Math.round((active.bytesWritten / active.totalBytes) * 100))
                : null;
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <code>{m.id}</code>
                    <span>·</span>
                    <span>{formatSize(m.approxSizeBytes)}</span>
                    {m.quantization && (
                      <>
                        <span>·</span>
                        <span>{m.quantization}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>{hardwareTierLabel(m.hardwareTier, m.minRamGB)}</span>
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton manifest={m} />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={already || pulling || Boolean(disabledReason)}
                  title={disabledReason ?? undefined}
                  onClick={() => void startPull(m.id)}
                >
                  {already
                    ? 'On device'
                    : pulling
                      ? pct !== null
                        ? `Downloading… ${pct}%`
                        : 'Downloading…'
                      : 'Download'}
                </button>
              </div>
            );
          }}
        />
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete image model?"
        message={
          toDelete
            ? `"${toDelete}" will be removed from local storage. This frees disk space; download it again later to use it.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function ImagePullProgress({
  pull,
  onCancel,
  onRetry,
}: {
  pull: ActivePull;
  onCancel: () => void;
  /** Called when the user clicks the manual Retry link after all auto-retries
   *  have been exhausted. Starts a fresh pull for the same id — the
   *  shared downloader resumes from the existing `.partial` on disk. */
  onRetry: () => void;
}) {
  const known = pull.totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((pull.bytesWritten / pull.totalBytes) * 100)) : 0;
  // Status line precedence: hard error > active retry (no error yet) > normal progress.
  let statusLine: string;
  if (pull.error) {
    statusLine = pull.error;
  } else if (pull.retrying) {
    const delaySec = Math.max(1, Math.round(pull.retrying.delayMs / 1000));
    statusLine = `${pull.retrying.reason} — retrying in ${delaySec}s (attempt ${pull.retrying.attempt}/${pull.retrying.maxAttempts})`;
  } else if (known) {
    statusLine = `Downloading… (${formatSize(pull.bytesWritten)} of ${formatSize(pull.totalBytes)}, ${pct}%)`;
  } else if (pull.bytesWritten > 0) {
    statusLine = `Downloading… (${formatSize(pull.bytesWritten)})`;
  } else {
    statusLine = 'Preparing download…';
  }
  return (
    <div
      className={`ollama-pull${pull.error ? ' ollama-pull-error' : pull.retrying ? ' ollama-pull-warning' : ''}`}
    >
      <div className="ollama-pull-head">
        <code>{pull.id}</code>
        <span className="muted small">{statusLine}</span>
        {pull.error ? (
          <button type="button" className="gz-link-button" onClick={onRetry}>
            Retry
          </button>
        ) : (
          <button type="button" className="gz-link-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {known ? (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${pct}%` }} />
          <span className="ollama-pull-bar-label">{pct}%</span>
        </div>
      ) : (
        <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
          <div className="ollama-pull-bar-fill" />
        </div>
      )}
    </div>
  );
}
