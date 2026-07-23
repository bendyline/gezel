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
  at: string;
}

export interface ProviderUsage {
  /** Non-empty only for providers that report quotas (today: Copilot). */
  quotaBuckets: QuotaBucket[];
  todayTurns: number;
  todayTokensIn: number;
  todayTokensOut: number;
  todayCost: number;
  totalTurns: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
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
      at: turn.at,
    });
    if (turn.quotaBuckets && turn.quotaBuckets.length > 0) {
      state.latestQuotaBuckets = turn.quotaBuckets;
    }
  }

  summary(): UsageSummary {
    const today = new Date().toISOString().slice(0, 10);
    const providers: UsageSummary['providers'] = {};
    let overallLast: string | null = null;
    for (const [name, state] of this.byProvider) {
      const todayTurns = state.turns.filter((t) => t.at.startsWith(today));
      const last = state.turns.length > 0 ? state.turns[state.turns.length - 1]!.at : null;
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
        lastUpdated: last,
      };
    }
    return { providers, lastUpdated: overallLast };
  }

  private ensure(provider: ProviderName): TrackerState {
    let state = this.byProvider.get(provider);
    if (!state) {
      state = { latestQuotaBuckets: [], turns: [] };
      this.byProvider.set(provider, state);
    }
    return state;
  }
}
