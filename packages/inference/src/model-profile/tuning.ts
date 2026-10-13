/**
 * Resolve + apply per-model sampling / reasoning / structured-output knobs.
 *
 * Resolution order (highest wins):
 *   1. Gezel frontmatter `tuning` — sparse, deep-merged on top of (2).
 *   2. Catalog manifest `tuning` — recommended defaults from the gilde.
 *   3. Provider built-in default — left untouched in this module; caller
 *      is responsible for whatever the engine emits when a field is absent.
 *
 * Dual-mode sampling (Qwen3+, Nemotron Nano): `samplingWhenThinking` is a
 * sparse override of `sampling`, merged shallow when reasoning is engaged.
 * The runtime determines "is this a thinking turn" via
 * {@link isReasoningEngaged}.
 *
 * The {@link applyTuning} helper writes a `ResolvedTuning` into a request
 * body using a per-provider {@link TuningMap}. Fields a provider doesn't
 * support are silently dropped — the map's `null` entry signals "drop".
 */

// Resolution and the request writer live in core so the portable runtime
// shares them; re-exported so service callers keep their import path.
export {
  ANTHROPIC_TUNING_MAP,
  applyTuning,
  COPILOT_TUNING_MAP,
  isReasoningEngaged,
  LLAMA_CPP_TUNING_MAP,
  MLX_TUNING_MAP,
  OLLAMA_BODY_TUNING_MAP,
  OLLAMA_OPTIONS_TUNING_MAP,
  OLLAMA_TUNING_MAP,
  OPENAI_TUNING_MAP,
  type ResolvedTuning,
  type ResolveTuningInput,
  resolveTuning,
  type TuningMap,
  type TuningMapEntry,
  tuningMapFor,
  type TuningPath,
} from '@bendyline/gezel';
