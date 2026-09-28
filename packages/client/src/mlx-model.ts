/**
 * Events emitted by the `/api/mlx/models/:id/install` SSE stream. MLX
 * models are multi-file repos (config.json + weight shards) so the
 * `progress` event carries `fileIndex` / `fileCount` / `file` for
 * per-file progress inside the overall install.
 */
export type MlxInstallEvent =
  | {
      type: 'progress';
      fileIndex: number;
      fileCount: number;
      file: string;
      bytesWritten: number;
      totalBytes: number;
      /** Cumulative bytes downloaded across every file so far. */
      bytesWrittenAll: number;
      /** Sum of file sizes pinned in the manifest. */
      totalBytesAll: number;
    }
  /**
   * Retrying after a transient network error. UI shows
   * "Connection dropped on shard 2/5 — retrying in 4s (attempt 3/5)…"
   * — the `file` field is the MLX shard currently being attempted.
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      file: string;
    }
  | { type: 'verifying'; file: string }
  | { type: 'extracting-metadata' }
  | { type: 'done'; id: string; warning?: string }
  /**
   * Terminal failure. When `mismatch` is present, the failure is a
   * sha256 mismatch against the catalog — the UI can offer "Download
   * anyway" which retries with `{skipSha: true}`.
   */
  | {
      type: 'error';
      error: string;
      mismatch?: { file: string; expected: string; actual: string };
    };

/** One installed MLX model directory on disk. */
export interface MlxInstalledModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path of the model directory; `mlx_lm.server --model` takes this. */
  modelDir: string;
  /** Context capacity advertised by the model metadata. */
  contextWindow?: number;
  /** Per-turn cap Gezel would actually grant after applying its configured limit. */
  effectiveContextWindow?: number;
  /**
   * Expected memory to serve ONE chat: resident weights (with runtime
   * overhead) plus a single slot's KV cache at the granted context
   * window. This is the figure that tracks measured peak RSS. Absent when
   * the daemon could not price the launch (unreadable weights, older
   * daemon).
   */
  predictedResidentBytes?: number;
  /**
   * What the capacity broker actually holds: weights plus {@link plannedSlots}
   * slots' KV. Equals `predictedResidentBytes` on a single-slot host.
   */
  reservedResidentBytes?: number;
  /** Concurrent engine slots the launch would be admitted at. */
  plannedSlots?: number;
  /**
   * Present when the selected context policy cannot be admitted right now —
   * same contract as the llama.cpp rows (`insufficient-memory` /
   * `restart-required`).
   */
  contextSizingStatus?: 'insufficient-memory' | 'restart-required';
  /** Applied per-model context override (tokens), when one is set. */
  overrideContextTokens?: number;
  /** What automatic sizing would grant; present only while an override is active. */
  autoContextWindow?: number;
  /** Post-quant single-slot KV linearization for the context slider's live estimate. */
  kvBytesPerTokenPerSlot?: number;
  kvFixedBytesPerSlot?: number;
  weightsResidentBytes?: number;
  quantization?: string;
  chatTemplatePresent: boolean;
  architecture?: string;
  /** Catalog manifest `version` as of install. */
  catalogVersion?: string;
  /**
   * True when the model lives in a read-only overlay (the machine/shared asset
   * store), not this daemon's writable root. Delete refuses these, so the UI
   * shows them as machine-provided instead of offering Delete.
   */
  readOnly?: boolean;
  /**
   * True when the catalog now describes different model FILES than the ones
   * on disk — the daemon compares the payload, not the version string, so a
   * metadata-only catalog edit never asks for a re-download.
   */
  updateAvailable?: boolean;
  /** The catalog's current version, when it differs from the installed one. */
  availableVersion?: string;
  /** What changed, in one sentence, for the update tooltip. */
  updateReason?: string;
}

/** Snapshot of the Python runtime powering MLX venvs. */
export interface MlxRuntimeInfo {
  source: 'system-uv' | 'system-python' | 'bundled-uv' | null;
  installerPath?: string;
  uvVersion?: string;
  pythonVersion?: string;
  bundledUvAvailable: boolean;
  /** Populated when `source === null` — explains why no runtime was found. */
  reason?: string;
}
