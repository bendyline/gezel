import type { CatalogItemSummary, ChatModelManifest } from '@bendyline/gezel';
import {
  DS4_FULL_RESIDENCY_HEADROOM_BYTES,
  RETIRED_MODEL_TOOLTIP,
  isRetiredModel,
} from '@bendyline/gezel';
import type {
  Ds4ContextPlan,
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
import { ConfirmDialog } from './ConfirmDialog.js';
import { IncompleteDownloads } from './IncompleteDownloads.js';
import { ImportModelBundleButton } from './ModelBundleControls.js';
import {
  ModelActionsMenu,
  ModelContextSliderPanel,
  contextSliderMax,
} from './ModelContextControls.js';
import { ModelFitnessCell, fitnessMenuAction } from './ModelFitnessCell.js';
import { SharedModelMigrationPanel } from './SharedModelMigrationPanel.js';
import { UnrecognizedModels } from './UnrecognizedModels.js';
import { formatContextWindow } from './model-context.js';
import { ds4MemoryHeadline, ds4SizeTitle, formatBytes } from './model-memory-copy.js';

/**
 * Install/list/delete the GGUFs ds4 can run, straight from the catalog — so
 * the model picker fetches them without a manual path. ds4 is not a general
 * GGUF runner: the catalog's `ds4` source block is what marks an entry as one
 * of the DeepSeek-V4 / GLM 5.2 builds its engine supports, so this list is
 * exactly the models carrying that block.
 *
 * ds4 streams MoE experts from SSD, so device guidance uses the working set
 * (expert cache + fixed model state + KV at the launch window), not the much
 * larger download size. The service now enforces the same headroom rule at
 * launch; this UI is guidance, not the only protection against memory
 * pressure.
 *
 * Every row — downloaded or not — carries the window this device would launch
 * it at and what that window costs, because a ds4 download runs to hundreds of
 * GB and the fit decision happens before it starts. Those come from
 * `/api/ds4/context-plans`, which prices catalog entries the same way
 * `/api/ds4/models` prices installed ones.
 */
interface Mem {
  totalRamBytes: number;
  usableBytes: number;
}
interface InstallState {
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'finalizing';
  error?: string;
  // 'local' = started by THIS component via SSE (authoritative, finer
  // progress); 'remote' = discovered by polling /active-installs (an install
  // that's in flight from a prior mount / another tab). Lets the poller refresh
  // remote rows without clobbering a live local one.
  origin: 'local' | 'remote';
}

type Ds4ChatModel = ChatModelManifest & { ds4: NonNullable<ChatModelManifest['ds4']> };

function ds4Entry(m: CatalogItemSummary['manifest']): Ds4ChatModel | null {
  if (m.kind !== 'chat-model' || !m.ds4) return null;
  return m as Ds4ChatModel;
}

export function Ds4ModelManager({ onModelsChanged }: { onModelsChanged?: () => void }) {
  // `null` = the catalog hasn't loaded yet (or a load failed). We must NOT
  // conflate that with a genuinely-empty catalog — otherwise a slow/failed
  // fetch (e.g. while a large model download saturates the daemon's I/O)
  // renders as "No DwarfStar models in the catalog", which reads as the
  // user's models silently vanishing. Only the `[]`-after-success state is a
  // real empty catalog.
  const [items, setItems] = useState<CatalogItemSummary[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  // Full installed rows (context window, override, launch ceiling) keyed by
  // id — the catalog drives the list, but the context controls need the
  // daemon's per-install decoration.
  const [installedModels, setInstalledModels] = useState<Map<string, LlamaCppInstalledModel>>(
    new Map(),
  );
  // Ids that resolve from a read-only machine/shared overlay — delete refuses
  // these, so the row shows them as machine-provided rather than offering a
  // Delete that only 400s.
  const [readOnlyIds, setReadOnlyIds] = useState<Set<string>>(new Set());
  // Launch plan per catalog id, downloaded or not — the window this device
  // would run each model at and the memory that window costs. Empty on a
  // daemon that predates the endpoint; rows then fall back to the catalog's
  // flat footprint and show no window.
  const [plans, setPlans] = useState<Map<string, Ds4ContextPlan>>(new Map());
  const [mem, setMem] = useState<Mem | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Which installed row has the context-size editor expanded beneath it.
  const [contextEditorFor, setContextEditorFor] = useState<string | null>(null);
  // False until the override endpoint answers — an older daemon or machine
  // broker 404s and the affordance hides rather than erroring per row.
  const [contextOverridesSupported, setContextOverridesSupported] = useState(false);
  const [installing, setInstalling] = useState<Map<string, InstallState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Interrupted/unverified downloads with no manifest — invisible to the
  // installed set. ds4 models run to hundreds of GB, so a stalled one is a lot
  // of hidden disk. Surfaced for resume/delete before the reclaim sweep.
  const [incomplete, setIncomplete] = useState<IncompleteModelDownload[]>([]);
  const [unrecognized, setUnrecognized] = useState<UnrecognizedLocalModel[]>([]);
  const [toRemove, setToRemove] = useState<string | null>(null);
  // Proeve results per installed model, keyed `ds4:<id>`. These are the models
  // where "it loads" and "you can work with it" are furthest apart, so the
  // measured numbers carry more weight here than on any other engine page.
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
      const res = await api.listIncompleteDs4Models();
      setIncomplete(res.incomplete ?? []);
    } catch {
      /* advisory surface — a blip just keeps the last state */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listDs4Models();
      setInstalled(new Set(r.models.map((m) => m.id)));
      setInstalledModels(new Map(r.models.map((m) => [m.id, m])));
      setReadOnlyIds(new Set(r.models.filter((m) => m.readOnly).map((m) => m.id)));
      setUnrecognized(r.unrecognized ?? []);
    } catch {
      /* the row's own error surfaces install failures */
    }
    try {
      const r = await api.listDs4ContextPlans();
      setPlans(new Map(Object.entries(r.plans ?? {})));
    } catch {
      // Older daemon (404) or a blip — rows quote the flat catalog footprint
      // rather than the list failing.
    }
    void refreshIncomplete();
  }, [refreshIncomplete]);

  const loadCatalog = useCallback(async () => {
    setError(null);
    try {
      const [cat, m] = await Promise.all([
        api.listCatalogItems('chat-model'),
        api.getMemoryProfile(),
      ]);
      setItems(cat.items);
      setMem({ totalRamBytes: m.totalRamBytes, usableBytes: m.usableBytes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void refresh();
    void api
      .getModelContextOverrides('ds4')
      .then(() => setContextOverridesSupported(true))
      .catch(() => setContextOverridesSupported(false));
  }, [loadCatalog, refresh]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const engine = changedModelInventoryEngine(event);
      if (engine === 'ds4') void refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // Fitness polling owns its own timer, deliberately NOT the active-install
  // tick's — the same separation the llama.cpp manager needed after riding
  // that tick froze its pills on "checking fitness…" for as long as a slow
  // install request took. A ds4 download saturates the daemon for hours, so
  // the coupling would bite harder here. Self-scheduling (not setInterval)
  // so a slow request never stacks up.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await refreshFitness();
      if (cancelled) return;
      // Fast while a proeve is in flight; slow otherwise, which is what lets
      // the install-triggered probe appear without the user doing anything.
      timer = setTimeout(() => void loop(), probingRef.current.length > 0 ? 2_000 : 15_000);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshFitness]);

  // Reconnect to in-flight installs after a remount (you navigated to another
  // tab mid-download and came back): poll the server's active-install tracker
  // so the row shows live progress instead of a fresh "Install" button — which
  // would just error with "already in progress". A local SSE install started by
  // THIS component stays authoritative (it has finer progress timing).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.listDs4ActiveInstalls();
        if (cancelled) return;
        setInstalling((prev) => {
          const next = new Map(prev);
          const seen = new Set<string>();
          for (const r of res.installs) {
            seen.add(r.catalogId);
            const cur = next.get(r.catalogId);
            // A LIVE local SSE install is authoritative — leave it. But if a
            // local row is stuck on an error (e.g. a duplicate-click "already in
            // progress" 409), let the real in-flight install's progress replace
            // it so the row self-heals instead of showing a dead error + Retry.
            if (cur?.origin === 'local' && !cur.error) continue;
            next.set(r.catalogId, {
              bytesWritten: r.bytesWritten,
              totalBytes: r.totalBytes,
              phase: r.phase === 'extracting-metadata' ? 'finalizing' : r.phase,
              origin: 'remote',
            });
          }
          // Drop remote rows the server no longer reports (install done or
          // errored). Local rows are cleared by their own SSE finalizer.
          for (const [id, entry] of next) {
            if (entry.origin === 'remote' && !seen.has(id)) next.delete(id);
          }
          return next;
        });
        // No active installs → a download likely just landed; refresh so the
        // card flips to "installed".
        if (res.installs.length === 0) void refresh();
      } catch {
        /* service blip — retry on the next tick */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refresh]);

  const startInstall = useCallback(
    (id: string) => {
      setInstalling((p) =>
        new Map(p).set(id, {
          bytesWritten: 0,
          totalBytes: 0,
          phase: 'downloading',
          origin: 'local',
        }),
      );
      void (async () => {
        try {
          await api.installDs4Model(id, (ev: LlamaCppInstallEvent) => {
            setInstalling((p) => {
              const next = new Map(p);
              const cur = next.get(id) ?? {
                bytesWritten: 0,
                totalBytes: 0,
                phase: 'downloading' as const,
                origin: 'local' as const,
              };
              if (ev.type === 'progress')
                next.set(id, {
                  ...cur,
                  bytesWritten: ev.bytesWritten,
                  totalBytes: ev.totalBytes,
                  phase: 'downloading',
                });
              else if (ev.type === 'verifying') next.set(id, { ...cur, phase: 'verifying' });
              else if (ev.type === 'extracting-metadata')
                next.set(id, { ...cur, phase: 'finalizing' });
              else if (ev.type === 'error') next.set(id, { ...cur, error: ev.error });
              return next;
            });
          });
          announceModelInventoryChanged('ds4');
        } catch (e) {
          setInstalling((p) => {
            const n = new Map(p);
            const c = n.get(id);
            if (c) n.set(id, { ...c, error: e instanceof Error ? e.message : String(e) });
            return n;
          });
          return;
        } finally {
          // Clear the row on success (keep it on error so the user can Retry —
          // the shared downloader resumes from the .partial).
          setInstalling((p) => {
            const n = new Map(p);
            if (n.get(id)?.error) return n;
            n.delete(id);
            return n;
          });
          await refresh();
          onModelsChanged?.();
        }
      })();
    },
    [refresh, onModelsChanged],
  );

  const remove = useCallback(
    async (id: string) => {
      // Optimistically drop the row (installed + incomplete) so the delete
      // feels instant even when the daemon is busy; refresh restores it and
      // surfaces the error on failure.
      setError(null);
      setInstalled((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      setIncomplete((cur) => cur.filter((d) => d.id !== id));
      setUnrecognized((cur) => cur.filter((model) => model.id !== id));
      try {
        await api.deleteDs4Model(id);
        announceModelInventoryChanged('ds4');
        await refresh();
        onModelsChanged?.();
      } catch (e) {
        setError(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
        void refresh();
      }
    },
    [refresh, onModelsChanged],
  );

  const ds4Models = useMemo(
    () =>
      (items ?? [])
        .map((it) => ({ it, m: ds4Entry(it.manifest) }))
        .filter((x): x is { it: CatalogItemSummary; m: Ds4ChatModel } => x.m !== null),
    [items],
  );

  if (error) {
    return (
      <div className="new-row" style={{ alignItems: 'center', gap: '0.6rem' }}>
        <span className="gz-status-pill gz-status-pill--warn">Couldn't load models: {error}</span>
        <button type="button" onClick={() => void loadCatalog()}>
          Retry
        </button>
      </div>
    );
  }
  if (items === null) {
    return <p className="muted small">Loading models…</p>;
  }
  if (ds4Models.length === 0) {
    return <p className="muted small">No DwarfStar models in the catalog.</p>;
  }

  // A recovery row already owns the update/remove decision for an unreadable
  // install. Hide its ordinary catalog row until an update starts; otherwise
  // the same model appears twice with conflicting Update and Download actions.
  // During the update, the catalog row returns to carry live progress.
  const attentionIds = new Set(unrecognized.map((model) => model.id));
  // Models on disk first, catalog order preserved inside each group — the same
  // reading order the llama.cpp and MLX pages get from separate installed and
  // browse sections. ds4 keeps ONE table instead: a download here runs to
  // hundreds of GB, so the memory and context guidance has to be on the row
  // before the download starts, not only after.
  const visibleDs4Models = ds4Models
    .filter(({ m }) => !attentionIds.has(m.id) || installing.has(m.id))
    .filter(({ m }) => showAll || installed.has(m.id) || !isRetiredModel(m))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rank = Number(installed.has(b.entry.m.id)) - Number(installed.has(a.entry.m.id));
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map(({ entry }) => entry);

  // Rank by what each visible model would actually occupy at its planned window, so
  // "recommended on this device" tracks the same number the rows quote.
  const residentFor = (m: Ds4ChatModel): number | undefined =>
    plans.get(m.id)?.projectedResidentBytes ?? m.ds4.residentBytes;
  const lightestResidentBytes = Math.min(
    ...visibleDs4Models.map(({ m }) => residentFor(m) ?? Number.POSITIVE_INFINITY),
  );

  return (
    <div>
      <SharedModelMigrationPanel engine="ds4" onModelsChanged={onModelsChanged} />
      <UnrecognizedModels
        items={unrecognized.filter((model) => !installing.has(model.id))}
        onUpdate={startInstall}
        onRemove={setToRemove}
      />
      <IncompleteDownloads
        items={incomplete.filter((d) => !installing.has(d.id))}
        onResume={(id) => startInstall(id)}
        onDelete={setToRemove}
      />
      <div className="ollama-section">
        <p className="muted small" style={{ marginTop: 0 }}>
          Retired models are hidden by default.{' '}
          <button
            type="button"
            className="gz-link-button"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? 'Hide retired models' : 'Show all models'}
          </button>
        </p>
        <div className="ollama-model-table-wrap">
          <table className="ollama-model-table ds4-model-table">
            <colgroup>
              <col className="model-name-column" />
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th title="Download size, and the memory working set this device would run the model at. A streaming engine keeps far less resident than it downloads.">
                  Size
                </th>
                <th title="Effective per-turn context size after Gezel's settings and memory limits">
                  Context size
                </th>
                <th title="Reading and writing speed, measured against an approximately 20K-token prompt">
                  Fitness
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleDs4Models.map(({ m }) => {
                const plan = plans.get(m.id);
                // Fit is judged at the window this device would launch with, not at
                // whatever window the catalog footprint was authored against.
                const resident = residentFor(m);
                const cache = m.ds4.cacheExpertsBytes ?? 0;
                // Match the launcher's fixed system/runtime reserve. If the catalog
                // target exceeds the ceiling, the service reduces only the routed-
                // expert cache. The fixed portion must still fit or installation is
                // not offered on this machine.
                const ds4Ceiling = mem
                  ? Math.max(0, mem.totalRamBytes - DS4_FULL_RESIDENCY_HEADROOM_BYTES)
                  : 0;
                const fitsRecommendedCache = mem && resident ? resident <= ds4Ceiling : true;
                const fixedResident = resident ? Math.max(0, resident - cache) : 0;
                const canRunSafely = mem ? fixedResident + 1024 ** 3 <= ds4Ceiling : true;
                const isLightest = resident === lightestResidentBytes;
                const isInstalled = installed.has(m.id);
                const retired = isRetiredModel(m);
                const job = installing.get(m.id);
                const pct =
                  job && job.totalBytes > 0
                    ? Math.floor((job.bytesWritten / job.totalBytes) * 100)
                    : 0;
                // The daemon's own residency verdict for this entry. Kept
                // ahead of the streaming rungs because it is a different
                // ORDER of performance, not a better grade of the same thing:
                // 18.1 tok/s resident against 1.85 streaming on the same
                // IQ2_XXS build. Before this rung existed the streaming path
                // was the best outcome the list could express, and it wore the
                // ok/green pill.
                const runsResident = plan?.fullyResident === true;
                const fitPill = runsResident ? (
                  <span
                    className="gz-status-pill gz-status-pill--ok ds4-model-fit"
                    title={`This device holds the whole model in memory — no expert streaming from SSD. That is roughly ten times faster to generate than the streaming fallback${
                      resident
                        ? `, and costs about ${formatBytes(m.ds4.approxSizeBytes)} of memory while loaded`
                        : ''
                    }.`}
                  >
                    runs fully in memory · fastest
                  </span>
                ) : resident ? (
                  fitsRecommendedCache ? (
                    <span
                      className="gz-status-pill gz-status-pill--info ds4-model-fit"
                      title={`Too large to hold in memory on this device, so DwarfStar keeps about ${formatBytes(
                        resident,
                      )} resident and reads the remaining experts from SSD as it goes. That works, but generates roughly ten times slower than a model that fits in memory. A smaller quant that fits will be much faster.`}
                    >
                      {isLightest
                        ? 'streams from SSD · lightest option'
                        : 'streams from SSD · slower'}
                    </span>
                  ) : canRunSafely ? (
                    <span
                      className="gz-status-pill gz-status-pill--warn ds4-model-fit"
                      title={`Gezel will reduce this model's expert cache below its ${formatBytes(
                        resident,
                      )} target to preserve ${formatBytes(
                        DS4_FULL_RESIDENCY_HEADROOM_BYTES,
                      )} for the system and other apps. It should run, but will read from SSD even more often than a normal streaming launch.`}
                    >
                      reduced cache · much slower
                    </span>
                  ) : (
                    <span
                      className="gz-status-pill gz-status-pill--warn ds4-model-fit"
                      title="The model's fixed memory requirement leaves too little room for the system, even with the expert cache reduced."
                    >
                      needs more memory
                    </span>
                  )
                ) : null;
                // The catalog name already carries the quant ("GLM 5.2 (IQ2_XXS)").
                // A hardcoded model family here silently mislabels every entry that
                // isn't the one it was written for.
                const displayName = m.name;
                // Merge the plan into the installed row so the slider gets the launch
                // ceiling and the KV slope even when /models predates them.
                const baseRow = installedModels.get(m.id);
                const installedRow: LlamaCppInstalledModel | undefined = baseRow
                  ? {
                      ...baseRow,
                      ...(plan?.effectiveContextWindow !== undefined &&
                      !baseRow.effectiveContextWindow
                        ? { effectiveContextWindow: plan.effectiveContextWindow }
                        : {}),
                      ...(plan?.contextCeilingTokens !== undefined &&
                      baseRow.contextCeilingTokens === undefined
                        ? { contextCeilingTokens: plan.contextCeilingTokens }
                        : {}),
                      ...(plan?.kvBytesPerToken !== undefined &&
                      baseRow.kvBytesPerTokenPerSlot === undefined
                        ? { kvBytesPerTokenPerSlot: plan.kvBytesPerToken, kvFixedBytesPerSlot: 0 }
                        : {}),
                      ...(plan?.contextFreeResidentBytes !== undefined &&
                      baseRow.weightsResidentBytes === undefined
                        ? { weightsResidentBytes: plan.contextFreeResidentBytes }
                        : {}),
                    }
                  : undefined;
                // The launch window to quote: the daemon's per-install answer first,
                // else the catalog projection for a model that isn't downloaded.
                const launchCtx =
                  installedRow?.effectiveContextWindow ?? plan?.effectiveContextWindow;
                const overrideTokens =
                  installedRow?.overrideContextTokens ?? plan?.overrideContextTokens;
                const restartNeeded = installedRow?.contextSizingStatus === 'restart-required';
                // Only claim the footprint moves with the window where a measured
                // slope says it does; otherwise the number is a flat authored
                // target and the copy hedges instead of pricing a window.
                const memoryCopy = {
                  approxSizeBytes: m.ds4.approxSizeBytes,
                  residentBytes: resident,
                  ...(plan?.kvBytesPerToken !== undefined &&
                  plan.contextFreeResidentBytes !== undefined &&
                  launchCtx !== undefined
                    ? { contextFreeBytes: plan.contextFreeResidentBytes }
                    : {}),
                  ...(launchCtx !== undefined ? { effectiveContextWindow: launchCtx } : {}),
                  ...(runsResident ? { fullyResident: true } : {}),
                };
                const memoryHeadline = ds4MemoryHeadline(memoryCopy);
                const updateAvailable = installedRow?.updateAvailable === true;
                const fitnessKey = `ds4:${m.id}`;
                return (
                  <Fragment key={m.id}>
                    <tr>
                      <td className="model-name-table-cell">
                        <div className="model-name-cell">
                          <strong className="ds4-model-name">{displayName}</strong>
                          <div className="model-name-meta">
                            <span className="muted small">{m.parameterSize}</span>
                            {isInstalled && (
                              <span className="gz-status-pill gz-status-pill--ok">on device</span>
                            )}
                            {retired && (
                              <span
                                className="catalog-item-tag catalog-item-tag--retired"
                                title={RETIRED_MODEL_TOOLTIP}
                              >
                                retired
                              </span>
                            )}
                            {updateAvailable && (
                              <span
                                className="gz-status-pill gz-status-pill--warn"
                                title={
                                  installedRow?.updateReason ??
                                  (installedRow?.availableVersion
                                    ? `A newer build is available in the catalog (→ v${installedRow.availableVersion}). Updating downloads only the files that differ.`
                                    : 'A newer build is available in the catalog. Updating downloads only the files that differ.')
                                }
                              >
                                update available
                              </span>
                            )}
                          </div>
                          {fitPill}
                        </div>
                      </td>
                      <td>
                        <span className="model-size-cell" title={ds4SizeTitle(memoryCopy)}>
                          {formatBytes(m.ds4.approxSizeBytes)}
                          {memoryHeadline ? (
                            <span className="muted small model-memory-headline">
                              {memoryHeadline}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td
                        title={
                          restartNeeded
                            ? 'This model is running with a different context window than the current sizing settings resolve to. Restart the local engine (or let it go idle) so Gezel can re-admit it — no memory change needed.'
                            : launchCtx !== undefined
                              ? overrideTokens !== undefined
                                ? `You've set this model to ${overrideTokens.toLocaleString()} tokens per turn.`
                                : `Gezel will grant up to ${launchCtx.toLocaleString()} tokens per turn.`
                              : undefined
                        }
                      >
                        {restartNeeded ? (
                          'Restart needed'
                        ) : launchCtx !== undefined ? (
                          <>
                            {formatContextWindow(launchCtx)}
                            {overrideTokens !== undefined && (
                              <span className="gz-budget-tag gz-budget-tag-custom model-context-custom-tag">
                                custom
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      {isInstalled ? (
                        <ModelFitnessCell
                          entry={fitness.get(fitnessKey)}
                          probing={probing.includes(fitnessKey)}
                        />
                      ) : (
                        <td className="model-fitness-table-cell">
                          <span
                            className="muted small"
                            title="The fitness check measures this model on THIS machine, so it runs once the download lands."
                          >
                            after download
                          </span>
                        </td>
                      )}
                      <td className="model-actions-table-cell">
                        {job ? (
                          job.error ? (
                            <div className="ds4-model-progress">
                              <span className="gz-status-pill gz-status-pill--warn">
                                {job.error}
                              </span>
                              <button type="button" onClick={() => startInstall(m.id)}>
                                Retry
                              </button>
                            </div>
                          ) : (
                            // Fixed-width, right-aligned so the changing percentage /
                            // phase label doesn't reflow the cells to its left. Tabular
                            // figures keep the digits from jittering too.
                            <span className="muted small ds4-model-progress-label">
                              {job.phase === 'downloading'
                                ? `downloading… ${pct}%`
                                : job.phase === 'verifying'
                                  ? 'verifying sha256…'
                                  : 'finalizing…'}
                            </span>
                          )
                        ) : isInstalled ? (
                          <div className="model-actions-cell">
                            <div className="model-action-status">
                              {readOnlyIds.has(m.id) && (
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
                                engine="ds4"
                                model={
                                  installedRow ?? {
                                    id: m.id,
                                    approxSizeBytes: m.ds4.approxSizeBytes,
                                    readOnly: readOnlyIds.has(m.id),
                                  }
                                }
                                contextSupported={contextOverridesSupported}
                                contextEditorOpen={contextEditorFor === m.id}
                                onToggleContextEditor={() =>
                                  setContextEditorFor((prev) => (prev === m.id ? null : m.id))
                                }
                                fitnessAction={fitnessMenuAction(
                                  fitness.get(fitnessKey),
                                  probing.includes(fitnessKey),
                                  () => {
                                    void api
                                      .runModelFitnessProbe('ds4', m.id)
                                      .then(() => refreshFitness())
                                      .catch(() => {});
                                  },
                                )}
                                onUpdate={() => startInstall(m.id)}
                                onDelete={
                                  readOnlyIds.has(m.id) ? undefined : () => setToRemove(m.id)
                                }
                              />
                            </div>
                          </div>
                        ) : canRunSafely ? (
                          <button type="button" onClick={() => startInstall(m.id)}>
                            Download
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {contextEditorFor === m.id && installedRow && (
                      <tr className="model-context-editor-row">
                        <td colSpan={5}>
                          <ModelContextSliderPanel
                            engine="ds4"
                            model={installedRow}
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
      </div>
      <div style={{ marginTop: '1.25rem' }}>
        <ImportModelBundleButton />
        <span className="muted small" style={{ marginLeft: '0.75rem' }}>
          Import from a gezel local model package
        </span>
      </div>
      <ConfirmDialog
        open={toRemove !== null}
        title={`Remove ${toRemove ?? 'model'}?`}
        message="This permanently removes the model files from this device. The model stays available in the catalog, so you can download a current build later."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const id = toRemove;
          setToRemove(null);
          if (id) void remove(id);
        }}
        onCancel={() => setToRemove(null)}
      />
    </div>
  );
}
