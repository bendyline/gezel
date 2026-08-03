/**
 * KV-cache precision selection for llama-server (`--cache-type-k/v`).
 *
 * Split out from the supervisor launch builder so the family-aware
 * default is unit-testable in isolation.
 */

export type LlamaCppKvCacheType = 'f16' | 'q8_0' | 'q4_0';

/**
 * Is this model in the Gemma 3/4 family? The single source of truth for
 * the Gemma-specific engine defaults (f16 KV cache, sliding-window
 * full-cache). Prefers the GGUF architecture string; falls back to the
 * model id for installs whose header didn't record an architecture.
 */
export function isGemmaModel(args: { architecture?: string; modelId?: string }): boolean {
  const arch = (args.architecture ?? '').toLowerCase();
  return arch.startsWith('gemma') || /gemma/i.test(args.modelId ?? '');
}

/**
 * Pick the `--cache-type-k/v` value for a model.
 *
 * Gemma 3/4 are unusually sensitive to a quantized KV cache: large
 * attention head dims (key/value_length = 512), a final logit softcap,
 * and sliding-window attention mean an 8-bit KV cache corrupts the
 * *stored prompt tokens* — the model reasons fine but recalls cached
 * source/text as garbled multilingual tokens. Wild-caught
 * (gemma4-12b): quoted source lines came back as Korean glyphs + emoji
 * with `K/V = q8_0`. So the Gemma family defaults to f16; every other
 * family keeps the well-trodden q8_0 (~50% KV memory, ~zero quality
 * impact). An explicit operator override always wins.
 *
 * The `modelId` fallback covers installs whose GGUF metadata didn't
 * record an architecture string — a `gemma`-named model still gets f16.
 */
export function resolveLlamaCppKvCacheType(args: {
  architecture?: string;
  modelId?: string;
  override?: LlamaCppKvCacheType;
}): LlamaCppKvCacheType {
  if (args.override) return args.override;
  return isGemmaModel(args) ? 'f16' : 'q8_0';
}
