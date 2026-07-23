import type { QuotaBucket } from '../chat/usage.js';
import type { TurnUsage } from './types.js';

/**
 * Inputs for {@link buildTurnUsage}. Each provider passes its own
 * `durationMs` because the source-of-truth differs: wall-clock for most,
 * SDK-reported `duration` for Copilot, generation-only for Ollama. Optional
 * fields are dropped when undefined so the resulting struct stays minimal
 * for providers that don't surface them.
 */
export interface BuildTurnUsageOpts {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Total billed-input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Provider-reported cost in USD. */
  cost?: number;
  /** Per-turn quota snapshots (Copilot). */
  quotaBuckets?: QuotaBucket[];
  /** Prompt-eval vs `num_ctx` (Ollama / llama-cpp). */
  contextUtilization?: { used: number; limit: number };
}

/**
 * Build a {@link TurnUsage} record. Centralizes the timestamp and the
 * "drop undefined optionals" pattern so per-provider call sites stop
 * hand-rolling near-identical struct literals — and so future fields
 * (cache breakdown, latency tiers, etc.) land in one place.
 */
export function buildTurnUsage(opts: BuildTurnUsageOpts): TurnUsage {
  const turn: TurnUsage = {
    model: opts.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    durationMs: opts.durationMs,
    at: new Date().toISOString(),
  };
  if (opts.cachedInputTokens !== undefined) turn.cachedInputTokens = opts.cachedInputTokens;
  if (opts.cost !== undefined) turn.cost = opts.cost;
  if (opts.quotaBuckets && opts.quotaBuckets.length > 0) turn.quotaBuckets = opts.quotaBuckets;
  if (opts.contextUtilization) turn.contextUtilization = opts.contextUtilization;
  return turn;
}
