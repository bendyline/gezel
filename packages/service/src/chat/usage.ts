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
  todayTokensOut: number;
  todayCost: number;
  totalTurns: number;
  totalTokensIn: number;
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
  lastUpdated: string | null;
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

  summary(): UsageSummary {
    const today = new Date().toISOString().slice(0, 10);
    const providers: UsageSummary['providers'] = {};
    let overallLast: string | null = null;
    for (const [name, state] of this.byProvider) {
      const todayTurns = state.turns.filter((t) => t.at.startsWith(today));
      const lastTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1]!.at : null;
      const last = laterTimestamp(lastTurn, state.quotaUpdatedAt);
      if (last && (!overallLast || last > overallLast)) overallLast = last;
      providers[name] = {
        quotaBuckets: state.latestQuotaBuckets,
        todayTurns: todayTurns.length,
        todayTokensIn: todayTurns.reduce((s, t) => s + t.inputTokens, 0),
        todayTokensOut: todayTurns.reduce((s, t) => s + t.outputTokens, 0),
        todayCost: todayTurns.reduce((s, t) => s + t.cost, 0),
        totalTurns: state.turns.length,
        totalTokensIn: state.turns.reduce((s, t) => s + t.inputTokens, 0),
        totalTokensOut: state.turns.reduce((s, t) => s + t.outputTokens, 0),
        totalCost: state.turns.reduce((s, t) => s + t.cost, 0),
        medianOutputTokensPerSec: medianOf(
          state.turns
            .map((t) => t.outputTokensPerSec)
            .filter((v): v is number => typeof v === 'number' && v > 0),
        ),
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

/** Median of a numeric list, or null when empty. Exported for tests. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(v * 10) / 10;
}
