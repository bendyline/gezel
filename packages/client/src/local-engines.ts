/**
 * Wire shapes for the on-device engines and the local models they run: the
 * broker's memory status and pool controls, install and download listings,
 * ds4 launch plans, and model-fitness records. Re-exported from `client.ts`.
 */
export interface EngineStatusEntry {
  key: string;
  provider: 'llama-cpp' | 'mlx' | 'ds4';
  modelId: string;
  replicaIdx: number;
  residentBytes: number;
  lastUsedAt: number;
  createdAt: number;
}

export interface EngineStatusResponse {
  /** True when the broker is enforcing a budget; false for cloud-only installs. */
  enforced: boolean;
  budgetBytes: number;
  committedBytes: number;
  entries: EngineStatusEntry[];
  /** Physical RAM — the memory slider's ceiling. Absent pre-boot. */
  systemRamBytes?: number;
  /** Host-derived budget; the slider's "Auto" mark. Absent pre-boot. */
  autoBudgetBytes?: number;
  /** True when `localEngineMemoryGb` overrides the auto value. */
  overridden?: boolean;
  /**
   * Which memory pools the budget draws on. A discrete-GPU host's budget is
   * graphics memory PLUS a system-RAM share, so describing it as a slice of
   * RAM (the only shape this response used to carry) names the wrong pool.
   * Absent pre-boot and on daemons that predate the field.
   */
  pools?: {
    kind: 'unified' | 'discrete-gpu' | 'system-ram';
    /** Usable VRAM on a discrete card; 0 on unified / CPU-only hosts. */
    vramBytes: number;
    /** The system-RAM share of the budget. */
    ramShareBytes: number;
    /** Fast (on-accelerator) memory — VRAM on a card, the budget otherwise. */
    fastBytes: number;
    /**
     * What concurrent KV slots are sized against. Below `fastBytes` on a big
     * unified host, where admission capacity was raised without raising peak
     * concurrency. Absent on daemons that predate the field.
     */
    concurrencySizingBytes?: number;
  };
  /**
   * Whether models sharing a discrete card may spill into system RAM. Governs
   * co-residency only — one model alone always gets the full budget. Absent
   * pre-boot and on daemons that predate the field.
   */
  ramSpillover?: {
    allowed: boolean;
    /** What the host picks on its own; the toggle's "Automatic" position. */
    auto: boolean;
    overridden: boolean;
    /** Ceiling the resident set fits under while more than one model is loaded. */
    coResidencyBytes: number;
  };
}

export interface ReconcileEnginePoolRequest {
  provider: 'llama-cpp' | 'mlx' | 'ds4';
  /** Clone count per modelId. Missing modelIds are left alone. */
  clones: Record<string, number>;
}

export interface UnloadIdleEngineRequest {
  provider: 'llama-cpp' | 'mlx' | 'ds4';
  modelId: string;
  replicaIdx: number;
}

/**
 * Snapshot of an in-flight install reported by
 * `GET /api/llama-cpp/active-installs`. The Settings catalog UI
 * polls this endpoint so background-driven installs (the first-run
 * bootstrap) light up the same progress UI a click-driven install
 * would have shown via SSE — without it, the bootstrap install runs
 * to completion server-side while the catalog reads "no model
 * installed" the entire time.
 */
export interface LocalActiveInstall {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  startedAt: string;
}

/**
 * An incomplete on-disk download — bytes present but no install manifest, so
 * it's invisible to the installed-model listings. Returned by the per-engine
 * `listIncomplete*` methods so the Settings UI can surface resume/delete
 * before the daemon's 7-day reclaim sweep removes it. Shape mirrors the
 * service's `IncompleteModelDownloadInfo`.
 */
export interface IncompleteModelDownload {
  id: string;
  /** Total bytes on disk (payload + `.partial`). */
  bytes: number;
  /** ISO timestamp of the newest write in the directory. */
  updatedAt: string;
  /** Whether a `.partial` file is present. */
  hasPartial: boolean;
  /** True when re-installing this id would resume from the on-disk bytes. */
  resumable: boolean;
  /** Catalog display name, when the id still resolves. */
  name?: string;
}

/**
 * A model directory with a manifest that the current daemon cannot safely
 * load. The files stay visible in Settings so an older install can be updated
 * from today's catalog or explicitly removed instead of masquerading as an
 * empty model slot.
 */
export interface UnrecognizedLocalModel {
  id: string;
  /** Catalog or legacy-manifest display name, when one can be recovered. */
  name?: string;
  /** Total bytes held by the model directory. */
  bytes: number;
  /** ISO timestamp of the newest file in the directory. */
  updatedAt: string;
  /** User-facing explanation of why the current daemon cannot load it. */
  reason: string;
  /** True when the same id still has a compatible source in today's catalog. */
  canUpdate: boolean;
  /** Machine/shared overlays cannot be removed by this user daemon. */
  readOnly?: boolean;
}

/**
 * What a ds4 catalog entry would launch as on THIS device — resolvable before
 * the model is downloaded, because ds4's plan reads the catalog block and the
 * RAM tier rather than the GGUF header. Returned by
 * `GezelClient.listDs4ContextPlans`.
 */
export interface Ds4ContextPlan {
  /** Per-turn window the launch would request. */
  effectiveContextWindow?: number;
  /** What automatic sizing grants; present only while an override is active. */
  autoContextWindow?: number;
  /** Applied per-model context override (tokens), when one is set. */
  overrideContextTokens?: number;
  /** The context slider's max — min(native window, catalog `maxLaunchCtx`). */
  contextCeilingTokens?: number;
  /** Window the model itself advertises, before this device's tier caps it. */
  nativeContextWindow?: number;
  /**
   * Resident working set at {@link effectiveContextWindow}: expert cache +
   * resident weights + KV at that window. Falls back to the authored flat
   * footprint for entries with no measured slope.
   */
  projectedResidentBytes?: number;
  /**
   * Resident bytes per context token. Present only where the catalog authors a
   * measured slope — the two together are what let a row re-price as the
   * window moves (`contextFreeResidentBytes + kvBytesPerToken × ctx`).
   */
  kvBytesPerToken?: number;
  /** Footprint at a zero-token window: everything the context doesn't move. */
  contextFreeResidentBytes?: number;
  /**
   * Whether this device would hold the model fully in memory rather than
   * streaming its routed experts from SSD. Streaming costs roughly an order of
   * magnitude (measured 1.85 vs 18.1 tok/s on the same IQ2_XXS build), so this
   * is the single most decision-relevant fact when picking between quants.
   *
   * Computed by the daemon with the launcher's own residency function, not
   * re-derived client-side.
   */
  fullyResident?: boolean;
  /**
   * True when {@link projectedResidentBytes} comes from the catalog's measured
   * footprint for the launch mode (`fullResidencyMemory` / `streamingMemory`),
   * so it is the working set itself rather than a conservative reservation.
   */
  memoryMeasured?: boolean;
  /**
   * Streamed launches with a measured footprint: the expert cache the launcher
   * would choose on this device. `safe: false` means even the entry's minimum
   * cache does not fit beside its fixed footprint in this device's budget.
   */
  expertCache?: {
    cacheBytes: number;
    requestedBytes: number;
    clamped: boolean;
    safe: boolean;
  };
}

/**
 * One persisted model-fitness record (the proeve result), resolved
 * with read-time freshness flags. Returned by
 * `GezelClient.listModelFitness`. Shape mirrors
 * `ModelFitnessRecordSchema` in @bendyline/gezel.
 */
export interface ModelFitnessEntry {
  /** `"<provider>:<modelId>"` map key. */
  key: string;
  record: {
    schemaVersion: 1;
    provider: string;
    modelId: string;
    status: 'probed' | 'failed' | 'deferred' | 'blocked';
    admitted: boolean;
    genTokensPerSec: number | null;
    shortPromptGenTokensPerSec?: number | null;
    representativeContext?: {
      targetPromptTokens: number;
      promptTokens: number | null;
      cachedPromptTokens: number | null;
      completionTokens: number | null;
      durationMs: number | null;
      ttftMs: number | null;
      promptTokensPerSec: number | null;
      genTokensPerSec: number | null;
    };
    createdAt: string;
    durationMs: number;
    trigger: 'install' | 'manual';
    sha256?: string;
    catalogVersion?: string;
    contextWindow?: number;
    host: { totalRamBytes: number; gpuVramBytes: number | null; source: string };
    checks: Record<
      'spawn' | 'toolRoundTrip' | 'throughput' | 'reasoningBudget' | 'contextFit',
      { ok: boolean; detail: string }
    >;
  };
  /** Installed weights/version changed since the probe — treat as unprobed. */
  stale: boolean;
  /** Host memory changed materially since the probe — soften, don't invalidate. */
  hardwareChanged: boolean;
}
