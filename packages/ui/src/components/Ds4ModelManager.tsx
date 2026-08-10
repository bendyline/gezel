import type { CatalogItemSummary, ChatModelManifest } from '@bendyline/gezel';
import type {
  IncompleteModelDownload,
  LlamaCppInstallEvent,
  LlamaCppInstalledModel,
} from '@bendyline/gezel-client';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import {
  MODEL_INVENTORY_CHANGED_EVENT,
  announceModelInventoryChanged,
  changedModelInventoryEngine,
} from '../model-inventory.js';
import { IncompleteDownloads } from './IncompleteDownloads.js';
import { ImportModelBundleButton } from './ModelBundleControls.js';
import { ModelActionsMenu, ModelContextSliderPanel } from './ModelContextControls.js';
import { SharedModelMigrationPanel } from './SharedModelMigrationPanel.js';
import { formatContextWindow } from './model-context.js';

/**
 * Install/list/delete the GGUFs ds4 can run, straight from the catalog — so
 * the model picker fetches them without a manual path. ds4 is not a general
 * GGUF runner: the catalog's `ds4` source block is what marks an entry as one
 * of the DeepSeek-V4 / GLM 5.2 builds its engine supports, so this list is
 * exactly the models carrying that block.
 *
 * ds4 streams MoE experts from SSD, so device guidance uses the catalog's
 * `residentBytes` (expert cache + fixed model state + runtime buffers), not the
 * much larger download size. The service now enforces the same headroom rule
 * at launch; this UI is guidance, not the only protection against memory
 * pressure.
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

function fmtGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
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
  const [mem, setMem] = useState<Mem | null>(null);
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
    } catch {
      /* the row's own error surfaces install failures */
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
        <span className="home-status-pill home-status-warn">Couldn't load models: {error}</span>
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

  const lightestResidentBytes = Math.min(
    ...ds4Models.map(({ m }) => m.ds4.residentBytes ?? Number.POSITIVE_INFINITY),
  );

  return (
    <div>
      <SharedModelMigrationPanel engine="ds4" onModelsChanged={onModelsChanged} />
      <IncompleteDownloads
        items={incomplete.filter((d) => !installing.has(d.id))}
        onResume={(id) => startInstall(id)}
        onDelete={(id) => void remove(id)}
      />
      {ds4Models.map(({ m }) => {
        const resident = m.ds4.residentBytes;
        const cache = m.ds4.cacheExpertsBytes ?? 0;
        // Match the launcher's fixed system/runtime reserve. If the catalog
        // target exceeds the ceiling, the service reduces only the routed-
        // expert cache. The fixed portion must still fit or installation is
        // not offered on this machine.
        const DS4_SYSTEM_HEADROOM = 32 * 1024 ** 3;
        const ds4Ceiling = mem ? Math.max(0, mem.totalRamBytes - DS4_SYSTEM_HEADROOM) : 0;
        const fitsRecommendedCache = mem && resident ? resident <= ds4Ceiling : true;
        const fixedResident = resident ? Math.max(0, resident - cache) : 0;
        const canRunSafely = mem ? fixedResident + 1024 ** 3 <= ds4Ceiling : true;
        const isLightest = resident === lightestResidentBytes;
        const isInstalled = installed.has(m.id);
        const job = installing.get(m.id);
        const pct =
          job && job.totalBytes > 0 ? Math.floor((job.bytesWritten / job.totalBytes) * 100) : 0;
        const fitPill = resident ? (
          fitsRecommendedCache ? (
            <span
              className="home-status-pill home-status-ok"
              title={`Uses SSD streaming with a target memory working set of about ${fmtGb(resident)}.`}
            >
              {isLightest ? 'recommended on this device' : 'fits with SSD streaming'}
            </span>
          ) : canRunSafely ? (
            <span
              className="home-status-pill home-status-warn"
              title={`Gezel will reduce this model's expert cache below its ${fmtGb(
                resident,
              )} target to preserve 32 GB for the system and other apps. It should run, but will read from SSD more often.`}
            >
              reduced cache · slower
            </span>
          ) : (
            <span
              className="home-status-pill home-status-warn"
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
        const installedRow = installedModels.get(m.id);
        return (
          <Fragment key={m.id}>
            <div
              className="new-row"
              style={{ alignItems: 'center', gap: '0.6rem', marginTop: '0.6rem', flexWrap: 'wrap' }}
            >
              <div style={{ flex: 1, minWidth: '14rem' }}>
                <strong>{displayName}</strong>{' '}
                <span className="muted small">
                  {m.parameterSize} · download {fmtGb(m.ds4.approxSizeBytes)}
                </span>
                {resident ? (
                  <div className="muted small">
                    memory target ≈ {fmtGb(resident)} with SSD streaming
                  </div>
                ) : null}
                {installedRow &&
                (installedRow.effectiveContextWindow || installedRow.contextSizingStatus) ? (
                  <div className="muted small">
                    {installedRow.contextSizingStatus === 'restart-required' ? (
                      'context: restart needed to apply the new size'
                    ) : (
                      <>
                        context {formatContextWindow(installedRow.effectiveContextWindow)}
                        {installedRow.overrideContextTokens !== undefined && (
                          <span className="gz-budget-tag gz-budget-tag-custom model-context-custom-tag">
                            custom
                          </span>
                        )}
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              <div
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: '0.5rem',
                  flexShrink: 0,
                }}
              >
                {fitPill}
                {job ? (
                  job.error ? (
                    <>
                      <span className="home-status-pill home-status-warn">{job.error}</span>
                      <button type="button" onClick={() => startInstall(m.id)}>
                        Retry
                      </button>
                    </>
                  ) : (
                    // Fixed-width, right-aligned so the changing percentage /
                    // phase label doesn't reflow the pill to its left. Tabular
                    // figures keep the digits from jittering too.
                    <span
                      className="muted small"
                      style={{
                        display: 'inline-block',
                        minWidth: '9rem',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {job.phase === 'downloading'
                        ? `downloading… ${pct}%`
                        : job.phase === 'verifying'
                          ? 'verifying sha256…'
                          : 'finalizing…'}
                    </span>
                  )
                ) : isInstalled ? (
                  <>
                    <span className="home-status-pill home-status-ok">on device</span>
                    {readOnlyIds.has(m.id) && (
                      <span
                        className="muted small"
                        title="Provided by the machine-wide install (shared asset store). It can't be removed from here — manage it with the machine installer, or install a user-owned copy to shadow it."
                      >
                        Machine model
                      </span>
                    )}
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
                      onDelete={readOnlyIds.has(m.id) ? undefined : () => void remove(m.id)}
                    />
                  </>
                ) : canRunSafely ? (
                  <button type="button" onClick={() => startInstall(m.id)}>
                    Download
                  </button>
                ) : null}
              </div>
            </div>
            {contextEditorFor === m.id && installedRow && (
              <div className="model-context-editor-row">
                <ModelContextSliderPanel engine="ds4" model={installedRow} onSaved={refresh} />
              </div>
            )}
          </Fragment>
        );
      })}
      <div style={{ marginTop: '1.25rem' }}>
        <ImportModelBundleButton />
        <span className="muted small" style={{ marginLeft: '0.75rem' }}>
          Import from a gezel local model package
        </span>
      </div>
    </div>
  );
}
