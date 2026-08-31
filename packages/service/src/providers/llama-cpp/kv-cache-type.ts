/**
 * KV-cache precision selection for llama-server (`--cache-type-k/v`).
 *
 * Split out from the supervisor launch builder so the family-aware
 * default is unit-testable in isolation.
 */

export type LlamaCppKvCacheType = 'f16' | 'q8_0' | 'q4_0';

/**
 * The context we are willing to keep when trading window size for f16 KV
 * (policy 2026-08-28: "favor f16 if memory allows, even at the sacrifice
 * of slots or context above 64k"). Above this, an adaptive context is
 * capped before falling back to a quantized cache; an explicit operator
 * context is never capped.
 */
export const F16_PREFERRED_CTX_CAP_TOKENS = 65_536;

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
 * The family FALLBACK `--cache-type-k/v` value — what a model gets when
 * memory pressure forces the compact cache. This is no longer the whole
 * default: {@link planLlamaCppKv} prefers f16 whenever the memory plan
 * fits it, and only lands here when it does not.
 *
 * Gemma 3/4 are unusually sensitive to a quantized KV cache: large
 * attention head dims (key/value_length = 512), a final logit softcap,
 * and sliding-window attention mean an 8-bit KV cache corrupts the
 * *stored prompt tokens* — the model reasons fine but recalls cached
 * source/text as garbled multilingual tokens. Wild-caught
 * (gemma4-12b): quoted source lines came back as Korean glyphs + emoji
 * with `K/V = q8_0`. So the Gemma family falls back to f16; every other
 * family falls back to q8_0 (~50% KV memory; quality-equivalent per the
 * 2026-08-03 A/B). An explicit operator override always wins.
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
 * Memory-aware KV precision + the sacrifices it is allowed to make.
 *
 * f16 KV is measurably faster than q8_0 on llama.cpp, and the gap grows
 * with context where it hurts most: the 2026-08-28 ABBA
 * (muse-glimmer-30b, reports/llama-kv-q8-longctx-20260828.md) measured a
 * flat ~6% decode tax and a prefill tax growing −6% → −12% → −17% at
 * 8k/40k/90k. The original q8_0 default was priced on a 2B model whose
 * KV was too small for the tax to show. Policy (2026-08-28): **prefer
 * f16 whenever memory allows, sacrificing engine slots first and then
 * context above 64k tokens; fall back to the family default
 * ({@link resolveLlamaCppKvCacheType}) only when f16 cannot fit even a
 * single 64k slot.**
 *
 * Explicit operator choices always win and are never sacrificed: a
 * `kvCacheType` override short-circuits entirely; an explicit slot count
 * is honored (f16 only if it fits that many); an explicit context
 * (env / per-model / machine-wide numeric, or `model-max` sizing) is
 * never capped.
 *
 * GEMMA IS THE DELIBERATE EXCEPTION and keeps its long-standing shape:
 * f16 for correctness (the garbling incident above), traded to q8_0
 * only when that buys a second slot — because single-slot Gemma
 * alternation re-prefills the other session's whole context (SWA models
 * get nothing from llama-server's prompt cache; wild-caught ~41K tok ≈
 * 79s per switch), a far larger cost than q8_0's prefill tax. The
 * general "sacrifice slots for f16" ladder would reinstate exactly that
 * pathology, so it does not apply to Gemma.
 */
export function planLlamaCppKv(args: {
  architecture?: string;
  modelId?: string;
  override?: LlamaCppKvCacheType;
  slotsConfigured: boolean;
  /** The explicit slot count when `slotsConfigured` (honored verbatim). */
  configuredSlots?: number;
  /** Per-turn context the launch is currently asking for. */
  requestedCtxTokens: number;
  /** Admission floor — a cap below this is never proposed. */
  minimumCtxTokens: number;
  /** True when the context came from explicit operator intent. */
  ctxConfigured: boolean;
  /** Memory-ceiling slots for a KV type at a context (caller's budget math). */
  ceilingFor: (kv: LlamaCppKvCacheType, ctxTokens: number) => number;
  /**
   * Does this exact plan clear the admission the launch will really run —
   * weights + KV against the co-residency budget, at the full window?
   *
   * `ceilingFor` cannot answer this and must not be used as if it could. It
   * is a slot COUNT floored at 1 (`localEngineSlotCeiling`), so it reports
   * "1 slot" for a plan that does not fit at all, and it is priced against
   * the FAST pool while admission is priced against the whole budget — for a
   * RAM-spillover model those are different questions by construction.
   * Conflating them made every f16 rung below pass on any single-slot
   * machine, leaving the q8_0 rung unreachable and denying models that fit
   * comfortably at q8_0.
   */
  fitsAt: (kv: LlamaCppKvCacheType, ctxTokens: number, slots: number) => boolean;
  /** Upper bound on slots regardless of memory (policy default). */
  maxSlots: number;
}): {
  kvCacheType: LlamaCppKvCacheType;
  /** Gemma f16→q8_0 slot trade fired (pre-existing meaning, kept). */
  upgraded: boolean;
  /** Set when f16 was bought by capping context; assign to effectiveNumCtx. */
  ctxCapTokens?: number;
  /** One-line rationale for the launch log. */
  reason: string;
} {
  if (args.override) {
    return { kvCacheType: args.override, upgraded: false, reason: 'operator kvCacheType override' };
  }
  const fallback = resolveLlamaCppKvCacheType(args);

  if (isGemmaModel(args)) {
    // Long-standing Gemma shape, verbatim (see the doc block above).
    if (args.slotsConfigured || args.maxSlots < 2) {
      return { kvCacheType: fallback, upgraded: false, reason: 'gemma f16 (correctness default)' };
    }
    const f16Slots = Math.min(args.maxSlots, args.ceilingFor('f16', args.requestedCtxTokens));
    if (f16Slots >= 2) {
      return { kvCacheType: fallback, upgraded: false, reason: 'gemma f16 fits multi-slot' };
    }
    const q8Slots = Math.min(args.maxSlots, args.ceilingFor('q8_0', args.requestedCtxTokens));
    if (q8Slots >= 2) {
      return {
        kvCacheType: 'q8_0',
        upgraded: true,
        reason: 'gemma f16 traded for a second slot (SWA re-prefill pathology)',
      };
    }
    return { kvCacheType: fallback, upgraded: false, reason: 'gemma f16 (trade buys nothing)' };
  }

  // Non-Gemma: f16-first ladder. Every rung clears BOTH gates — the fast-pool
  // slot ceiling (KV lives on the card) and the admission the launch will
  // really run. Gating on the ceiling alone is what made this ladder always
  // answer f16: see the `fitsAt` contract above.
  const desiredSlots = args.slotsConfigured ? (args.configuredSlots ?? 1) : args.maxSlots;
  const f16AtRequested = args.ceilingFor('f16', args.requestedCtxTokens);
  if (f16AtRequested >= desiredSlots && args.fitsAt('f16', args.requestedCtxTokens, desiredSlots)) {
    return { kvCacheType: 'f16', upgraded: false, reason: 'f16 fits the full plan' };
  }
  if (
    !args.slotsConfigured &&
    f16AtRequested >= 1 &&
    args.fitsAt('f16', args.requestedCtxTokens, 1)
  ) {
    return {
      kvCacheType: 'f16',
      upgraded: false,
      reason: `f16 preferred at ${f16AtRequested} slot(s) instead of q8_0 at ${desiredSlots}`,
    };
  }
  const canCapCtx =
    !args.ctxConfigured &&
    args.requestedCtxTokens > F16_PREFERRED_CTX_CAP_TOKENS &&
    F16_PREFERRED_CTX_CAP_TOKENS >= args.minimumCtxTokens;
  if (canCapCtx) {
    const neededSlots = args.slotsConfigured ? desiredSlots : 1;
    if (
      args.ceilingFor('f16', F16_PREFERRED_CTX_CAP_TOKENS) >= neededSlots &&
      args.fitsAt('f16', F16_PREFERRED_CTX_CAP_TOKENS, neededSlots)
    ) {
      return {
        kvCacheType: 'f16',
        upgraded: false,
        ctxCapTokens: F16_PREFERRED_CTX_CAP_TOKENS,
        reason: `f16 preferred with context capped ${args.requestedCtxTokens} -> ${F16_PREFERRED_CTX_CAP_TOKENS}`,
      };
    }
  }
  return {
    kvCacheType: fallback,
    upgraded: false,
    reason: 'f16 does not fit the memory plan — q8_0 for the memory saving',
  };
}
