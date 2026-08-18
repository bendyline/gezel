/**
 * Tracks LLM usage metrics across providers. Receives a normalized
 * `TurnUsage` from whichever provider ran the turn; each provider's stats
 * (plus its quota buckets, if any) are kept separately so the UI can render
 * per-provider cards.
 */

import type { ProviderName, TurnUsage } from '../providers/types.js';

export interface QuotaBucket {
  /** Bucket identifier from the provider (e.g. "premium_interactions"). */
  name: string;
  isUnlimited: boolean;
  limit: number;
  used: number;
  remaining: number;
  remainingPercent: number;
  overage: number;
  resetDate?: string;
}

/**
 * @deprecated Use QuotaBucket. Kept as an alias for compatibility with
 * existing type imports; will be removed in a future change.
 */
export type QuotaSnapshot = QuotaBucket;

export interface UsageTurn {
  model: string;
  inputTokens: number;
  /** Portion of `inputTokens` served from the provider's prompt cache; absent when unreported. */
  cachedInputTokens?: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  /** Engine-reported decode rate for this turn; absent when unreported. */
  outputTokensPerSec?: number;
  at: string;
}

export interface ProviderUsage {
  /** Non-empty only for providers that report account quota windows. */
  quotaBuckets: QuotaBucket[];
  todayTurns: number;
  todayTokensIn: number;
  /**
   * Portion of `todayTokensIn` the provider reported as prompt-cache reads.
   * Zero both when nothing was cached and when the provider reports no
   * breakdown (e.g. Copilot) — absence of data and absence of hits are
   * indistinguishable here, so render 0 as "no cache info", not "0% hit".
   */
  todayTokensCached: number;
  todayTokensOut: number;
  todayCost: number;
  totalTurns: number;
  totalTokensIn: number;
  totalTokensCached: number;
  totalTokensOut: number;
  totalCost: number;
  /**
   * Median engine-reported DECODE rate (tokens/sec) across the turns that
   * reported one, or null when none did. Median rather than mean so a single
   * cold first turn doesn't drag the figure down.
   *
   * Only local engines populate this today (llama-server's
   * `timings.predicted_per_second`, MLX's `generation_tps`) — cloud providers
   * don't report throughput, so null there is expected and must render as
   * "n/a" rather than zero.
   */
  medianOutputTokensPerSec: number | null;
  /**
   * The same median decode rate split per model, for the turns that reported
   * one. A 27B and a 4B averaged together is a number describing nothing, and
   * the question a user actually asks — "how fast is this model on my machine"
   * — is per model. Sorted fastest first; empty for providers that report no
   * throughput at all.
   *
   * This is the durable half of the speed story: it spans every session the
   * daemon has served, so it is still there when a page reloads mid-turn and
   * the client-side rolling window is empty.
   */
  modelSpeeds: ModelSpeed[];
  /** Most recently completed turn, retained independently of the UI's rolling window. */
  lastTurn: UsageTurn | null;
  lastUpdated: string | null;
}

/** Per-model decode-rate rollup inside {@link ProviderUsage}. */
export interface ModelSpeed {
  model: string;
  /** Median engine-reported decode rate across this model's turns. */
  medianOutputTokensPerSec: number;
  /** Turns that contributed a rate — not the model's total turn count. */
  turns: number;
}

export interface UsageSummary {
  providers: {
    copilot?: ProviderUsage;
    openai?: ProviderUsage;
    anthropic?: ProviderUsage;
    'anthropic-cli'?: ProviderUsage;
    'codex-cli'?: ProviderUsage;
    ollama?: ProviderUsage;
    'llama-cpp'?: ProviderUsage;
    mlx?: ProviderUsage;
    ds4?: ProviderUsage;
    remote?: ProviderUsage;
  };
  lastUpdated: string | null;
}

interface TrackerState {
  latestQuotaBuckets: QuotaBucket[];
  quotaUpdatedAt: string | null;
  turns: UsageTurn[];
}

export class UsageTracker {
  private readonly byProvider = new Map<ProviderName, TrackerState>();

  /** Record a normalized turn from any provider. */
  recordTurn(provider: ProviderName, turn: TurnUsage): void {
    const state = this.ensure(provider);
    state.turns.push({
      model: turn.model,
      inputTokens: turn.inputTokens,
      ...(turn.cachedInputTokens !== undefined
        ? { cachedInputTokens: turn.cachedInputTokens }
        : {}),
      outputTokens: turn.outputTokens,
      cost: turn.cost ?? 0,
      durationMs: turn.durationMs,
      ...(turn.outputTokensPerSec !== undefined
        ? { outputTokensPerSec: turn.outputTokensPerSec }
        : {}),
      at: turn.at,
    });
    if (turn.quotaBuckets && turn.quotaBuckets.length > 0) {
      state.latestQuotaBuckets = turn.quotaBuckets;
      state.quotaUpdatedAt = turn.at;
    }
  }

  /**
   * Record a provider quota snapshot that arrived outside a chat turn.
   *
   * CLI-backed subscriptions expose their account windows through their
   * local runtimes rather than as token-usage fields on a model response.
   * Keeping this separate from {@link recordTurn} lets the header surface
   * those windows without inventing a zero-token turn or skewing totals.
   */
  recordQuotaBuckets(
    provider: ProviderName,
    buckets: QuotaBucket[],
    at = new Date().toISOString(),
  ): void {
    const state = this.ensure(provider);
    state.latestQuotaBuckets = buckets;
    state.quotaUpdatedAt = at;
  }

  /** Latest quota buckets recorded for `provider`; empty when never reported. */
  quotaBucketsFor(provider: ProviderName): QuotaBucket[] {
    return this.byProvider.get(provider)?.latestQuotaBuckets ?? [];
  }

  summary(): UsageSummary {
    const today = new Date().toISOString().slice(0, 10);
    const providers: UsageSummary['providers'] = {};
    let overallLast: string | null = null;
    for (const [name, state] of this.byProvider) {
      const todayTurns = state.turns.filter((t) => t.at.startsWith(today));
      const latestTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1]! : null;
      const last = laterTimestamp(latestTurn?.at ?? null, state.quotaUpdatedAt);
      if (last && (!overallLast || last > overallLast)) overallLast = last;
      providers[name] = {
        quotaBuckets: state.latestQuotaBuckets,
        todayTurns: todayTurns.length,
        todayTokensIn: todayTurns.reduce((s, t) => s + t.inputTokens, 0),
        todayTokensCached: todayTurns.reduce((s, t) => s + (t.cachedInputTokens ?? 0), 0),
        todayTokensOut: todayTurns.reduce((s, t) => s + t.outputTokens, 0),
        todayCost: todayTurns.reduce((s, t) => s + t.cost, 0),
        totalTurns: state.turns.length,
        totalTokensIn: state.turns.reduce((s, t) => s + t.inputTokens, 0),
        totalTokensCached: state.turns.reduce((s, t) => s + (t.cachedInputTokens ?? 0), 0),
        totalTokensOut: state.turns.reduce((s, t) => s + t.outputTokens, 0),
        totalCost: state.turns.reduce((s, t) => s + t.cost, 0),
        medianOutputTokensPerSec: medianOf(
          state.turns
            .map((t) => t.outputTokensPerSec)
            .filter((v): v is number => typeof v === 'number' && v > 0),
        ),
        modelSpeeds: rollUpModelSpeeds(state.turns),
        lastTurn: latestTurn ? { ...latestTurn } : null,
        lastUpdated: last,
      };
    }
    return { providers, lastUpdated: overallLast };
  }

  private ensure(provider: ProviderName): TrackerState {
    let state = this.byProvider.get(provider);
    if (!state) {
      state = { latestQuotaBuckets: [], quotaUpdatedAt: null, turns: [] };
      this.byProvider.set(provider, state);
    }
    return state;
  }
}

function laterTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Group recorded turns by model and take each model's median decode rate.
 * Median rather than mean for the same reason the provider-level figure uses
 * it: a cold first turn on freshly-loaded weights is an outlier about disk,
 * not about the model.
 *
 * Ranked by generation seconds — how much of the user's waiting each model
 * actually accounts for — so the model doing the work leads even when a small
 * one-shot helper racked up more turns. Exported for tests.
 */
export function rollUpModelSpeeds(turns: readonly UsageTurn[]): ModelSpeed[] {
  const byModel = new Map<string, { rates: number[]; seconds: number }>();
  for (const turn of turns) {
    const rate = turn.outputTokensPerSec;
    if (!turn.model || typeof rate !== 'number' || !(rate > 0)) continue;
    const entry = byModel.get(turn.model) ?? { rates: [], seconds: 0 };
    entry.rates.push(rate);
    // Back out generation seconds from rate + tokens rather than using
    // durationMs, which includes prefill and tool round-trips.
    const seconds = turn.outputTokens / rate;
    if (Number.isFinite(seconds) && seconds > 0) entry.seconds += seconds;
    byModel.set(turn.model, entry);
  }
  const ranked: Array<ModelSpeed & { seconds: number }> = [];
  for (const [model, { rates, seconds }] of byModel) {
    const median = medianOf(rates);
    if (median === null) continue;
    ranked.push({ model, medianOutputTokensPerSec: median, turns: rates.length, seconds });
  }
  ranked.sort((a, b) => b.seconds - a.seconds);
  return ranked.map(({ model, medianOutputTokensPerSec, turns: contributing }) => ({
    model,
    medianOutputTokensPerSec,
    turns: contributing,
  }));
}

/** Median of a numeric list, or null when empty. Exported for tests. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(v * 10) / 10;
}
