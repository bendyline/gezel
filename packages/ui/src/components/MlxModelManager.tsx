import type { CatalogItemSummary, ChatModelCategory, ChatModelManifest } from '@bendyline/gezel';
import { composeFitnessBadge } from '@bendyline/gezel';
import type {
  IncompleteModelDownload,
  MlxInstallEvent,
  MlxInstalledModel,
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
import { IncompleteDownloads } from './IncompleteDownloads.js';
import { LicenseButton } from './LicenseButton.js';
import { ImportModelBundleButton } from './ModelBundleControls.js';
import { ModelActionsMenu, ModelContextSliderPanel } from './ModelContextControls.js';
import { ModelSizeCell } from './ModelSizeCell.js';
import { RecommendedBadge } from './RecommendedBadge.js';
import { SharedModelMigrationPanel } from './SharedModelMigrationPanel.js';
import { UnrecognizedModels } from './UnrecognizedModels.js';
import { mlxFitsMemoryBudget } from './mlx-model-fit.js';
import { formatContextWindow } from './model-context.js';
import { formatBytes } from './model-memory-copy.js';
import { approximateQuantizationLabel, quantizationTitle } from './model-quantization.js';

interface MemoryProfile {
  totalRamBytes: number;
  gpuVramBytes: number | null;
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'gpu-integrated' | 'system-ram-fallback';
  usableBytes: number;
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

// MLX install progress is multi-file (weights ship as multiple
// safetensors shards + a tokenizer). `fileIndex` / `fileCount` /
// `file` track which shard is downloading right now;
// `bytesWrittenAll` / `totalBytesAll` track the cumulative download
// across every shard so the UI can render one model-wide progress bar
// instead of per-shard bars that reset to zero on every new file.
interface ActiveInstall {
  catalogId: string;
  fileIndex: number;
  fileCount: number;
  file: string;
  bytesWrittenAll: number;
  totalBytesAll: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  /**
   * When set, the shared downloader is between attempts for the
   * current shard. UI surfaces "Connection dropped on shard 2/5 —
   * retrying in 4s (attempt 3/5)…". Cleared on next `progress`.
   */
  retrying?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
    file: string;
  };
  /** Held terminal error so the row stays alive for a Retry click. */
  error?: string;
  /**
   * `local` — owns an SSE stream + AbortController.
   * `remote` — discovered via `/active-installs` polling (e.g. the
   *   first-run bootstrap fired the install server-side). Cancel is
   *   hidden because we don't own the lifecycle. See
   *   LlamaCppModelManager for the matching pattern.
   */
  origin: 'local' | 'remote';
  controller?: AbortController;
}

function asMlxEntry(
  m: CatalogItemSummary['manifest'],
): (ChatModelManifest & { mlx: NonNullable<ChatModelManifest['mlx']> }) | null {
  if (m.kind !== 'chat-model') return null;
  // No mlx build, or a build flagged as known-broken on MLX via
  // `disabledReason` — not offered in the MLX picker. The model may still be
  // installable via llama.cpp.
  if (!m.mlx || m.mlx.disabledReason) return null;
  return m as ChatModelManifest & { mlx: NonNullable<ChatModelManifest['mlx']> };
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
  onModelsChanged?: () => void;
  compact?: boolean;
}

type CategoryTab = ChatModelCategory | 'all';

/**
 * MLX local model install/list/delete UX. Structural twin of
 * LlamaCppModelManager — same CatalogBrowser, same InstallProgress,
 * same memory-budget filter — pointed at /api/mlx/* with the `mlx`
 * source block.
 */
export function MlxModelManager({ onModelsChanged, compact = false }: Props) {
  const [models, setModels] = useState<MlxInstalledModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Interrupted/unverified downloads with no manifest — invisible to the
  // installed list. Surfaced for resume/delete before the reclaim sweep.
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
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('all');
  // Which model row has the context-size editor expanded beneath it.
  const [contextEditorFor, setContextEditorFor] = useState<string | null>(null);
  // False until the override endpoint answers — an older daemon or machine
  // broker 404s and the affordance hides rather than erroring per row.
  const [contextOverridesSupported, setContextOverridesSupported] = useState(false);
  const [catalogItems, setCatalogItems] = useState<CatalogItemSummary[]>([]);
  const [fitness, setFitness] = useState<Map<string, ModelFitnessEntry>>(new Map());
  const [probing, setProbing] = useState<string[]>([]);
  const probingRef = useRef<string[]>([]);

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
      const res = await api.listIncompleteMlxModels();
      setIncomplete(res.incomplete ?? []);
    } catch {
      /* advisory surface — a blip just keeps the last state */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listMlxModels();
      setModels(res.models);
      setUnrecognized(res.unrecognized ?? []);
      setModelsError(null);
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
    }
    void refreshFitness();
    void refreshIncomplete();
  }, [refreshFitness, refreshIncomplete]);

  useEffect(() => {
    void refresh();
    void api
      .getMemoryProfile()
      .then((m) => setMemory(m as MemoryProfile))
      .catch(() => {});
    void api
      .getModelContextOverrides('mlx')
      .then(() => setContextOverridesSupported(true))
      .catch(() => setContextOverridesSupported(false));
  }, [refresh]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const engine = changedModelInventoryEngine(event);
      if (engine === 'mlx') void refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // Mirror server-driven installs (most importantly the first-run
  // bootstrap one) into our local progress state. See the matching
  // effect on LlamaCppModelManager for the full rationale.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.listMlxActiveInstalls();
        if (cancelled) return;
        setInstalls((prev) => {
          const next = new Map(prev);
          const seen = new Set<string>();
          for (const remote of res.installs) {
            seen.add(remote.catalogId);
            const existing = next.get(remote.catalogId);
            if (existing && existing.origin === 'local') continue;
            next.set(remote.catalogId, {
              catalogId: remote.catalogId,
              fileIndex: 0,
              fileCount: 1,
              file: '',
              bytesWrittenAll: remote.bytesWritten,
              totalBytesAll: remote.totalBytes,
              phase: remote.phase,
              origin: 'remote',
            });
          }
          for (const [id, entry] of next) {
            if (entry.origin === 'remote' && !seen.has(id)) next.delete(id);
          }
          return next;
        });
        if (res.installs.length === 0) {
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

  // Own timer, not the install tick's: running behind that tick's
  // `await listMlxActiveInstalls()` froze the pills on "checking fitness…"
  // whenever a large download kept that request slow. Self-scheduling so a
  // slow request never stacks up.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await refreshFitness();
      if (cancelled) return;
      timer = setTimeout(() => void loop(), probingRef.current.length > 0 ? 2_000 : 15_000);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshFitness]);

  const handleEvent = useCallback((catalogId: string, ev: MlxInstallEvent) => {
    if (ev.type === 'progress') {
      setInstalls((prev) => {
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        // Drop any prior retrying/error state — fresh progress means resume succeeded.
        const { retrying: _r, error: _e, ...rest } = cur;
        next.set(catalogId, {
          ...rest,
          fileIndex: ev.fileIndex,
          fileCount: ev.fileCount,
          file: ev.file,
          bytesWrittenAll: ev.bytesWrittenAll,
          totalBytesAll: ev.totalBytesAll || cur.totalBytesAll,
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
            file: ev.file,
          },
        });
        return next;
      });
    } else if (ev.type === 'verifying') {
      setInstalls((prev) => {
        const cur = prev.get(catalogId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(catalogId, { ...cur, file: ev.file, phase: 'verifying' });
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
      // Hold the row so the user can Retry inline; the shared
      // downloader resumes from the existing `.partial`.
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
          fileIndex: 0,
          fileCount: 1,
          file: '',
          bytesWrittenAll: 0,
          totalBytesAll: 0,
          phase: 'downloading',
          origin: 'local',
          controller,
        });
        return next;
      });

      void (async () => {
        try {
          await api.installMlxModel(
            catalogId,
            (ev) => handleEvent(catalogId, ev),
            controller.signal,
            opts?.skipSha ? { skipSha: true } : undefined,
          );
          announceModelInventoryChanged('mlx');
        } catch (err) {
          if (!controller.signal.aborted) {
            const message = `download failed: ${describe(err)}`;
            setInstallError(message);
            // Stamp the failure onto the row so the `finally` below holds
            // it for an inline Retry instead of deleting it (which would
            // silently revert the card to "Download"). Covers the case
            // where the stream closed without ever emitting an `error`
            // event — the client now throws here rather than resolving.
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
            // Hold the row on error so user can Retry inline.
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
      void api.cancelMlxModelInstall(catalogId).catch(() => {});
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
    // Optimistically drop the row so the delete feels instant even when the
    // daemon is busy; refresh restores it (and shows the error) on failure.
    setModels((cur) => cur.filter((m) => m.id !== id));
    setIncomplete((cur) => cur.filter((d) => d.id !== id));
    setUnrecognized((cur) => cur.filter((model) => model.id !== id));
    try {
      await api.deleteMlxModel(id);
      announceModelInventoryChanged('mlx');
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

  // Map catalog-item id → current catalog manifest version. Used below
  // to flag installed models whose on-disk manifest was written
  // against an older catalog entry (upstream repo was swapped, file
  // list changed, sha256s rotated). Without this, a stale install
  // silently points at weights the catalog no longer describes and
  // the failure mode is confusing — usually `mlx_vlm.server` trying
  // to fetch a file from Hugging Face that the new build has but
  // the old install is missing.
  const catalogVersionById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of catalogItems) map.set(item.manifest.id, item.manifest.version);
    return map;
  }, [catalogItems]);

  const availableCategories = useMemo<CategoryTab[]>(() => {
    const present = new Set<ChatModelCategory>();
    for (const item of catalogItems) {
      const m = asMlxEntry(item.manifest);
      if (!m) continue;
      present.add(m.category ?? 'general');
    }
    const order: ChatModelCategory[] = ['general', 'coding', 'reasoning', 'vision', 'embedding'];
    return ['all' as CategoryTab, ...order.filter((c) => present.has(c))];
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
          <div className="home-status-pill home-status-warn" style={{ marginBottom: '0.5rem' }}>
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
              className="home-link"
              onClick={() => downloadAnyway(installMismatch.catalogId)}
            >
              Download anyway
            </button>
            <button type="button" className="home-link" onClick={() => setInstallMismatch(null)}>
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
          <div className="home-status-pill home-status-warn" style={{ marginBottom: '0.5rem' }}>
            ⚠ {installWarning.id}: {installWarning.message}
          </div>
        </div>
      )}

      {!compact && <SharedModelMigrationPanel engine="mlx" onModelsChanged={onModelsChanged} />}

      {(models.length > 0 || modelsError) && (
        <div className="ollama-section">
          <h4>{compact ? 'Models on this device' : 'Local models'}</h4>
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
                    <th title="Effective per-turn context size after Gezel's configured limit">
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
                    const latest = catalogVersionById.get(m.id);
                    const outOfDate = Boolean(
                      latest && m.catalogVersion && m.catalogVersion !== latest,
                    );
                    const reinstalling = Boolean(installs.get(m.id));
                    const fitnessKey = `mlx:${m.id}`;
                    const entry = fitness.get(fitnessKey);
                    const badge = composeFitnessBadge({
                      ...(entry
                        ? {
                            fitness: {
                              record: entry.record,
                              stale: entry.stale,
                              hardwareChanged: entry.hardwareChanged,
                            },
                          }
                        : {}),
                      probing: probing.includes(fitnessKey),
                    });
                    return (
                      <Fragment key={m.id}>
                        <tr>
                          <td className="model-name-table-cell">
                            <div className="model-name-cell">
                              <code>{m.id}</code>
                              <div className="model-name-meta">
                                {outOfDate && (
                                  <span
                                    className="home-status-pill home-status-warn"
                                    title={`Downloaded from catalog v${m.catalogVersion}; current catalog is v${latest}. The upstream repo or file list has changed — download it again to pick up the new version.`}
                                  >
                                    out of date
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <ModelSizeCell model={m} />
                          <td title={quantizationTitle(m.quantization)}>
                            {approximateQuantizationLabel(m.quantization)}
                          </td>
                          <td
                            title={
                              m.effectiveContextWindow
                                ? m.overrideContextTokens !== undefined
                                  ? `You've set this model to ${m.overrideContextTokens.toLocaleString()} tokens per turn; Gezel grants up to what memory allows (currently ${m.effectiveContextWindow.toLocaleString()}).`
                                  : `Gezel will grant up to ${m.effectiveContextWindow.toLocaleString()} tokens per turn${m.contextWindow ? `; the model advertises ${m.contextWindow.toLocaleString()} tokens` : ''}.`
                                : m.contextSizingStatus === 'restart-required'
                                  ? 'This model is running with a different context window than the current sizing settings resolve to. Restart the local engine (or let it go idle) so Gezel can re-admit it — no memory change needed.'
                                  : m.contextSizingStatus === 'insufficient-memory'
                                    ? 'The requested context window does not fit in memory safely. Unload another model or free memory before trying again.'
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
                          <td className="model-fitness-table-cell">
                            <div className="model-fitness-cell">
                              <span
                                className={`home-status-pill model-fitness-badge${
                                  badge.tier === 'probing' ? ' model-fitness-badge--probing' : ''
                                }${
                                  badge.tier === 'ok'
                                    ? ' home-status-ok'
                                    : badge.tier === 'warn'
                                      ? ' home-status-warn'
                                      : ''
                                }`}
                                title={badge.detail}
                              >
                                {badge.label}
                              </span>
                            </div>
                          </td>
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
                                  engine="mlx"
                                  model={{ ...m, updateAvailable: outOfDate }}
                                  updating={reinstalling}
                                  contextSupported={contextOverridesSupported}
                                  contextEditorOpen={contextEditorFor === m.id}
                                  onToggleContextEditor={() =>
                                    setContextEditorFor((prev) => (prev === m.id ? null : m.id))
                                  }
                                  fitnessAction={{
                                    label:
                                      badge.tier === 'probing'
                                        ? 'Checking fitness…'
                                        : entry && !entry.stale && entry.record.status !== 'blocked'
                                          ? 'Re-run fitness check'
                                          : 'Run fitness check',
                                    checking: badge.tier === 'probing',
                                    onRun: () => {
                                      void api
                                        .runModelFitnessProbe('mlx', m.id)
                                        .then(() => refreshFitness())
                                        .catch(() => {});
                                    },
                                  }}
                                  onUpdate={() => startInstall(m.id)}
                                  updateLabel={{ idle: 'Download again', busy: 'Downloading…' }}
                                  onDelete={() => setToDelete(m.id)}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                        {contextEditorFor === m.id && (
                          <tr className="model-context-editor-row">
                            <td colSpan={6}>
                              <ModelContextSliderPanel engine="mlx" model={m} onSaved={refresh} />
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
        {memory && (
          <p className="muted small">
            Some models may be too large to run on this machine.{' '}
            <button
              type="button"
              className="home-link"
              onClick={() => setShowAll((v) => !v)}
              style={{ padding: 0 }}
            >
              {showAll ? 'Hide oversized' : 'Show all sizes'}
            </button>
          </p>
        )}
        <div className="provider-switch" style={{ marginBottom: '0.5rem' }}>
          {availableCategories.map((c) => (
            <button
              key={c}
              type="button"
              className={`provider-pill${activeCategory === c ? ' provider-pill-active' : ''}`}
              onClick={() => setActiveCategory(c)}
            >
              {c === 'all' ? 'All' : c[0]?.toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
        <CatalogBrowser
          kind="chat-model"
          emptyMessage="No MLX-format entries in the catalog yet."
          onItemsLoaded={setCatalogItems}
          tagTooltips={TAG_TOOLTIPS}
          filter={(item: CatalogItemSummary) => {
            const m = asMlxEntry(item.manifest);
            if (!m) return false;
            if (activeCategory !== 'all' && (m.category ?? 'general') !== activeCategory) {
              return false;
            }
            if (!showAll && memory) {
              if (!mlxFitsMemoryBudget(m.mlx, memory.usableBytes)) {
                return false;
              }
            }
            return true;
          }}
          action={(item: CatalogItemSummary) => {
            const m = asMlxEntry(item.manifest);
            if (!m) return null;
            const installed = installedIds.has(m.id);
            const needsAttention = attentionIds.has(m.id);
            const inflight = installs.get(m.id);
            const pct =
              inflight && inflight.totalBytesAll > 0
                ? Math.min(
                    100,
                    Math.round((inflight.bytesWrittenAll / inflight.totalBytesAll) * 100),
                  )
                : null;
            const tight = memory ? !mlxFitsMemoryBudget(m.mlx, memory.usableBytes) : false;
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <code>{m.mlx.huggingfaceRepo}</code>
                    <span>·</span>
                    <span>{m.parameterSize}</span>
                    <span>·</span>
                    <span>{formatApprox(m.mlx.approxSizeBytes)}</span>
                    {formatReleased(m.releasedAt) && (
                      <>
                        <span>·</span>
                        <span>{formatReleased(m.releasedAt)}</span>
                      </>
                    )}
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton manifest={m} />
                    <RecommendedBadge manifest={m} />
                    {tight && (
                      <span
                        className="home-status-pill home-status-warn"
                        title="Larger than your estimated inference budget — may run slowly or fail."
                      >
                        may not fit
                      </span>
                    )}
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
  /** Re-kicks the install. The shared downloader resumes from the
   *  existing `.partial` so this isn't a full restart. */
  onRetry: () => void;
}) {
  const known = inst.totalBytesAll > 0;
  const pct = known
    ? Math.min(100, Math.round((inst.bytesWrittenAll / inst.totalBytesAll) * 100))
    : 0;
  // Status precedence: hard error > retrying-between-attempts > normal phase.
  let phaseLabel: string;
  if (inst.error) {
    phaseLabel = inst.error;
  } else if (inst.retrying) {
    const delaySec = Math.max(1, Math.round(inst.retrying.delayMs / 1000));
    const shardHint = inst.fileCount > 1 ? ` on shard ${inst.fileIndex}/${inst.fileCount}` : '';
    phaseLabel = `${inst.retrying.reason}${shardHint} — retrying in ${delaySec}s (attempt ${inst.retrying.attempt}/${inst.retrying.maxAttempts})`;
  } else if (inst.phase === 'downloading') {
    phaseLabel = known
      ? `Downloading ${formatBytes(inst.bytesWrittenAll)} of ${formatBytes(inst.totalBytesAll)} (${pct}%)`
      : `Downloading ${formatBytes(inst.bytesWrittenAll)}…`;
  } else if (inst.phase === 'verifying') {
    phaseLabel = `Checking download${inst.file ? ` (${inst.file})` : '…'}`;
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
          <button type="button" className="home-link" onClick={onRetry}>
            Retry
          </button>
        ) : (
          /* Cancel always available: installs are server-owned background
             jobs, so this view can cancel remote-origin rows too. */
          <button type="button" className="home-link" onClick={onCancel}>
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
  if (err instanceof Error) return err.message;
  return String(err);
}
