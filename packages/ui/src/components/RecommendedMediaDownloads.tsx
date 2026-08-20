import type {
  CatalogItemSummary,
  ModelDownloadPreflightResponse,
  RecoDevice,
} from '@bendyline/gezel';
import { isRecommendedModel, mediaModelFits } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AlertDialog } from '../primitives/index.js';

/**
 * First-run "on-device media" section: one Download button per media modality
 * (image / speech-to-text / text-to-speech / video) for the RECOMMENDED model
 * of that kind that fits this device. A size-aware plan dialog is the only
 * start path: it defaults to the modest media set, leaves video opt-in, checks
 * the model-store filesystem, and never starts the separately-managed chat
 * model as a hidden side effect.
 *
 * "Recommended" = the highest-`recoScore`, fully-open catalog entry of that
 * kind (the same gate as the chat picker + ★ badge). Non-fitting modalities
 * are hidden entirely (e.g. the 24 GB-VRAM video model on a small GPU). Fit is
 * `mediaModelFits` from core: image gates on system RAM, video on VRAM, audio
 * always fits.
 *
 * Progress comes from each pull's SSE events (unlike the chat banner, which
 * polls). Image and video pulls are service-owned: on mount we seed their
 * latest registry snapshots and re-subscribe, so leaving Start only detaches
 * this view and does not hide or interrupt those long downloads.
 */

type ModalityKey = 'image' | 'stt' | 'tts' | 'video' | 'recognition';

/** Loose superset of the three pull-event shapes (image/video/audio). */
interface PullEvent {
  type: string;
  bytesWritten?: number;
  totalBytes?: number;
  /**
   * Video pulls are multi-file: `bytesWritten`/`totalBytes` are per-file (they
   * reset each file), while these carry the cumulative batch totals. Prefer
   * them so the bar climbs monotonically instead of bouncing per file. Image
   * pulls already report `bytesWritten` cumulatively, so they lack these.
   */
  bytesWrittenAll?: number;
  totalBytesAll?: number;
  error?: string;
}

interface Reco {
  key: ModalityKey;
  id: string;
  /** Human label for the button, e.g. "image model" / "speech-to-text". */
  what: string;
  name: string;
  sizeBytes: number | null;
  installed: boolean;
  start: (onEvent: (ev: PullEvent) => void, signal: AbortSignal) => Promise<void>;
  /** Explicit server-owned cancel for pulls that survive SSE detachment. */
  cancel?: () => Promise<unknown>;
  /**
   * Present when the service reported this pull as already in flight.
   * Re-subscribing only attaches this view to the service-owned download;
   * it does not start a second pull.
   */
  resume?: {
    bytesWritten: number;
    totalBytes: number;
    subscribe: (onEvent: (ev: PullEvent) => void, signal: AbortSignal) => Promise<void>;
  };
}

interface InstallState {
  status: 'idle' | 'installing' | 'done' | 'error';
  pct: number | null;
  bytesWritten?: number;
  totalBytes?: number;
  error?: string;
}

/** Manifest fields the picker reads (structural subset of image/video manifests). */
interface MediaManifest {
  id: string;
  name: string;
  recoScore?: number;
  licenseClass?: string;
  approxSizeBytes?: number;
  minRamGB?: number;
  minVramGB?: number;
  auxiliaryFiles?: Array<{ sizeBytes?: number }>;
}

interface AudioModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  recoScore?: number;
  licenseClass?: string;
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes >= 1024 ** 3) return `~${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `~${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Exact byte formatter for the live "N MB of M GB" progress label. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** The recommended (highest-score, open, fitting) media manifest of a kind. */
function pickMedia(
  items: CatalogItemSummary[],
  device: RecoDevice,
  kind: 'image' | 'video',
): MediaManifest | null {
  let best: MediaManifest | null = null;
  for (const it of items) {
    const m = it.manifest as unknown as MediaManifest;
    if (!isRecommendedModel(m)) continue;
    const req = kind === 'image' ? { minRamGB: m.minRamGB } : { minVramGB: m.minVramGB };
    if (!mediaModelFits(device, req)) continue;
    if (best == null || (m.recoScore ?? 0) > (best.recoScore ?? 0)) best = m;
  }
  return best;
}

function pickAudio(list: AudioModel[]): AudioModel | null {
  let best: AudioModel | null = null;
  for (const m of list) {
    if (!isRecommendedModel(m)) continue;
    if (best == null || (m.recoScore ?? 0) > (best.recoScore ?? 0)) best = m;
  }
  return best;
}

/** Image download = the diffusion file + all auxiliary files (VAE, LLM encoder). */
function imageTotalBytes(m: MediaManifest): number | null {
  const main = m.approxSizeBytes ?? 0;
  const aux = (m.auxiliaryFiles ?? []).reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const total = main + aux;
  return total > 0 ? total : null;
}

function hasId(list: { models: Array<{ id: string }> }, id: string): boolean {
  return list.models.some((m) => m.id === id);
}

export function RecommendedMediaDownloads() {
  const [recos, setRecos] = useState<Reco[] | null>(null);
  const [states, setStates] = useState<Record<string, InstallState>>({});
  const [planOpen, setPlanOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<ModalityKey>>(new Set());
  const [preflight, setPreflight] = useState<ModelDownloadPreflightResponse | null>(null);
  const [preflightChecking, setPreflightChecking] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const controllers = useRef<Map<string, AbortController>>(new Map());

  const setState = useCallback((key: string, s: InstallState) => {
    setStates((prev) => ({ ...prev, [key]: s }));
  }, []);

  const attach = useCallback(
    async (
      r: Reco,
      subscribe: (onEvent: (ev: PullEvent) => void, signal: AbortSignal) => Promise<void>,
    ) => {
      // Config commonly arrives just after the first render, causing the
      // discovery effect to run twice. Keep the first live listener instead
      // of opening a duplicate SSE subscription for the same modality.
      if (controllers.current.has(r.key)) return;
      const controller = new AbortController();
      controllers.current.set(r.key, controller);
      let err: string | null = null;
      try {
        await subscribe((ev) => {
          if (ev.type === 'progress') {
            const written = ev.bytesWrittenAll ?? ev.bytesWritten;
            const total = ev.totalBytesAll ?? ev.totalBytes;
            if (total && written != null) {
              setState(r.key, {
                status: 'installing',
                pct: Math.min(100, Math.round((written / total) * 100)),
                bytesWritten: written,
                totalBytes: total,
              });
            }
          } else if (ev.type === 'error') {
            err = ev.error ?? 'download failed';
          }
        }, controller.signal);
        if (err) throw new Error(err);
        setState(r.key, { status: 'done', pct: 100 });
      } catch (e) {
        // Navigating away intentionally detaches the listener. Image and
        // video downloads remain owned by the service and are reattached
        // when this view mounts again.
        if (controller.signal.aborted) return;
        setState(r.key, {
          status: 'error',
          pct: null,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (controllers.current.get(r.key) === controller) {
          controllers.current.delete(r.key);
        }
      }
    },
    [setState],
  );

  useEffect(() => {
    let cancelled = false;
    const empty = { models: [] as Array<{ id: string }> };
    void (async () => {
      try {
        const [
          mem,
          imageCat,
          videoCat,
          audioCat,
          imgInst,
          vidInst,
          sttInst,
          ttsInst,
          imgPulls,
          vidPulls,
          recogCat,
          recogInst,
        ] = await Promise.all([
          api.getMemoryProfile(),
          api.listCatalogItems('image-model'),
          api.listCatalogItems('video-model'),
          api.listAudioCatalog(),
          api.listInstalledImageModels().catch(() => empty),
          api.listInstalledVideoModels().catch(() => empty),
          api.listInstalledSttModels().catch(() => empty),
          api.listInstalledTtsModels().catch(() => empty),
          api.listActiveImagePulls().catch(() => ({ pulls: [] })),
          api.listActiveVideoPulls().catch(() => ({ pulls: [] })),
          api.listRecognitionCatalog().catch(() => ({ models: [] })),
          api.listInstalledRecognitionModels().catch(() => empty),
        ]);
        if (cancelled) return;
        const device: RecoDevice = {
          platform: mem.platform,
          gpuVramBytes: mem.gpuVramBytes,
          totalRamBytes: mem.totalRamBytes,
          usableBytes: mem.usableBytes,
          ...(mem.budgetBytes !== undefined ? { budgetBytes: mem.budgetBytes } : {}),
        };
        const out: Reco[] = [];

        const img = pickMedia(imageCat.items, device, 'image');
        if (img) {
          const active = imgPulls.pulls.find((pull) => pull.id === img.id && !pull.finished);
          out.push({
            key: 'image',
            id: img.id,
            what: 'image model',
            name: img.name,
            sizeBytes: imageTotalBytes(img),
            installed: hasId(imgInst, img.id),
            start: (cb, sig) => api.pullImageModel(img.id, cb, sig),
            cancel: () => api.cancelImagePull(img.id),
            ...(active
              ? {
                  resume: {
                    bytesWritten: active.bytesWritten,
                    totalBytes: active.totalBytes,
                    subscribe: (cb, sig) => api.subscribeImagePull(img.id, cb, sig),
                  },
                }
              : {}),
          });
        }
        // Image *reading*, distinct from the image *generation* row above.
        // Highest reco score that the device can hold.
        const reader = [...recogCat.models]
          .filter((m) => !m.approxSizeBytes || m.approxSizeBytes <= device.usableBytes * 0.5)
          .sort((a, b) => b.recoScore - a.recoScore)[0];
        if (reader) {
          out.push({
            key: 'recognition',
            id: reader.id,
            what: 'image reading',
            name: reader.name,
            sizeBytes: reader.approxSizeBytes,
            installed: hasId(recogInst, reader.id),
            start: (cb, sig) => api.pullRecognitionModel(reader.id, cb, sig),
          });
        }
        const stt = pickAudio(audioCat.stt as AudioModel[]);
        if (stt) {
          out.push({
            key: 'stt',
            id: stt.id,
            what: 'speech-to-text',
            name: stt.name,
            sizeBytes: stt.approxSizeBytes,
            installed: hasId(sttInst, stt.id),
            start: (cb, sig) => api.pullAudioModel('stt', stt.id, cb, sig),
          });
        }
        const tts = pickAudio(audioCat.tts as AudioModel[]);
        if (tts) {
          out.push({
            key: 'tts',
            id: tts.id,
            what: 'text-to-speech',
            name: tts.name,
            sizeBytes: tts.approxSizeBytes,
            installed: hasId(ttsInst, tts.id),
            start: (cb, sig) => api.pullAudioModel('tts', tts.id, cb, sig),
          });
        }
        const vid = pickMedia(videoCat.items, device, 'video');
        if (vid) {
          const active = vidPulls.pulls.find((pull) => pull.id === vid.id && !pull.finished);
          out.push({
            key: 'video',
            id: vid.id,
            what: 'video model',
            name: vid.name,
            sizeBytes: vid.approxSizeBytes ?? null,
            installed: hasId(vidInst, vid.id),
            start: (cb, sig) => api.pullVideoModel(vid.id, cb, sig),
            cancel: () => api.cancelVideoPull(vid.id),
            ...(active
              ? {
                  resume: {
                    bytesWritten: active.bytesWritten,
                    totalBytes: active.totalBytes,
                    subscribe: (cb, sig) => api.subscribeVideoPull(vid.id, cb, sig),
                  },
                }
              : {}),
          });
        }

        setRecos(out);
        const seed: Record<string, InstallState> = {};
        for (const r of out) {
          if (r.installed) {
            seed[r.key] = { status: 'done', pct: 100 };
          } else if (r.resume) {
            const { bytesWritten, totalBytes } = r.resume;
            seed[r.key] = {
              status: 'installing',
              pct:
                totalBytes > 0
                  ? Math.min(100, Math.round((bytesWritten / totalBytes) * 100))
                  : null,
              bytesWritten,
              totalBytes,
            };
          }
        }
        setStates(seed);
        for (const r of out) {
          if (!r.installed && r.resume) void attach(r, r.resume.subscribe);
        }
      } catch {
        if (!cancelled) setRecos([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attach]);

  const install = useCallback(
    async (r: Reco) => {
      setStates((prev) => {
        const cur = prev[r.key]?.status;
        if (cur === 'installing' || cur === 'done') return prev;
        return { ...prev, [r.key]: { status: 'installing', pct: null } };
      });
      await attach(r, r.start);
    },
    [attach],
  );

  const cancelInstall = useCallback(
    async (r: Reco) => {
      // Every pull is at least detached locally. Image/video pulls are owned
      // by server registries, so explicit user cancellation also calls their
      // dedicated endpoint; ordinary navigation continues to detach only.
      controllers.current.get(r.key)?.abort();
      try {
        await r.cancel?.();
        setState(r.key, { status: 'idle', pct: null });
      } catch (err) {
        setState(r.key, {
          status: 'error',
          pct: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [setState],
  );

  const pendingRecos = useMemo(
    () =>
      (recos ?? []).filter((r) => {
        const status = states[r.key]?.status ?? 'idle';
        return status === 'idle' || status === 'error';
      }),
    [recos, states],
  );
  const selectedRecos = useMemo(
    () => pendingRecos.filter((r) => selectedKeys.has(r.key)),
    [pendingRecos, selectedKeys],
  );
  const selectedKnownBytes = useMemo(
    () => selectedRecos.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0),
    [selectedRecos],
  );
  const selectedUnknownCount = useMemo(
    () => selectedRecos.filter((r) => r.sizeBytes == null).length,
    [selectedRecos],
  );
  const defaultPlanBytes = useMemo(
    () =>
      pendingRecos.filter((r) => r.key !== 'video').reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0),
    [pendingRecos],
  );

  const openPlan = useCallback(
    (only?: ModalityKey) => {
      const selected = only
        ? pendingRecos.filter((r) => r.key === only)
        : pendingRecos.filter((r) => r.key !== 'video');
      setSelectedKeys(new Set(selected.map((r) => r.key)));
      setPreflight(null);
      setPreflightError(null);
      setPreflightChecking(selected.length > 0);
      setPlanOpen(true);
    },
    [pendingRecos],
  );

  useEffect(() => {
    if (!planOpen || selectedRecos.length === 0) {
      setPreflight(null);
      setPreflightChecking(false);
      setPreflightError(null);
      return;
    }
    if (selectedKnownBytes <= 0) {
      setPreflight(null);
      setPreflightChecking(false);
      setPreflightError(
        "Gezel couldn't determine this model's size. Its installer will check space again before writing.",
      );
      return;
    }
    let cancelled = false;
    setPreflight(null);
    setPreflightError(null);
    setPreflightChecking(true);
    void api
      .checkModelDownloadSpace({ sizeBytes: Math.ceil(selectedKnownBytes) })
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreflightError(
            `Gezel couldn't measure free space (${err instanceof Error ? err.message : String(err)}). Each installer will check again before writing.`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPreflightChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [planOpen, selectedKnownBytes, selectedRecos.length]);

  const confirmPlan = useCallback(() => {
    for (const r of selectedRecos) void install(r);
    setPlanOpen(false);
  }, [install, selectedRecos]);

  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
    };
  }, []);

  if (!recos || recos.length === 0) return null;

  const anyPending = pendingRecos.length > 0;
  const canConfirm =
    selectedRecos.length > 0 && !preflightChecking && (preflight === null || preflight.ok);

  return (
    <section className="setup-section home-media-section">
      <h3>On-device media creation and processing</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Optional local models for images, speech, and video — the recommended picks that fit this
        device. Browse the rest, or manage downloads, in Settings.
      </p>
      <button
        type="button"
        className="home-media-btn home-media-btn-primary"
        onClick={() => openPlan()}
        disabled={!anyPending}
      >
        Choose downloads{defaultPlanBytes > 0 ? ` · ${fmtSize(defaultPlanBytes)}` : ''}
      </button>
      <p className="muted small home-media-plan-hint">
        Video stays off until you select it. Chat models are managed separately above.
      </p>
      <div className="home-media-downloads">
        {recos.map((r) => {
          const st = states[r.key] ?? { status: 'idle', pct: null };
          return (
            <div key={r.key} className="home-media-row">
              {st.status === 'done' ? (
                <span className="home-probe home-probe-ok small">✓ {r.name} on device</span>
              ) : st.status === 'installing' ? (
                <div className="home-media-progress">
                  <div className="home-media-progress-heading">
                    <span className="muted small">Downloading {r.name}…</span>
                    <button
                      type="button"
                      className="gz-link-button"
                      onClick={() => void cancelInstall(r)}
                      aria-label={`Cancel ${r.name} download`}
                    >
                      Cancel
                    </button>
                  </div>
                  <div
                    className={
                      st.pct != null
                        ? 'first-run-banner-bar'
                        : 'first-run-banner-bar first-run-banner-bar-indeterminate'
                    }
                  >
                    <div
                      className="first-run-banner-bar-fill"
                      style={st.pct != null ? { width: `${st.pct}%` } : undefined}
                    />
                  </div>
                  <span className="first-run-banner-progress-label">
                    {st.bytesWritten != null && st.totalBytes
                      ? `${fmtBytes(st.bytesWritten)} of ${fmtBytes(st.totalBytes)} · ${st.pct ?? 0}%`
                      : 'Starting…'}
                  </span>
                </div>
              ) : (
                <button type="button" className="home-media-btn" onClick={() => openPlan(r.key)}>
                  Download {r.what} ({r.name}
                  {r.sizeBytes ? `, ${fmtSize(r.sizeBytes)}` : ''})
                </button>
              )}
              {st.status === 'error' && (
                <span className="home-probe home-probe-fail small">✗ {st.error}</span>
              )}
            </div>
          );
        })}
      </div>
      <AlertDialog.Root
        open={planOpen}
        onOpenChange={(open) => {
          setPlanOpen(open);
          if (!open) setSelectedKeys(new Set());
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay />
          <AlertDialog.Content className="home-media-plan-dialog">
            <AlertDialog.Title asChild>
              <h3>Review model downloads</h3>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p className="muted small">
                Nothing starts until you confirm this plan. Downloads go to Gezel model storage and
                remain visible below while they run.
              </p>
            </AlertDialog.Description>
            <fieldset className="home-media-plan-list">
              <legend className="sr-only">Models to download</legend>
              {pendingRecos.map((r) => {
                const selected = selectedKeys.has(r.key);
                return (
                  <label key={r.key} className="home-media-plan-item">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        setSelectedKeys((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(r.key);
                          else next.delete(r.key);
                          return next;
                        });
                        setPreflight(null);
                        setPreflightError(null);
                        setPreflightChecking(true);
                      }}
                    />
                    <span className="home-media-plan-copy">
                      <span className="home-media-plan-name">
                        {r.name}
                        {r.key === 'video' && (
                          <span className="home-media-plan-large">Large download</span>
                        )}
                      </span>
                      <span className="muted small">
                        {r.what}
                        {r.sizeBytes ? ` · ${fmtSize(r.sizeBytes)}` : ' · size unavailable'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="home-media-plan-summary" aria-live="polite">
              <strong>
                {selectedRecos.length === 0
                  ? 'Select at least one model.'
                  : `${selectedRecos.length} model${selectedRecos.length === 1 ? '' : 's'} · ${
                      selectedKnownBytes > 0 ? fmtSize(selectedKnownBytes) : 'size unavailable'
                    }${selectedUnknownCount > 0 ? ` + ${selectedUnknownCount} unknown` : ''}`}
              </strong>
              {preflightChecking ? (
                <span className="muted small">Checking free space…</span>
              ) : preflight?.known && preflight.ok ? (
                <span className="muted small">
                  {fmtBytes(preflight.freeBytes)} free in {preflight.storageLocation}; this plan
                  needs {fmtBytes(preflight.requiredBytes)} including safety headroom.
                </span>
              ) : preflight?.known && !preflight.ok ? (
                <span className="error small">
                  Not enough free space: this plan needs {fmtBytes(preflight.requiredBytes)}, but{' '}
                  {preflight.storageLocation} has {fmtBytes(preflight.freeBytes)} free.
                </span>
              ) : preflight && !preflight.known ? (
                <span className="muted small">
                  Free space could not be measured. Each installer will check again before writing.
                </span>
              ) : preflightError ? (
                <span className="muted small">{preflightError}</span>
              ) : null}
            </div>
            <AlertDialog.Actions>
              <AlertDialog.Cancel asChild>
                <button type="button">Cancel</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="primary"
                  disabled={!canConfirm}
                  onClick={confirmPlan}
                >
                  {preflightChecking
                    ? 'Checking space…'
                    : selectedRecos.length > 0
                      ? `Download ${selectedRecos.length} model${selectedRecos.length === 1 ? '' : 's'}`
                      : 'Choose models'}
                </button>
              </AlertDialog.Action>
            </AlertDialog.Actions>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
