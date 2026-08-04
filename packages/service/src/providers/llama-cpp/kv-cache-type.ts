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

/**
 * Trade Gemma's conservative f16 KV for a second engine slot when memory
 * is the only thing forcing single-slot.
 *
 * Why: multi-gezel work alternates 2+ sessions, and on a single-slot
 * server a Gemma-family model re-prefills the other session's WHOLE
 * context on every switch — SWA models are excluded from llama-server's
 * native prompt cache, so nothing rescues them (wild-caught: one ~41K
 * re-prefill ≈ 79s per schema-migration trial). A second slot removes the
 * class entirely. The 2026-08-03 KV A/B (f16 8/8, q8_0 6/8, q4_0 7/8 —
 * no dose-response, no garbling, failures on the known coin-flip
 * scenario) showed no measurable q8_0 fidelity cost, so paying half the
 * KV memory for a slot is the better default whenever it actually buys
 * one.
 *
 * Explicit operator choices always win: a `kvCacheType` override or an
 * explicit slot-count config means no auto-trade.
 */
export function planLlamaCppKv(args: {
  architecture?: string;
  modelId?: string;
  override?: LlamaCppKvCacheType;
  slotsConfigured: boolean;
  /** Memory-ceiling slots under a given KV type (caller's budget math). */
  ceilingFor: (kv: LlamaCppKvCacheType) => number;
  /** Upper bound on slots regardless of memory (policy default). */
  maxSlots: number;
}): { kvCacheType: LlamaCppKvCacheType; upgraded: boolean } {
  const base = resolveLlamaCppKvCacheType(args);
  if (args.override || args.slotsConfigured) return { kvCacheType: base, upgraded: false };
  if (base !== 'f16' || args.maxSlots < 2) return { kvCacheType: base, upgraded: false };
  const f16Slots = Math.min(args.maxSlots, args.ceilingFor('f16'));
  if (f16Slots >= 2) return { kvCacheType: base, upgraded: false };
  const q8Slots = Math.min(args.maxSlots, args.ceilingFor('q8_0'));
  if (q8Slots >= 2) return { kvCacheType: 'q8_0', upgraded: true };
  return { kvCacheType: base, upgraded: false };
}
