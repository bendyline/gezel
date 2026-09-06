/**
 * One installed llama.cpp model on disk. Returned by
 * `GezelClient.listLlamaCppModels`.
 */
export interface LlamaCppInstalledModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  /**
   * On-disk size of the multimodal projector, when this model has one.
   * Deliberately NOT folded into `approxSizeBytes`, which stays the weights
   * (and so the download size the UI shows); memory estimates add it
   * explicitly via `estimateLlamaCppResidentBytes`'s `mmprojBytes`.
   */
  mmprojSizeBytes?: number;
  /** On-disk size of ds4's model-matched `--vision` encoder, when installed. */
  visionEncoderSizeBytes?: number;
  /**
   * Whether this model will be launched with `--mmproj` — i.e. images go
   * straight to it rather than through the image reader. Present only when a
   * projector is installed. Server-resolved: the "absent config means on"
   * rule lives in the daemon, not in each client.
   */
  nativeVisionEnabled?: boolean;
  installedAt: string;
  weightsPath: string;
  /** Context capacity advertised by the GGUF metadata. */
  contextWindow?: number;
  /** Per-turn cap Gezel would actually grant after tuning, settings, and live memory admission. */
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
   * Present when the selected context policy cannot be admitted right now.
   * `insufficient-memory` — even one slot cannot hold the required window;
   * free memory, unload a model, or pick Adaptive. `restart-required` — the
   * model is already RUNNING with a smaller window than the current policy
   * requires; restarting the local engine re-admits it (no memory change
   * needed).
   */
  contextSizingStatus?: 'insufficient-memory' | 'restart-required';
  /** Applied per-model context override (tokens), when one is set. */
  overrideContextTokens?: number;
  /**
   * What automatic sizing would grant right now. Present only while an
   * override is active — without one, `effectiveContextWindow` IS the
   * automatic value. Feeds the context slider's "Auto" marker.
   */
  autoContextWindow?: number;
  /**
   * Post-quant single-slot KV linearization so the UI can price
   * "~X GB in memory" live while the context slider drags:
   * `weightsResidentBytes + kvFixedBytesPerSlot + kvBytesPerTokenPerSlot × ctx`.
   * ds4 rows carry it from their catalog-authored slope; absent on older
   * daemons and on entries nobody has measured a slope for.
   */
  kvBytesPerTokenPerSlot?: number;
  kvFixedBytesPerSlot?: number;
  weightsResidentBytes?: number;
  /**
   * ds4 rows only: the context slider's max — min(native window, catalog
   * maxLaunchCtx). ds4 has no ctx-vs-memory admission, so the authored
   * launch ceiling is the only guard against an unserveable window.
   */
  contextCeilingTokens?: number;
  quantization?: string;
  /**
   * What the model file declares about itself (`general.file_type`), sent
   * only when the catalog's `quantization` names no bit depth. The model
   * table renders this instead, so a hand-authored catalog label like
   * `K-Quant-17GB` never lands in a column of `~4` / `~8`.
   */
  ggufQuantization?: string;
  chatTemplatePresent: boolean;
  architecture?: string;
  /**
   * True when the catalog now describes different model FILES than the ones
   * on disk. The model manager surfaces an "Update" action (fetch what
   * differs, replace in place) when set. A catalog version bump that only
   * edits metadata does not set it — the runtime already resolves that live,
   * so there is nothing to download.
   */
  updateAvailable?: boolean;
  /** The catalog's current version, when it differs from the installed one. */
  availableVersion?: string;
  /** What changed, in one sentence, for the update tooltip. */
  updateReason?: string;
  /**
   * True when the model lives in a read-only overlay (the machine/shared asset
   * store), not this daemon's writable root. The delete endpoint refuses these,
   * so the UI shows them as machine-provided instead of offering Delete.
   */
  readOnly?: boolean;
}
