import {
  type ActiveVideoPull,
  type CatalogItemSummary,
  type ImageModelHardwareTier,
  type InstalledVideoModel,
  type RecoDevice,
  type VideoModelManifest,
  type VideoModelPullEvent,
  mediaModelFits,
  videoMemoryBudgetBytes,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { LicenseButton } from './LicenseButton.js';
import { RecommendedBadge } from './RecommendedBadge.js';

/**
 * Install / pull / delete flow for `video-model` catalog entries.
 * Mirrors {@link ImageModelManager} but drives the multi-file video
 * pull SSE (video models are HF repos of many files; the registry
 * reports cumulative byte counts via `bytesWrittenAll`/`totalBytesAll`).
 */

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

function hardwareTierLabel(tier: ImageModelHardwareTier, minVramGB: number): string {
  switch (tier) {
    case 'low':
      return `Runs on ${minVramGB} GB`;
    case 'mid':
      return `${minVramGB} GB+`;
    case 'high':
      return `${minVramGB} GB+ recommended`;
    case 'workstation':
      return `${minVramGB} GB+ workstation`;
  }
}

/** Bytes → whole GB for human-readable memory figures. */
function gb(bytes: number): number {
  return Math.round(bytes / 1_000_000_000);
}

/** Personalized "may not fit" copy for the install-confirm dialog. */
function fitWarning(
  device: RecoDevice,
  m: { name: string; minVramGB: number; approxSizeBytes: number },
): string {
  return (
    `${m.name} recommends about ${m.minVramGB} GB of fast (GPU / unified) memory, but this ` +
    `machine has roughly ${gb(videoMemoryBudgetBytes(device))} GB usable for generation ` +
    `(${gb(device.totalRamBytes)} GB total). It may run out of memory or fail to load. ` +
    `Download this ${formatSize(m.approxSizeBytes)} model anyway?`
  );
}

interface ActivePull {
  id: string;
  bytesWritten: number;
  totalBytes: number;
  /** Current file label for multi-file progress, e.g. "2/5 transformer/…". */
  fileLabel?: string;
  /**
   * Set while a downloaded file is being sha256-verified. For a large
   * multi-GB model this phase reads the whole file back through a hasher
   * and takes real time with the byte counter already at 100% — without
   * this the bar looks frozen. Cleared on the next download progress.
   */
  verifying?: string;
  error?: string;
  controller: AbortController;
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
   * The `config.defaultVideoModel` value. Drives which installed row is
   * marked active. When {@link onSetActiveModel} is also supplied the
   * Installed models table grows a leading radio column for picking it.
   */
  configuredDefaultModelId?: string;
  /** Persist a new default video model. Enables the active-model radios. */
  onSetActiveModel?: (id: string) => void | Promise<void>;
}

export function VideoModelManager({
  disabledReason,
  onModelsChanged,
  configuredDefaultModelId,
  onSetActiveModel,
}: Props) {
  const [installed, setInstalled] = useState<InstalledVideoModel[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Map<string, ActivePull>>(new Map());
  const [toDelete, setToDelete] = useState<string | null>(null);
  // Device memory, so a model whose `minVramGB` exceeds what this machine can
  // run is flagged before a big download the user can't use (LTX-2/2.3 want
  // ~80 GB). A failed probe leaves this null and never blocks an install.
  const [device, setDevice] = useState<RecoDevice | null>(null);
  const [fitConfirm, setFitConfirm] = useState<{ id: string; message: string } | null>(null);
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;

  useEffect(() => {
    void api
      .getMemoryProfile()
      .then((mem) =>
        setDevice({
          platform: mem.platform,
          gpuVramBytes: mem.gpuVramBytes,
          totalRamBytes: mem.totalRamBytes,
          usableBytes: mem.usableBytes,
          ...(mem.budgetBytes !== undefined ? { budgetBytes: mem.budgetBytes } : {}),
        }),
      )
      .catch(() => {
        /* Fit hints are best-effort; without a profile we treat everything as fitting. */
      });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listInstalledVideoModels();
      setInstalled(res.models);
      setInstalledError(null);
    } catch (err) {
      setInstalled([]);
      setInstalledError((err as Error).message);
    }
  }, []);

  const attachSubscription = useCallback(
    (
      id: string,
      subscribe: (cb: (e: VideoModelPullEvent) => void, signal: AbortSignal) => Promise<void>,
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
            const { retrying: _drop, verifying: _v, ...rest } = cur;
            next.set(id, {
              ...rest,
              bytesWritten: event.bytesWrittenAll,
              totalBytes: event.totalBytesAll || cur.totalBytes,
              fileLabel: `${event.fileIndex + 1}/${event.fileCount} ${event.file}`,
            });
            return next;
          });
        } else if (event.type === 'verifying') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (!cur) return prev;
            next.set(id, { ...cur, verifying: event.file });
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
    let cancelled = false;
    void api
      .listActiveVideoPulls()
      .then(({ pulls: active }: { pulls: ActiveVideoPull[] }) => {
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
            api.subscribeVideoPull(snapshot.id, cb, signal),
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
      attachSubscription(id, (cb, signal) => api.pullVideoModel(id, cb, signal));
    },
    [attachSubscription],
  );

  const cancelPull = useCallback((id: string) => {
    const pull = pullsRef.current.get(id);
    pull?.controller.abort();
    setPulls((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    void api.cancelVideoPull(id).catch(() => {
      /* best effort */
    });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    try {
      await api.deleteVideoModel(toDelete);
      await refresh();
      onModelsChanged?.();
    } catch (err) {
      setInstalledError((err as Error).message);
    } finally {
      setToDelete(null);
    }
  }, [toDelete, refresh, onModelsChanged]);

  const installedIds = useMemo(() => new Set(installed.map((m) => m.id)), [installed]);

  // The model the engine actually binds: the configured default when it's
  // still installed, else the first installed model (the server's own
  // fallback, which sorts by name). The highlighted radio mirrors what a
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
              <VideoPullProgress
                key={pull.id}
                pull={pull}
                onCancel={() => cancelPull(pull.id)}
                onRetry={() => {
                  setPulls((prev) => {
                    const next = new Map(prev);
                    next.delete(pull.id);
                    return next;
                  });
                  void startPull(pull.id);
                }}
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
              The <strong>active</strong> model is what the video-generator gezel and the{' '}
              <code>generate_video</code> tool use by default. A gezel can still ask for a specific
              model per clip; switching reloads the engine, which takes a moment.
            </p>
          )}
          {installed.length > 0 && (
            <table className="ollama-model-table">
              <thead>
                <tr>
                  {showActivePicker && <th scope="col">Active</th>}
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
                      <td>
                        <input
                          type="radio"
                          name="active-video-model"
                          className="video-active-radio"
                          aria-label={`Use ${m.id} as the active video model`}
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
                      <button type="button" className="home-link" onClick={() => setToDelete(m.id)}>
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
          kind="video-model"
          emptyMessage="No video models in the catalog yet. Remote catalog sources can add entries without an app update."
          action={(item: CatalogItemSummary) => {
            if (item.manifest.kind !== 'video-model') return null;
            const m = item.manifest as VideoModelManifest;
            const already = installedIds.has(m.id);
            const active = pulls.get(m.id);
            const pulling = Boolean(active);
            const pct =
              active && active.totalBytes > 0
                ? Math.min(100, Math.round((active.bytesWritten / active.totalBytes) * 100))
                : null;
            // Best-effort fit: unknown device (probe failed) is treated as fitting.
            const fits = !device || mediaModelFits(device, { minVramGB: m.minVramGB });
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <code>{m.id}</code>
                    <span>·</span>
                    <span>{formatSize(m.approxSizeBytes)}</span>
                    <span>·</span>
                    <span>{m.family.toUpperCase()}</span>
                    <span>·</span>
                    <span>{hardwareTierLabel(m.hardwareTier, m.minVramGB)}</span>
                    {device && !fits && (
                      <>
                        <span>·</span>
                        <span
                          className="catalog-ollama-warn"
                          title={`Recommended ${m.minVramGB} GB · this machine ~${gb(videoMemoryBudgetBytes(device))} GB usable`}
                        >
                          may exceed this machine
                        </span>
                      </>
                    )}
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton manifest={m} />
                    <RecommendedBadge manifest={m} />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={already || pulling || Boolean(disabledReason)}
                  title={disabledReason ?? undefined}
                  onClick={() => {
                    if (fits || !device) void startPull(m.id);
                    else setFitConfirm({ id: m.id, message: fitWarning(device, m) });
                  }}
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
        title="Delete video model?"
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

      <ConfirmDialog
        open={fitConfirm !== null}
        title="This model may not fit"
        message={fitConfirm?.message}
        confirmLabel="Download anyway"
        onCancel={() => setFitConfirm(null)}
        onConfirm={() => {
          if (fitConfirm) startPull(fitConfirm.id);
          setFitConfirm(null);
        }}
      />
    </div>
  );
}

function VideoPullProgress({
  pull,
  onCancel,
  onRetry,
}: {
  pull: ActivePull;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const known = pull.totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((pull.bytesWritten / pull.totalBytes) * 100)) : 0;
  let statusLine: string;
  if (pull.error) {
    statusLine = pull.error;
  } else if (pull.retrying) {
    const delaySec = Math.max(1, Math.round(pull.retrying.delayMs / 1000));
    statusLine = `${pull.retrying.reason} — retrying in ${delaySec}s (attempt ${pull.retrying.attempt}/${pull.retrying.maxAttempts})`;
  } else if (pull.verifying) {
    // Download is at 100%; we're now hashing the file(s) to verify the
    // download. Surfaces real progress so the full bar doesn't look hung.
    statusLine = `Verifying ${pull.verifying}…`;
  } else if (known) {
    const file = pull.fileLabel ? ` · ${pull.fileLabel}` : '';
    statusLine = `Downloading… (${formatSize(pull.bytesWritten)} of ${formatSize(pull.totalBytes)}, ${pct}%)${file}`;
  } else {
    statusLine = `Downloading… (${formatSize(pull.bytesWritten)})`;
  }
  return (
    <div
      className={`ollama-pull${pull.error ? ' ollama-pull-error' : pull.retrying ? ' ollama-pull-warning' : ''}`}
    >
      <div className="ollama-pull-head">
        <code>{pull.id}</code>
        <span className="muted small">{statusLine}</span>
        {pull.error ? (
          <button type="button" className="home-link" onClick={onRetry}>
            Retry
          </button>
        ) : (
          <button type="button" className="home-link" onClick={onCancel}>
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
