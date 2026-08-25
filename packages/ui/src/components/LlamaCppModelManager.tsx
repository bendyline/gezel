import type { CatalogItemSummary, ChatModelManifest, RecoDevice } from '@bendyline/gezel';
import {
  computeModelFit,
  estimateLlamaCppResidentBytes,
  estimateManifestKvBytes,
  hardwareHint,
  isMoEFromTags,
  isRetiredModel,
  localContextFloorTokens,
} from '@bendyline/gezel';
import type {
  IncompleteModelDownload,
  LlamaCppInstallEvent,
  LlamaCppInstalledModel,
  ModelFitnessEntry,
  UnrecognizedLocalModel,
} from '@bendyline/gezel-client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  MODEL_INVENTORY_CHANGED_EVENT,
  announceModelInventoryChanged,
  changedModelInventoryEngine,
} from '../model-inventory.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HuggingFaceRepoLink, huggingFaceRepoUrl } from './HuggingFaceRepoLink.js';
import { IncompleteDownloads } from './IncompleteDownloads.js';
import { LicenseButton } from './LicenseButton.js';
import { ImportModelBundleButton } from './ModelBundleControls.js';
import { ModelActionsMenu, ModelContextSliderPanel } from './ModelContextControls.js';
import { ModelFitnessCell, fitnessMenuAction } from './ModelFitnessCell.js';
import { ModelSizeCell } from './ModelSizeCell.js';
import { SharedModelMigrationPanel } from './SharedModelMigrationPanel.js';
import { UnrecognizedModels } from './UnrecognizedModels.js';
import { formatContextWindow } from './model-context.js';
import { formatBytes } from './model-memory-copy.js';
import { approximateQuantizationLabel, quantizationTitle } from './model-quantization.js';

interface MemoryProfile {
  totalRamBytes: number;
  gpuVramBytes: number | null;
  gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'gpu-integrated' | 'system-ram-fallback';
  usableBytes: number;
  /**
   * What the daemon's capacity broker will admit across VRAM + system RAM.
   * Absent on daemons that predate the field — the fit check then falls back
   * to its own RAM fraction.
   */
  budgetBytes?: number;
}

/**
 * The machine half of a {@link computeModelFit} call. Every fit check on this
 * page reads the same profile, and the admission ceiling has to travel with
 * the rest of it — a fit computed without it offers models the broker refuses.
 */
function fitMachine(memory: MemoryProfile) {
  return {
    usableBytes: memory.usableBytes,
    totalRamBytes: memory.totalRamBytes,
    // An integrated adapter's advertised allocation is shared system RAM,
    // not a fast offload pool separate from it. Treat it as RAM-paced for fit
    // copy so a 26B MoE says "may run slowly", not "runs (expert offload)".
    gpuVramBytes: memory.gpuMemoryKind === 'integrated' ? null : memory.gpuVramBytes,
    ...(memory.budgetBytes !== undefined ? { admissibleBytes: memory.budgetBytes } : {}),
  };
}

/**
 * KV a model would carry at the window this machine will actually launch it
 * with. A 16 GB Mac or an 8 GB card runs at the 32K floor, so pricing its
 * badges at 64K buries models the daemon would happily admit.
 */
function fitKvBytes(
  manifest: { kvBytesPerTokenF16?: number; kvFixedBytesF16?: number },
  memory: MemoryProfile,
): number {
  const { totalRamBytes, gpuVramBytes } = fitMachine(memory);
  return estimateManifestKvBytes(manifest, {
    ctxTokens: localContextFloorTokens({ totalRamBytes, gpuVramBytes }),
  });
}

/**
 * Adapt the /api/system/memory profile to the recommendation module's
 * device shape. `darwin-unified` is the only source that implies
 * macOS; the unified-pool GB10 case is caught by the vram-vs-ram
 * ratio inside `isUnifiedMemoryDevice`.
 */
function recoDeviceFromMemory(memory: MemoryProfile): RecoDevice {
  return {
    platform: memory.source === 'darwin-unified' ? 'darwin' : 'other',
    gpuVramBytes: memory.gpuVramBytes,
    ...(memory.gpuMemoryKind ? { gpuMemoryKind: memory.gpuMemoryKind } : {}),
    totalRamBytes: memory.totalRamBytes,
    usableBytes: memory.usableBytes,
    ...(memory.budgetBytes !== undefined ? { budgetBytes: memory.budgetBytes } : {}),
  };
}

function formatApprox(bytes: number): string {
  return `~${formatBytes(bytes)}`;
}

function formatReleased(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

interface ActiveInstall {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  /**
   * When set, the shared downloader is between attempts. Cleared on
   * the next `progress` event. UI renders "Connection dropped —
   * retrying in 4s (attempt 3/5)…" while present.
   */
  retrying?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  };
  error?: string;
  /**
   * `local` — this React instance kicked off the install via SSE and
   * owns the AbortController for its own event stream.
   * `remote` — the install was discovered via the polled
   * `/active-installs` endpoint; another path (the first-run
   * bootstrap, or another open Settings tab) started it. Either way the
   * install itself is a server-owned background job, so Cancel works for
   * both origins via the explicit cancel endpoint.
   */
  origin: 'local' | 'remote';
  controller?: AbortController;
}

/**
 * Narrow a catalog entry to "chat-model with a llamaCpp source
 * block" — entries that exist only as Ollama tags don't appear in
 * the llama.cpp picker.
 */
function asLlamaCppEntry(
  m: CatalogItemSummary['manifest'],
): (ChatModelManifest & { llamaCpp: NonNullable<ChatModelManifest['llamaCpp']> }) | null {
  if (m.kind !== 'chat-model') return null;
  if (!m.llamaCpp) return null;
  return m as ChatModelManifest & { llamaCpp: NonNullable<ChatModelManifest['llamaCpp']> };
}

const TAG_TOOLTIPS: Record<string, string> = {
  'mix of experts':
    "Only a fraction of the model's parameters run per token, so it's faster than a dense model of the same nominal size.",
  vision: 'Can accept images alongside text.',
  tools: 'Supports function/tool calling via the API.',
  multimodal: 'Handles multiple input types (text + images).',
  large: 'Heavy model — needs a lot of memory and runs more slowly.',
  small: 'Compact model — runs quickly on modest hardware.',
};

interface Props {
  /**
   * Called whenever the installed model list changes (install
   * succeeded, delete succeeded). The Home tab uses this to re-run
   * its probe so the "no models yet" state flips to "ready" without
   * a page reload.
   */
  onModelsChanged?: () => void;
  /** When true, swap headings for compact copy suitable for onboarding. */
  compact?: boolean;
}

/**
 * llama.cpp local model install/list/delete UX. Mirrors
 * OllamaModelManager structurally but talks to /api/llama-cpp/* and
 * always uses the `llamaCpp` source block from chat-model entries.
 */
export function LlamaCppModelManager({ onModelsChanged, compact = false }: Props) {
  const [models, setModels] = useState<LlamaCppInstalledModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  // Interrupted/unverified downloads holding disk with no install manifest —
  // invisible to the installed list. Surfaced so the user can resume or
  // delete them before the daemon's 7-day reclaim sweep.
  const [incomplete, setIncomplete] = useState<IncompleteModelDownload[]>([]);
  const [unrecognized, setUnrecognized] = useState<UnrecognizedLocalModel[]>([]);
  const [installs, setInstalls] = useState<Map<string, ActiveInstall>>(new Map());
  const [installWarning, setInstallWarning] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [installError, setInstallError] = useState<string | null>(null);
  // A pinned-checksum mismatch (upstream re-published the file). Tracked
  // separately from `installError` so we can show a friendly "newer
  // upstream" prompt with a "Download anyway" action instead of dumping
  // a raw sha256 comparison the user can't act on.
  const [installMismatch, setInstallMismatch] = useState<{
    catalogId: string;
    file: string;
  } | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryProfile | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Which model row has the context-size editor expanded beneath it.
  const [contextEditorFor, setContextEditorFor] = useState<string | null>(null);
  // False until the override endpoint answers — an older daemon or machine
  // broker 404s and the affordance hides rather than erroring per row.
  const [contextOverridesSupported, setContextOverridesSupported] = useState(false);
  const [catalogItems, setCatalogItems] = useState<CatalogItemSummary[]>([]);
  const [fitness, setFitness] = useState<Map<string, ModelFitnessEntry>>(new Map());
  const [probing, setProbing] = useState<string[]>([]);
  const probingRef = useRef<string[]>([]);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const hadRemoteInstallRef = useRef(false);

  const refreshFitness = useCallback(async () => {
    try {
      const res = await api.listModelFitness();
      setFitness(new Map(res.records.map((r) => [r.key, r])));
      setProbing(res.probing);
      probingRef.current = res.probing;
    } catch {
      /* fitness surface is advisory — a blip just keeps the last state */
    }
  }, []);

  const refreshIncomplete = useCallback(async () => {
    try {
      const res = await api.listIncompleteLlamaCppModels();
      setIncomplete(res.incomplete ?? []);
    } catch {
      /* advisory surface — a blip just keeps the last state */
    }
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;

    setModelsLoading(true);
    const request = (async () => {
      try {
        const res = await api.listLlamaCppModels();
        setModels(res.models);
        setUnrecognized(res.unrecognized ?? []);
        setModelsError(null);
      } catch (err) {
        setModelsError(err instanceof Error ? err.message : String(err));
      } finally {
        setModelsLoading(false);
      }
      void refreshFitness();
      void refreshIncomplete();
    })();
    refreshInFlight.current = request;
    void request.then(() => {
      if (refreshInFlight.current === request) refreshInFlight.current = null;
    });
    return request;
  }, [refreshFitness, refreshIncomplete]);

  useEffect(() => {
    void refresh();
    void api
      .getMemoryProfile()
      .then((m) => setMemory(m as MemoryProfile))
      .catch(() => {});
    void api
      .getModelContextOverrides('llama-cpp')
      .then(() => setContextOverridesSupported(true))
      .catch(() => setContextOverridesSupported(false));
  }, [refresh]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const engine = changedModelInventoryEngine(event);
      if (engine === 'llama-cpp') void refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // Poll the service for installs that another path kicked off — the
  // first-run bootstrap is the load-bearing case (Home banner says
  // "installing Gemma 4 (E2B)" while Settings would otherwise show
  // every model with a fresh "Install" button). Local installs that
  // this component started via SSE keep their own state and aren't
  // touched by the merge below.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.listLlamaCppActiveInstalls();
        if (cancelled) return;
        setInstalls((prev) => {
          const next = new Map(prev);
          const seen = new Set<string>();
          for (const remote of res.installs) {
            seen.add(remote.catalogId);
            const existing = next.get(remote.catalogId);
            if (existing && existing.origin === 'local') {
              // The local SSE handler is authoritative — it has the
              // controller and finer-grained progress timing.
              continue;
            }
            next.set(remote.catalogId, {
              catalogId: remote.catalogId,
              bytesWritten: remote.bytesWritten,
              totalBytes: remote.totalBytes,
              phase: remote.phase,
              origin: 'remote',
            });
          }
          // Drop remote entries the server no longer reports —
          // either the install completed or errored. Local entries
          // are cleared by their own SSE finalizer; never evict them
          // here.
          for (const [id, entry] of next) {
            if (entry.origin === 'remote' && !seen.has(id)) {
              next.delete(id);
            }
          }
          return next;
        });
        // Refresh only on the non-empty -> empty transition. Refreshing on
        // every empty poll reloaded every installed GGUF every two seconds,
        // including expensive metadata previews, even while Settings was
        // otherwise idle.
        const hadRemoteInstall = hadRemoteInstallRef.current;
        hadRemoteInstallRef.current = res.installs.length > 0;
        if (hadRemoteInstall && res.installs.length === 0) {
          void refresh();
        }
      } catch {
        /* service blip — try again on the next tick */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refresh]);

  // Fitness polling owns its own timer, deliberately NOT the install tick's.
  // It used to run at the tail of that tick, behind `await
  // listLlamaCppActiveInstalls()` — so while a multi-GB download had the
  // daemon busy, the pills froze on "checking fitness…" for as long as that
  // request stayed slow, long after the probe had finished and failed.
  // Self-scheduling (not setInterval) so a slow request never stacks up.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await refreshFitness();
      if (cancelled) return;
      // Fast while a proeve is in flight; slow otherwise, which is what lets
      // an install-triggered probe appear without the user doing anything.
      timer = setTimeout(() => void loop(), probingRef.current.length > 0 ? 2_000 : 15_000);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshFitness]);

  const handleEvent = useCallback((catalogId: string, ev: LlamaCppInstallEvent) => {
    if (ev.type === 'progress') {
      setInstalls((prev) => {
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        // Drop any prior retrying/error state — fresh progress means
        // the downloader successfully resumed.
        const { retrying: _retrying, error: _error, ...rest } = cur;
        next.set(catalogId, {
          ...rest,
          bytesWritten: ev.bytesWritten,
          totalBytes: ev.totalBytes || cur.totalBytes,
          phase: 'downloading',
        });
        return next;
      });
    } else if (ev.type === 'retrying') {
      setInstalls((prev) => {
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(catalogId, {
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
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(catalogId, { ...cur, phase: 'verifying' });
        return next;
      });
    } else if (ev.type === 'extracting-metadata') {
      setInstalls((prev) => {
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(catalogId, { ...cur, phase: 'extracting-metadata' });
        return next;
      });
    } else if (ev.type === 'done') {
      if (ev.warning) setInstallWarning({ id: ev.id, message: ev.warning });
    } else if (ev.type === 'error') {
      if (ev.mismatch) {
        // Checksum mismatch = the upstream file changed since this
        // Gezel's catalog was pinned (model authors routinely re-publish
        // chat_template.jinja / tokenizer configs). Drop the row and
        // surface a friendly prompt instead of the raw sha dump.
        const file = ev.mismatch.file;
        setInstalls((prev) => {
          const next = new Map(prev);
          next.delete(catalogId);
          return next;
        });
        setInstallMismatch({ catalogId, file });
        return;
      }
      // Keep the install row alive so the user can hit Retry inline,
      // not just an error in the banner up top. The auto-cleanup in
      // `startInstall`'s `finally` removes it on natural completion;
      // when there's an error the row sits with the error attached
      // until the user clicks Retry or Cancel.
      setInstalls((prev) => {
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(catalogId, { ...cur, error: ev.error, retrying: undefined });
        return next;
      });
      setInstallError(ev.error);
    }
  }, []);

  const startInstall = useCallback(
    (catalogId: string, opts?: { skipSha?: boolean }) => {
      if (installs.has(catalogId)) return;
      setInstallError(null);
      setInstallMismatch(null);
      const controller = new AbortController();
      setInstalls((prev) => {
        const next = new Map(prev);
        next.set(catalogId, {
          catalogId,
          bytesWritten: 0,
          totalBytes: 0,
          phase: 'downloading',
          origin: 'local',
          controller,
        });
        return next;
      });

      // Client handles bearer auth + SSE framing; we just consume
      // the typed events as they arrive.
      void (async () => {
        try {
          await api.installLlamaCppModel(
            catalogId,
            (ev) => handleEvent(catalogId, ev),
            controller.signal,
            opts?.skipSha ? { skipSha: true } : undefined,
          );
          announceModelInventoryChanged('llama-cpp');
        } catch (err) {
          if (!controller.signal.aborted) {
            const message = `download failed: ${describe(err)}`;
            setInstallError(message);
            // Stamp the failure onto the row so the `finally` holds it for
            // an inline Retry instead of deleting it (a silent revert to
            // "Download"). Covers a stream that closed without ever
            // emitting an `error` event — the client now throws here.
            setInstalls((prev) => {
              const cur = prev.get(catalogId);
              if (!cur) return prev;
              const next = new Map(prev);
              next.set(catalogId, { ...cur, error: cur.error ?? message, retrying: undefined });
              return next;
            });
          }
        } finally {
          setInstalls((prev) => {
            const next = new Map(prev);
            const cur = next.get(catalogId);
            // Hold the row on error so the user can Retry inline. The
            // shared downloader will resume from the existing
            // `.partial` on the next attempt.
            if (cur?.error) {
              next.set(catalogId, { ...cur, controller: undefined });
              return next;
            }
            next.delete(catalogId);
            return next;
          });
          void refresh();
          onModelsChanged?.();
        }
      })();
    },
    [installs, refresh, handleEvent, onModelsChanged],
  );

  // "Download anyway" from the mismatch prompt — reinstall bypassing the
  // pinned-checksum check so the current upstream file is accepted.
  const downloadAnyway = useCallback(
    (catalogId: string) => {
      setInstallMismatch(null);
      startInstall(catalogId, { skipSha: true });
    },
    [startInstall],
  );

  const cancelInstall = useCallback(
    (catalogId: string) => {
      // Installs run as background jobs on the service — closing the SSE
      // stream only detaches this view, so cancellation must be the
      // explicit server-side call. Works for `remote`-origin rows too.
      const inflight = installs.get(catalogId);
      inflight?.controller?.abort();
      void api.cancelLlamaCppModelInstall(catalogId).catch(() => {});
      setInstalls((prev) => {
        const next = new Map(prev);
        next.delete(catalogId);
        return next;
      });
    },
    [installs],
  );

  const deleteOne = useCallback(async () => {
    const id = toDelete;
    if (!id) return;
    setToDelete(null);
    setModelsError(null);
    // Optimistically drop the row (from both the installed and incomplete
    // lists) so the delete feels instant even when the daemon is briefly busy
    // — a concurrent download verify can otherwise delay the round-trip and
    // make a successful delete look like a no-op. On failure we refresh (which
    // restores whatever still exists) and surface the error.
    setModels((cur) => cur.filter((m) => m.id !== id));
    setIncomplete((cur) => cur.filter((d) => d.id !== id));
    setUnrecognized((cur) => cur.filter((model) => model.id !== id));
    try {
      await api.deleteLlamaCppModel(id);
      announceModelInventoryChanged('llama-cpp');
      await refresh();
      onModelsChanged?.();
    } catch (err) {
      setModelsError(`delete failed: ${describe(err)}`);
      void refresh();
    }
  }, [toDelete, refresh, onModelsChanged]);

  const installedIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  const attentionIds = useMemo(
    () => new Set(unrecognized.map((model) => model.id)),
    [unrecognized],
  );

  // Catalog manifests keyed by id — the installed table joins tags
  // (MoE-ness) through this for the hardware hint pill.
  const catalogById = useMemo(() => {
    const map = new Map<string, ChatModelManifest>();
    for (const item of catalogItems) {
      const m = asLlamaCppEntry(item.manifest);
      if (m) map.set(m.id, m);
    }
    return map;
  }, [catalogItems]);

  return (
    <div className="ollama-model-manager">
      {installs.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(installs.values()).map((inst) => (
              <InstallProgress
                key={inst.catalogId}
                inst={inst}
                onCancel={() => cancelInstall(inst.catalogId)}
                onRetry={() => {
                  // Drop the failed row and re-kick. The shared
                  // downloader picks up from the existing `.partial`
                  // so this isn't a full restart.
                  setInstalls((prev) => {
                    const next = new Map(prev);
                    next.delete(inst.catalogId);
                    return next;
                  });
                  setInstallError(null);
                  startInstall(inst.catalogId);
                }}
              />
            ))}
          </div>
        </div>
      )}

      <UnrecognizedModels
        items={unrecognized.filter((model) => !installs.has(model.id))}
        onUpdate={(id) => startInstall(id)}
        onRemove={(id) => setToDelete(id)}
      />

      <IncompleteDownloads
        items={incomplete.filter((d) => !installs.has(d.id))}
        onResume={(id) => startInstall(id)}
        onDelete={(id) => setToDelete(id)}
      />

      {installMismatch && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            ⚠ <code>{installMismatch.catalogId}</code> is newer on Hugging Face than the version
            Gezel knows about
          </div>
          <p style={{ marginBottom: '0.5rem' }}>
            The file <code>{installMismatch.file}</code> changed upstream, so its checksum no longer
            matches what this version of Gezel pinned. This is almost always a harmless upstream fix
            — model authors routinely re-publish chat templates and tokenizer configs — but we can't
            verify it automatically. You can download the current version now, or wait for a Gezel
            update with a refreshed catalog.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="gz-link-button"
              onClick={() => downloadAnyway(installMismatch.catalogId)}
            >
              Download anyway
            </button>
            <button
              type="button"
              className="gz-link-button"
              onClick={() => setInstallMismatch(null)}
            >
              Dismiss
            </button>
          </div>
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
            ⚠ {installWarning.id}: {installWarning.message}
          </div>
        </div>
      )}

      {!compact && (
        <SharedModelMigrationPanel engine="llama-cpp" onModelsChanged={onModelsChanged} />
      )}

      {(modelsLoading || models.length > 0 || modelsError) && (
        <div className="ollama-section">
          <h4>{compact ? 'Models on this device' : 'Local models'}</h4>
          {modelsLoading && models.length === 0 && !modelsError && (
            <p className="muted small" aria-live="polite">
              Checking shared models… Large models can take a few minutes the first time; later
              starts use the local verification cache.
            </p>
          )}
          {modelsError && <p className="error">{modelsError}</p>}
          {models.length > 0 && (
            <div className="ollama-model-table-wrap">
              <table className="ollama-model-table">
                <colgroup>
                  <col className="model-name-column" />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Quant</th>
                    <th title="Effective per-turn context size after Gezel's settings and memory limits">
                      Context size
                    </th>
                    <th title="Representative startup and decode speed with an approximately 20K-token prompt">
                      Fitness
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const updating = installs.has(m.id);
                    const fitnessKey = `llama-cpp:${m.id}`;
                    const entry = fitness.get(fitnessKey);
                    const catalogManifest = catalogById.get(m.id);
                    // Single-slot, not the fleet reservation: the admission
                    // ladder sheds slots to fit, so a model is never unusable
                    // because of slot count. Pricing the fleet here would flag
                    // models as too big that the daemon would happily run.
                    const installedResidentBytes =
                      m.predictedResidentBytes ??
                      estimateLlamaCppResidentBytes(m.approxSizeBytes, {
                        mmprojBytes: m.mmprojSizeBytes,
                      });
                    const ramFit = memory
                      ? computeModelFit({
                          residentBytes: installedResidentBytes,
                          isMoE: isMoEFromTags(catalogManifest?.tags),
                          ...fitMachine(memory),
                        })
                      : undefined;
                    const hint =
                      memory && catalogManifest
                        ? hardwareHint(recoDeviceFromMemory(memory), {
                            isMoE: isMoEFromTags(catalogManifest.tags),
                            fitTier: ramFit?.tier ?? 'fits',
                            residentBytes: installedResidentBytes,
                          })
                        : null;
                    return (
                      <Fragment key={m.id}>
                        <tr>
                          <td className="model-name-table-cell">
                            <div className="model-name-cell">
                              <code>{m.id}</code>
                              <div className="model-name-meta">
                                {hint && (
                                  <span
                                    className={`gz-status-pill${hint.kind === 'moe-good-match' ? ' gz-status-pill--ok' : ''}`}
                                    title={hint.detail}
                                  >
                                    {hint.label}
                                  </span>
                                )}
                                {m.updateAvailable && (
                                  <span
                                    className="gz-status-pill gz-status-pill--warn"
                                    title={
                                      m.updateReason ??
                                      (m.availableVersion
                                        ? `A newer build is available in the catalog (→ v${m.availableVersion}). Updating downloads only the files that differ.`
                                        : 'A newer build is available in the catalog.')
                                    }
                                  >
                                    update available
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <ModelSizeCell model={m} />
                          <td title={quantizationTitle(m.quantization, m.ggufQuantization)}>
                            {approximateQuantizationLabel(m.quantization, m.ggufQuantization)}
                          </td>
                          <td
                            title={
                              m.effectiveContextWindow
                                ? m.overrideContextTokens !== undefined
                                  ? `You've set this model to ${m.overrideContextTokens.toLocaleString()} tokens per turn; Gezel grants up to what memory allows (currently ${m.effectiveContextWindow.toLocaleString()}).`
                                  : `Gezel will grant up to ${m.effectiveContextWindow.toLocaleString()} tokens per turn${m.contextWindow ? `; the model advertises ${m.contextWindow.toLocaleString()} tokens` : ''}. The effective size accounts for model tuning, settings, concurrency, and available memory — Adaptive grows it past 64K when fast memory has room.`
                                : m.contextSizingStatus === 'restart-required'
                                  ? 'This model is running with a different context window than the current sizing settings resolve to. Restart the local engine (or let it go idle) so Gezel can re-admit it — no memory change needed.'
                                  : m.contextSizingStatus === 'insufficient-memory'
                                    ? `The selected context sizing policy needs${m.contextWindow ? ` this model's full advertised ${m.contextWindow.toLocaleString()}-token window` : ' more context'}, which does not fit in memory safely. Choose Adaptive, unload another model, or free memory before trying again.`
                                    : 'The effective context size is unavailable.'
                            }
                          >
                            {m.contextSizingStatus === 'restart-required' ? (
                              'Restart needed'
                            ) : m.contextSizingStatus === 'insufficient-memory' ? (
                              "Won't fit"
                            ) : (
                              <>
                                {formatContextWindow(m.effectiveContextWindow)}
                                {m.overrideContextTokens !== undefined && (
                                  <span className="gz-budget-tag gz-budget-tag-custom model-context-custom-tag">
                                    custom
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <ModelFitnessCell entry={entry} probing={probing.includes(fitnessKey)} />
                          <td className="model-actions-table-cell">
                            <div className="model-actions-cell">
                              <div className="model-action-status">
                                {m.readOnly && (
                                  <span
                                    className="muted small"
                                    title="Provided by the machine-wide install (shared asset store). It can't be removed from here — manage it with the machine installer, or install a user-owned copy to shadow it."
                                  >
                                    Machine model
                                  </span>
                                )}
                              </div>
                              <div className="model-action-links">
                                <ModelActionsMenu
                                  engine="llama-cpp"
                                  model={m}
                                  updating={updating}
                                  contextSupported={contextOverridesSupported}
                                  contextEditorOpen={contextEditorFor === m.id}
                                  onToggleContextEditor={() =>
                                    setContextEditorFor((prev) => (prev === m.id ? null : m.id))
                                  }
                                  fitnessAction={fitnessMenuAction(
                                    entry,
                                    probing.includes(fitnessKey),
                                    () => {
                                      void api
                                        .runModelFitnessProbe('llama-cpp', m.id)
                                        .then(() => refreshFitness())
                                        .catch(() => {});
                                    },
                                  )}
                                  onUpdate={() => startInstall(m.id)}
                                  onDelete={() => setToDelete(m.id)}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                        {contextEditorFor === m.id && (
                          <tr className="model-context-editor-row">
                            <td colSpan={6}>
                              <ModelContextSliderPanel
                                engine="llama-cpp"
                                model={m}
                                onSaved={refresh}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="ollama-section ollama-section--flat ollama-section--download">
        <h4>Download a model</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Models are hosted by{' '}
          <a
            href="https://huggingface.co"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit' }}
          >
            Hugging Face
          </a>
          , a community library of open, freely available AI models. Your device downloads them
          directly.
        </p>
        <p className="muted small">
          {memory
            ? 'Models that may not fit this machine, and retired models, are hidden by default. '
            : 'Retired models are hidden by default. '}
          <button
            type="button"
            className="gz-link-button"
            onClick={() => setShowAll((v) => !v)}
            style={{ padding: 0 }}
          >
            {showAll
              ? memory
                ? 'Hide retired and oversized models'
                : 'Hide retired models'
              : 'Show all models'}
          </button>
        </p>
        <CatalogBrowser
          kind="chat-model"
          emptyMessage="No on-device models in the catalog yet."
          onItemsLoaded={setCatalogItems}
          tagTooltips={TAG_TOOLTIPS}
          filter={(item: CatalogItemSummary) => {
            const m = asLlamaCppEntry(item.manifest);
            if (!m) return false;
            if (!showAll && isRetiredModel(m)) return false;
            if (!showAll && memory) {
              // MoE-aware: keep any model that can RUN (incl. big MoE that
              // fits only via expert-offload to RAM) — hide only the truly
              // too-big. Replaces the old dense-naive `size > budget` hide,
              // which wrongly buried offloadable MoE models.
              const fit = computeModelFit({
                residentBytes:
                  estimateLlamaCppResidentBytes(m.llamaCpp.approxSizeBytes, {
                    mmprojBytes: m.llamaCpp.mmproj?.sizeBytes,
                  }) + fitKvBytes(m, memory),
                isMoE: isMoEFromTags(item.manifest.tags),
                ...fitMachine(memory),
              });
              if (!fit.runnable) return false;
            }
            return true;
          }}
          action={(item: CatalogItemSummary) => {
            const m = asLlamaCppEntry(item.manifest);
            if (!m) return null;
            const installed = installedIds.has(m.id);
            const needsAttention = attentionIds.has(m.id);
            const inflight = installs.get(m.id);
            const pct =
              inflight && inflight.totalBytes > 0
                ? Math.min(100, Math.round((inflight.bytesWritten / inflight.totalBytes) * 100))
                : null;
            const fit = memory
              ? computeModelFit({
                  residentBytes:
                    estimateLlamaCppResidentBytes(m.llamaCpp.approxSizeBytes) +
                    fitKvBytes(m, memory),
                  isMoE: isMoEFromTags(item.manifest.tags),
                  ...fitMachine(memory),
                })
              : null;
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <HuggingFaceRepoLink repo={m.llamaCpp.huggingfaceRepo} />
                    <span>·</span>
                    <span>{m.parameterSize}</span>
                    <span>·</span>
                    <span>{formatApprox(m.llamaCpp.approxSizeBytes)}</span>
                    {formatReleased(m.releasedAt) && (
                      <>
                        <span>·</span>
                        <span>{formatReleased(m.releasedAt)}</span>
                      </>
                    )}
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton
                      manifest={m}
                      fallbackHref={huggingFaceRepoUrl(m.llamaCpp.huggingfaceRepo)}
                    />
                    {fit && fit.tier !== 'fits' && (
                      <span
                        className={`gz-status-pill ${fit.tier === 'fits-offload' ? 'gz-status-pill--ok' : 'gz-status-pill--warn'}`}
                        title={fit.detail}
                      >
                        {fit.label}
                      </span>
                    )}
                    {(() => {
                      const hint =
                        memory && fit
                          ? hardwareHint(recoDeviceFromMemory(memory), {
                              isMoE: isMoEFromTags(item.manifest.tags),
                              fitTier: fit.tier,
                              residentBytes:
                                estimateLlamaCppResidentBytes(m.llamaCpp.approxSizeBytes) +
                                fitKvBytes(m, memory),
                            })
                          : null;
                      if (!hint) return null;
                      return (
                        <span
                          className={`gz-status-pill${hint.kind === 'moe-good-match' ? ' gz-status-pill--ok' : ''}`}
                          title={hint.detail}
                        >
                          {hint.label}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={installed || needsAttention || Boolean(inflight)}
                  onClick={() => startInstall(m.id)}
                >
                  {installed
                    ? 'On device'
                    : inflight
                      ? inflight.phase === 'downloading'
                        ? pct !== null
                          ? `Downloading… ${pct}%`
                          : 'Downloading…'
                        : inflight.phase === 'verifying'
                          ? 'Verifying…'
                          : 'Reading metadata…'
                      : needsAttention
                        ? 'Needs attention above'
                        : 'Download'}
                </button>
              </div>
            );
          }}
        />
      </div>

      <div className="ollama-section ollama-section--flat">
        <ImportModelBundleButton />
        <span className="muted small" style={{ marginLeft: '0.75rem' }}>
          Import from a gezel local model package
        </span>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete ${toDelete ?? ''}?`}
        message="This removes the downloaded model from your device. It stays available in the catalog — you can download it again any time."
        confirmLabel="Delete"
        danger
        onConfirm={deleteOne}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}

function InstallProgress({
  inst,
  onCancel,
  onRetry,
}: {
  inst: ActiveInstall;
  onCancel: () => void;
  /** Called when the user clicks Retry after auto-retries are exhausted.
   *  Re-kicks the install — the shared downloader resumes from the
   *  existing `.partial`, so this isn't a full restart. */
  onRetry: () => void;
}) {
  const known = inst.totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((inst.bytesWritten / inst.totalBytes) * 100)) : 0;
  // Status precedence: hard error > retrying-between-attempts > normal phase.
  let phaseLabel: string;
  if (inst.error) {
    phaseLabel = inst.error;
  } else if (inst.retrying) {
    const delaySec = Math.max(1, Math.round(inst.retrying.delayMs / 1000));
    phaseLabel = `${inst.retrying.reason} — retrying in ${delaySec}s (attempt ${inst.retrying.attempt}/${inst.retrying.maxAttempts})`;
  } else if (inst.phase === 'downloading') {
    phaseLabel = known
      ? `Downloading ${formatBytes(inst.bytesWritten)} of ${formatBytes(inst.totalBytes)} (${pct}%)`
      : `Downloading ${formatBytes(inst.bytesWritten)}…`;
  } else if (inst.phase === 'verifying') {
    phaseLabel = 'Checking download…';
  } else {
    phaseLabel = 'Reading model info…';
  }
  const indeterminate = inst.phase !== 'downloading' || !known;
  return (
    <div
      className={`ollama-pull${inst.error ? ' ollama-pull-error' : inst.retrying ? ' ollama-pull-warning' : ''}`}
    >
      <div className="ollama-pull-head">
        <code>{inst.catalogId}</code>
        <span className="muted small">{phaseLabel}</span>
        {inst.error ? (
          <button type="button" className="gz-link-button" onClick={onRetry}>
            Retry
          </button>
        ) : (
          /* Cancel always available: installs are server-owned background
             jobs, so this view can cancel remote-origin rows too. */
          <button type="button" className="gz-link-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {indeterminate ? (
        <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
          <div className="ollama-pull-bar-fill" />
        </div>
      ) : (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${pct}%` }} />
          <span className="ollama-pull-bar-label">{pct}%</span>
        </div>
      )}
    </div>
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
