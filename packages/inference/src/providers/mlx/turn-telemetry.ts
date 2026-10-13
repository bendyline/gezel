import type { TurnStatsEvent } from '../streaming-session.js';
import type { TurnUsage } from '../types.js';

export interface MlxTurnUsageSnapshot {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tps?: number;
  generation_tps?: number;
  cached_tokens?: number;
}

/** Build the two terminal events from the final streamed usage snapshot. */
export function buildMlxTerminalTelemetry(args: {
  lastUsage: MlxTurnUsageSnapshot | null;
  model: string;
  start: number;
  lastIterationStartedAt: number;
  lastIterationFirstTokenAt: number | null;
  lastIterationFinishedAt: number | null;
  firstTokenAt: number | null;
}): { usage: TurnUsage; stats: TurnStatsEvent } | null {
  const {
    lastUsage,
    model,
    start,
    lastIterationStartedAt,
    lastIterationFirstTokenAt,
    lastIterationFinishedAt,
    firstTokenAt,
  } = args;
  if (!lastUsage || (lastUsage.prompt_tokens <= 0 && lastUsage.completion_tokens <= 0)) return null;

  const finishedAt = Date.now();
  const durationMs = finishedAt - start;
  const generationStartedAt = lastIterationFirstTokenAt ?? lastIterationStartedAt;
  const generationFinishedAt = lastIterationFinishedAt ?? finishedAt;
  const generationMs = Math.max(1, generationFinishedAt - generationStartedAt);
  const wallTps =
    lastUsage.completion_tokens > 0
      ? lastUsage.completion_tokens / (generationMs / 1000)
      : undefined;
  const tokensPerSec =
    lastUsage.generation_tps !== undefined && lastUsage.generation_tps > 0
      ? lastUsage.generation_tps
      : wallTps;
  const at = new Date(finishedAt).toISOString();
  return {
    usage: {
      model,
      inputTokens: lastUsage.prompt_tokens,
      outputTokens: lastUsage.completion_tokens,
      ...(lastUsage.cached_tokens !== undefined
        ? { cachedInputTokens: lastUsage.cached_tokens }
        : {}),
      ...(tokensPerSec !== undefined ? { outputTokensPerSec: tokensPerSec } : {}),
      durationMs,
      at,
    },
    stats: {
      provider: 'mlx',
      promptTokens: lastUsage.prompt_tokens,
      completionTokens: lastUsage.completion_tokens,
      durationMs,
      ...(firstTokenAt !== null ? { ttftMs: Math.max(0, firstTokenAt - start) } : {}),
      ...(lastUsage.prompt_tps !== undefined && lastUsage.prompt_tps > 0
        ? { promptTokensPerSec: lastUsage.prompt_tps }
        : {}),
      ...(lastUsage.cached_tokens !== undefined
        ? { cachedPromptTokens: lastUsage.cached_tokens }
        : {}),
      ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
    },
  };
}
