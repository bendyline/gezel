/**
 * Pure builder for llama-server's ENGINE launch flags (argv), kept
 * separate from the launcher in `chat/manager.ts` so it can be
 * unit-tested in isolation. It owns only the flags that were NOT
 * already computed by the launcher (`--model`, `--ctx-size`,
 * `--parallel`, `--slot-save-path`, `--cache-type-k/v`, `--jinja`,
 * `--mlock`, `--mmproj`, `--reasoning-budget` stay in the launcher).
 *
 * Three input layers, merged per-field with this precedence (first
 * defined wins):
 *
 *   1. `config`   — user's global `GezelConfig.llamaCpp*` overrides.
 *   2. `perModel` — the catalog manifest's `tuning.engine.llamaCpp`.
 *   3. `planner`  — Phase v2's hardware-aware offload decision.
 *
 * …then `config.llamaCppExtraArgs` is appended LAST so it can override
 * anything above (llama-server honours the last occurrence of a flag).
 *
 * Types are declared structurally here (not imported from
 * `@bendyline/gezel-core`) so the helper and its tests carry no schema
 * dependency; the real `GezelConfig` / `LlamaCppEngineConfig` satisfy
 * these shapes by construction.
 */

import { isGemmaModel } from './kv-cache-type.js';

/** The subset of `GezelConfig` this builder reads (global overrides). */
export interface GlobalLlamaCppFlags {
  llamaCppFlashAttn?: boolean | 'on' | 'off' | 'auto';
  llamaCppNGpuLayers?: number;
  llamaCppCpuMoe?: boolean;
  llamaCppNCpuMoe?: number;
  llamaCppCacheReuse?: number;
  llamaCppSwaFull?: boolean;
  llamaCppThreads?: number;
  llamaCppBatchSize?: number;
  llamaCppUbatchSize?: number;
  llamaCppSpecType?: string;
  llamaCppDraftModelPath?: string;
  llamaCppSpecDraftNMax?: number;
  llamaCppExtraArgs?: Record<string, string | number | boolean>;
}

/** The catalog manifest's per-model `tuning.engine.llamaCpp` block. */
export interface PerModelLlamaCppEngineConfig {
  nGpuLayers?: number;
  cpuMoe?: boolean;
  nCpuMoe?: number;
  cacheReuse?: number;
  swaFull?: boolean;
  flashAttn?: 'on' | 'off' | 'auto';
  ubatchSize?: number;
  contextSize?: number;
  chatTemplate?: string;
  threads?: number;
  batchSize?: number;
  spec?: { type?: string; mtp?: boolean; draftModelId?: string; nMax?: number };
}

/** Phase v2 hardware-aware offload decision (lowest precedence). */
export interface PlannerOffloadDecision {
  nGpuLayers?: number;
  cpuMoe?: boolean;
  nCpuMoe?: number;
  /** Human-readable reason, for the decision log (not emitted as a flag). */
  reason?: string;
}

export interface EngineFlagInput {
  config: GlobalLlamaCppFlags;
  perModel?: PerModelLlamaCppEngineConfig | undefined;
  planner?: PlannerOffloadDecision | undefined;
  /**
   * The resolved KV-cache type the launcher is passing to
   * `--cache-type-k/v`. Used only for the flash-attn coherence rule:
   * a quantized KV cache wants FA on for the fast path, so when FA is
   * otherwise unset we force it on.
   */
  kvCacheType?: string | undefined;
  /**
   * Server slot count (`--parallel`). b9843 rejects `--cache-reuse`
   * under multi-slot non-unified KV, so the auto-on cache-reuse default
   * is applied ONLY when this is exactly 1. An explicit config/manifest
   * `cacheReuse` is passed regardless.
   */
  slots?: number | undefined;
  /**
   * Whether the model's GGUF actually ships MTP (`nextn`) layers, read
   * from its header. A safety cross-check for an explicit `draft-mtp`
   * request: selecting it for a model without MTP layers makes llama-server
   * exit with a fatal load error, so the flag is emitted only when this
   * confirms the capability.
   */
  ggufHasMtp?: boolean | undefined;
  /**
   * Absolute path to a catalog-installed speculative draft sidecar.
   * Separate MTP assistants (Gemma) and other draft algorithms need this;
   * combined MTP GGUFs (Qwen) intentionally leave it unset.
   */
  installedDraftModelPath?: string | undefined;
  /**
   * `--reasoning-format <value>` opt-in (resolved from the
   * `GEZEL_LLAMA_REASONING_FORMAT` env var at the call site). `none`
   * stops llama-server from parsing chat-template tool-call / channel
   * markup server-side, so raw model output reaches `delta.content`
   * where the salvage layer can catch it — the A/B lever for the
   * peg-gemma4 parser dropping mangled `<|tool_call>` turns entirely
   * pre-SSE (cbmx-20260720-195716, ~74 trials). Omitted when unset:
   * default behavior is unchanged.
   */
  reasoningFormat?: string | undefined;
  /**
   * The model's GGUF `general.architecture`, for the Gemma-family auto
   * defaults (sliding-window full cache). Undefined disables the arch
   * heuristic; an explicit config/manifest `swaFull` still applies.
   */
  architecture?: string | undefined;
  /** The resolved model id, a fallback for `architecture` (see isGemmaModel). */
  modelId?: string | undefined;
}

/** Default `--cache-reuse` chunk when neither config nor manifest set it. */
export const DEFAULT_CACHE_REUSE = 256;

/**
 * Normalize the tri-state-or-legacy-boolean flash-attn config into the
 * string llama-server wants, or `undefined` to omit the flag.
 * Back-compat: legacy `true` → force `on`; legacy `false` → omit (its
 * historical meaning was "don't pass the flag", i.e. server default),
 * NOT force-off. Force-off is reachable only via the explicit `'off'`.
 */
function normalizeFlashAttn(
  v: boolean | 'on' | 'off' | 'auto' | undefined,
): 'on' | 'off' | 'auto' | undefined {
  if (v === true) return 'on';
  if (v === false || v === undefined) return undefined;
  return v;
}

/** Strip any leading dashes and re-prefix with `--`. */
function normalizeFlagKey(key: string): string {
  return `--${key.replace(/^-+/, '')}`;
}

/**
 * Build the engine-flag argv fragment. Deterministic ordering: the
 * first-class flags in a fixed sequence, then `extraArgs` in insertion
 * order. Returns a flat `string[]` ready to splice into the launcher's
 * `args` array.
 */
export function buildLlamaCppEngineArgs(input: EngineFlagInput): string[] {
  const {
    config,
    perModel,
    planner,
    kvCacheType,
    slots,
    ggufHasMtp,
    installedDraftModelPath,
    reasoningFormat,
    architecture,
    modelId,
  } = input;
  const args: string[] = [];

  // ── GPU-layer offload (`--n-gpu-layers`) ──────────────────────────
  const nGpuLayers = config.llamaCppNGpuLayers ?? perModel?.nGpuLayers ?? planner?.nGpuLayers;
  if (typeof nGpuLayers === 'number') {
    args.push('--n-gpu-layers', nGpuLayers === -1 ? 'all' : String(nGpuLayers));
  }

  // ── MoE expert offload (`--cpu-moe` / `--n-cpu-moe`) ──────────────
  // Tri-state: an explicit `true`/`false` in config or manifest wins;
  // `undefined` at both layers falls through to the planner's auto
  // decision. An explicit `false` is "force experts onto the GPU" — it
  // must also suppress the planner's partial `--n-cpu-moe`, not just the
  // all-experts `--cpu-moe`, or "Off" would silently still offload.
  const explicitCpuMoe = config.llamaCppCpuMoe ?? perModel?.cpuMoe;
  const cpuMoe = explicitCpuMoe ?? planner?.cpuMoe;
  // An explicit partial split (config/manifest) is a specific opinion that
  // always applies. Only the planner's suggested partial split is
  // suppressed when experts are explicitly forced off.
  const explicitNCpuMoe = config.llamaCppNCpuMoe ?? perModel?.nCpuMoe;
  const nCpuMoe = explicitNCpuMoe ?? (explicitCpuMoe === false ? undefined : planner?.nCpuMoe);
  if (cpuMoe) {
    // All experts on CPU — the granular `--n-cpu-moe` would be redundant.
    args.push('--cpu-moe');
  } else if (typeof nCpuMoe === 'number') {
    args.push('--n-cpu-moe', String(nCpuMoe));
  }

  // ── Flash attention (`--flash-attn on|off|auto`) ──────────────────
  let flashAttn = normalizeFlashAttn(config.llamaCppFlashAttn) ?? perModel?.flashAttn;
  // Coherence: quantized KV cache wants FA on for the fast path. Only
  // applied when neither config nor manifest expressed an opinion.
  if (flashAttn === undefined && kvCacheType && kvCacheType !== 'f16') {
    flashAttn = 'on';
  }
  if (flashAttn !== undefined) args.push('--flash-attn', flashAttn);

  // ── Cross-request prefix KV reuse (`--cache-reuse`) ───────────────
  // Auto-on ONLY for single-slot engines: b9843 rejects `--cache-reuse`
  // under multi-slot non-unified KV (`kv_unified=false`) and disables it
  // with a warning. gezel's default is multi-slot, so emitting the
  // default there just adds a misleading "not supported" log line for no
  // benefit. An explicit config/manifest value is always passed — the
  // operator's call, even if the engine then declines it.
  const explicitCacheReuse = config.llamaCppCacheReuse ?? perModel?.cacheReuse;
  const cacheReuse = explicitCacheReuse ?? (slots === 1 ? DEFAULT_CACHE_REUSE : 0);
  if (cacheReuse > 0) args.push('--cache-reuse', String(cacheReuse));

  // ── SWA full cache (`--swa-full`) ─────────────────────────────────
  // Tri-state: explicit config/manifest `true`/`false` wins; `undefined`
  // at both layers falls through to the Gemma-family auto-default. Gemma's
  // sliding-window attention refuses cross-request prefix reuse under the
  // memory-efficient windowed cache; the full cache trades ~30% KV memory
  // (which the offload planner already budgets for) to enable it.
  const swaFull =
    config.llamaCppSwaFull ?? perModel?.swaFull ?? isGemmaModel({ architecture, modelId });
  if (swaFull) args.push('--swa-full');

  // ── Thread / batch overrides ──────────────────────────────────────
  const threads = config.llamaCppThreads ?? perModel?.threads;
  if (typeof threads === 'number') args.push('--threads', String(threads));
  const batchSize = config.llamaCppBatchSize ?? perModel?.batchSize;
  if (typeof batchSize === 'number') args.push('--batch-size', String(batchSize));
  const ubatchSize = config.llamaCppUbatchSize ?? perModel?.ubatchSize;
  if (typeof ubatchSize === 'number') args.push('--ubatch-size', String(ubatchSize));
  if (perModel?.chatTemplate) args.push('--chat-template', perModel.chatTemplate);

  // ── Speculative decoding (`--spec-type` + draft knobs) ────────────
  // `spec.mtp` is capability metadata only. MTP stays explicit opt-in
  // through config or a manifest `spec.type` until a model/backend pair has
  // cleared deterministic-output and agent-path A/B gates. Even an explicit
  // draft-mtp request is safety-gated by the installed GGUF metadata:
  // llama-server exits fatally when the selected model has no MTP tensors.
  const specType = config.llamaCppSpecType ?? perModel?.spec?.type;
  const safeSpecType = specType === 'draft-mtp' && !ggufHasMtp ? undefined : specType;
  if (safeSpecType && safeSpecType !== 'none') {
    args.push('--spec-type', safeSpecType);
    if (safeSpecType.startsWith('draft-')) {
      const draftModel =
        config.llamaCppDraftModelPath ?? installedDraftModelPath ?? perModel?.spec?.draftModelId;
      if (draftModel) args.push('--spec-draft-model', draftModel);
    }
    const nMax = config.llamaCppSpecDraftNMax ?? perModel?.spec?.nMax;
    if (typeof nMax === 'number') args.push('--spec-draft-n-max', String(nMax));
  }

  // ── Server-side output parsing (`--reasoning-format`) ─────────────
  if (reasoningFormat) args.push('--reasoning-format', reasoningFormat);

  // ── Escape hatch (`llamaCppExtraArgs`) — applied last, wins ────────
  if (config.llamaCppExtraArgs) {
    for (const [rawKey, value] of Object.entries(config.llamaCppExtraArgs)) {
      if (value === false) continue; // false = omit the flag entirely
      const key = normalizeFlagKey(rawKey);
      if (value === true) args.push(key);
      else args.push(key, String(value));
    }
  }

  return args;
}
