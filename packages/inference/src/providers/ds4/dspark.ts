/**
 * DSpark speculative decoding for ds4 (`--dspark --mtp-model <support.gguf>`).
 *
 * ds4 can draft several tokens ahead with a small companion GGUF and verify
 * them against the target model in one batched pass. Two hard constraints and
 * one measurement shape the policy here:
 *
 *  - **The engine refuses an external MTP model alongside `--ssd-streaming`**,
 *    aborting at startup, for every family except DeepSeek V4.1
 *    (`general.architecture` `deepseek41`, upstream ee7e840). Streaming is the
 *    only way the 153 GiB Q4 GGUF runs at all on a 128 GiB machine, so
 *    drafting is unreachable there. V4.1 keeps its 8.04 GiB drafter resident
 *    while the target's experts stream, but upstream warns it can still be
 *    slower than plain decoding, so `auto` never drafts a streamed launch.
 *  - **A support model is required.** Without one there is nothing to draft
 *    with, and ds4 exits on `--dspark` alone ("--dspark requires --mtp-model FILE").
 *  - **It does not pay on Metal.** Measured 2026-08-26, M5 Max, DeepSeek V4
 *    Flash IQ2_XXS at full residency, seed-pinned A/B/C/A: baseline 38.4 tok/s
 *    against 38.5 opportunistic and 36.7 exact, with ds4's own
 *    `DS4_DSPARK_STATS` reporting net_saved of -1301 ms and -1038 ms. Verifying
 *    a 5-token block through a 284B MoE costs more than the single-token
 *    decodes it skips.
 *
 * Hence `auto` keys on the **backend**, not on unified memory: Apple Silicon
 * reports `gpuMemoryKind: 'unified'` exactly as GB10 does, so a
 * residency-or-unified predicate would enable drafting on the one platform
 * where it was measured to lose.
 */

/** Which acceleration backend ds4 was launched with. */
export type Ds4Backend = 'metal' | 'cuda';

/**
 * Whether ds4 accepts `--mtp-model` alongside `--ssd-streaming` for a target
 * with this GGUF `general.architecture`. Mirrors the engine's own check
 * (`DS4_MODEL_FAMILY != DS4_MODEL_FAMILY_DEEPSEEK41` in `ds4_engine_open`);
 * an unknown architecture is treated as unsupported because the engine aborts.
 */
export function ds4DsparkStreamsWithSsd(architecture: string | undefined): boolean {
  return architecture === 'deepseek41';
}

/**
 * Buffers ds4 allocates beside a V4.1 drafter's weights; its startup memory
 * plan charges `mtp_model.size + 64 MiB` for them.
 */
export const DS4_V41_DRAFTER_RUNTIME_BYTES = 64 * 1024 ** 2;

export type Ds4DsparkMode = 'off' | 'on' | 'auto';

export interface Ds4DsparkOptions {
  /** `config.ds4Dspark`. Absent → `auto`. */
  mode?: Ds4DsparkMode;
  /** Resolved backend for this launch. */
  backend: Ds4Backend;
  /** Whether this launch streams experts from SSD. */
  ssdStreaming: boolean;
  /** The target GGUF's `general.architecture`, when known. */
  targetArchitecture?: string;
  /** Absolute path to a DSpark support GGUF, if one resolved. */
  supportModelPath?: string;
  /**
   * Whether the companion still fits once the resident weights (or, when
   * streaming, the resident set plus a minimum expert cache) are accounted
   * for. Defaults to true so callers that cannot weigh it keep the old
   * behavior. When false the launch keeps its memory plan and drops drafting —
   * residency is worth ~9.5x and drafting ~1.05x, so the flag is what yields.
   */
  companionFitsMemory?: boolean;
}

export interface Ds4DsparkDecision {
  enabled: boolean;
  /** Support model to pass to `--mtp-model`. Only set when {@link enabled}. */
  supportModelPath?: string;
  /**
   * Why drafting is on or off, in launch-log voice. Always populated: a
   * silently absent flag is indistinguishable from one the engine rejected,
   * and this is the only record of which branch ran.
   */
  reason: string;
  /**
   * Set when the user explicitly asked for `on` and it could not be honored.
   * The caller surfaces this as a warning — it must not be swallowed, because
   * the alternative to reporting it is a user who believes they are drafting.
   */
  unmetRequest?: string;
}

/**
 * Resolve whether this launch drafts, and with what.
 *
 * Never throws. An impossible `on` degrades to a plain launch with
 * {@link Ds4DsparkDecision.unmetRequest} set rather than failing the session:
 * drafting is an optimization, and refusing to serve chat over it would trade
 * a missing speedup for an outage.
 */
export function resolveDs4Dspark(opts: Ds4DsparkOptions): Ds4DsparkDecision {
  const mode = opts.mode ?? 'auto';

  if (mode === 'off') {
    return { enabled: false, reason: 'disabled by config (ds4Dspark=off)' };
  }

  if (!opts.supportModelPath) {
    return {
      enabled: false,
      reason: 'no DSpark support model available',
      ...(mode === 'on'
        ? {
            unmetRequest:
              'ds4Dspark=on but no DSpark support model is available. Install a model whose catalog entry ships one, or set ds4DsparkModelPath to a support GGUF.',
          }
        : {}),
    };
  }

  if (opts.ssdStreaming && !ds4DsparkStreamsWithSsd(opts.targetArchitecture)) {
    return {
      enabled: false,
      reason:
        'SSD streaming is on; ds4 rejects --mtp-model with --ssd-streaming except for DeepSeek V4.1',
      ...(mode === 'on'
        ? {
            unmetRequest:
              'ds4Dspark=on cannot be honored while SSD streaming is active — ds4 refuses an external --mtp-model with --ssd-streaming for every model but DeepSeek V4.1. Full residency requires a model that fits this machine with headroom to spare (ds4SsdStreaming=false).',
          }
        : {}),
    };
  }

  if (opts.companionFitsMemory === false) {
    const held = opts.ssdStreaming
      ? 'the resident weights and a minimum expert cache'
      : 'the resident weights';
    return {
      enabled: false,
      reason: `support model does not fit alongside ${held}`,
      ...(mode === 'on'
        ? {
            unmetRequest: opts.ssdStreaming
              ? `ds4Dspark=on cannot be honored: the DSpark support model does not fit in memory alongside ${held}. Drafting was dropped rather than starving the expert cache.`
              : 'ds4Dspark=on cannot be honored: the DSpark support model does not fit in memory alongside the fully resident weights. Drafting was dropped rather than giving up full residency, which is worth far more than drafting.',
          }
        : {}),
    };
  }

  if (mode === 'on') {
    return {
      enabled: true,
      supportModelPath: opts.supportModelPath,
      reason: 'enabled by config (ds4Dspark=on)',
    };
  }

  // auto
  if (opts.ssdStreaming) {
    return {
      enabled: false,
      reason:
        'auto: drafting a streamed launch is unmeasured and upstream reports it can be slower; set ds4Dspark=on to draft',
    };
  }
  if (opts.backend !== 'cuda') {
    return {
      enabled: false,
      reason: `auto: backend is ${opts.backend}; drafting measured net-negative on Metal`,
    };
  }
  return {
    enabled: true,
    supportModelPath: opts.supportModelPath,
    reason: 'auto: CUDA backend with a fully resident model',
  };
}

/**
 * Launch arguments for a decision. Empty when drafting is off, so the caller
 * can spread this unconditionally.
 *
 * Deliberately does NOT emit `--mtp-draft`: for a DSpark support model the
 * draft width comes from the companion's own `block_size` (ds4 returns
 * `dspark_weights.block_size` from `ds4_engine_mtp_draft_tokens`). `--mtp-draft`
 * only moves the legacy-MTP path, where the server's default of 1 would
 * otherwise disable drafting outright — which makes it look load-bearing here
 * when it is inert.
 */
export function ds4DsparkArgs(decision: Ds4DsparkDecision): string[] {
  if (!decision.enabled || !decision.supportModelPath) return [];
  return ['--dspark', '--mtp-model', decision.supportModelPath];
}
