import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnUsage } from '@bendyline/gezel-inference/internal/providers/types';

/**
 * `codex exec resume` reports the thread's running total in `turn.completed`,
 * not the turn's own tokens. Summed per turn, a four-turn thread whose totals
 * were 60k, 132k, 230k and 312k recorded 423k for its first three turns, and
 * every resumed Codex session overstated its usage the same way (in all 38
 * trials of the 2026-11-09 Sol cost replicate that completed a turn, the record
 * equaled that sum exactly). Each turn is charged the difference from the
 * thread's last total.
 */
export interface CodexThreadTotal {
  threadId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function turnUsageFromThreadTotal(
  reported: TurnUsage,
  threadId: string | null,
  previous: CodexThreadTotal | null,
): { usage: TurnUsage; total: CodexThreadTotal | null } {
  if (!threadId) return { usage: reported, total: null };
  const total: CodexThreadTotal = {
    threadId,
    inputTokens: reported.inputTokens,
    cachedInputTokens: reported.cachedInputTokens ?? 0,
    outputTokens: reported.outputTokens,
  };
  const prior = previous?.threadId === threadId ? previous : null;
  // A total that went down is a thread Codex started over; charge what it reports.
  if (
    !prior ||
    total.inputTokens < prior.inputTokens ||
    total.cachedInputTokens < prior.cachedInputTokens ||
    total.outputTokens < prior.outputTokens
  ) {
    return { usage: reported, total };
  }
  const cached = total.cachedInputTokens - prior.cachedInputTokens;
  const { cachedInputTokens: _cached, ...rest } = reported;
  return {
    usage: {
      ...rest,
      inputTokens: total.inputTokens - prior.inputTokens,
      outputTokens: total.outputTokens - prior.outputTokens,
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    },
    total,
  };
}

/**
 * The thread's running total as its rollout last recorded it, for a session that
 * resumes a thread this process has not run yet (after a daemon restart). Codex
 * names each rollout `rollout-<time>-<threadId>.jsonl` under `$CODEX_HOME/sessions`.
 */
export async function readCodexThreadTotal(
  codexHome: string,
  threadId: string,
): Promise<CodexThreadTotal | null> {
  let names: string[];
  try {
    names = await readdir(join(codexHome, 'sessions'), { recursive: true });
  } catch {
    return null;
  }
  const file = names.find((n) => n.endsWith(`-${threadId}.jsonl`));
  if (!file) return null;
  let last: CodexThreadTotal | null = null;
  try {
    for (const line of (await readFile(join(codexHome, 'sessions', file), 'utf8')).split('\n')) {
      if (!line.includes('"token_count"')) continue;
      let event: {
        payload?: { type?: string; info?: { total_token_usage?: Record<string, number> } };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const t =
        event.payload?.type === 'token_count' ? event.payload.info?.total_token_usage : undefined;
      if (!t) continue;
      last = {
        threadId,
        inputTokens: t.input_tokens ?? 0,
        cachedInputTokens: t.cached_input_tokens ?? 0,
        outputTokens: t.output_tokens ?? 0,
      };
    }
  } catch {
    return null;
  }
  return last;
}
