import { describe, expect, it } from 'vitest';
import {
  type ModelSpeedTotals,
  accumulateModelSpeed,
  composeQueueStatus,
  computeLiveTokensPerSec,
  computeRollingTokensPerSec,
  estimateLiveOutputTokens,
  rankModelSpeeds,
} from './engine-pill-stats.js';

/**
 * The rolling-avg helper aggregates by total tokens / total
 * generation seconds, NOT by averaging per-turn rates. A long slow
 * turn should weigh as heavily as a short fast one — otherwise a
 * single 2-token-fast-sampler test message would skew the minute-
 * average upward on a model that's actually been generating 20 tok/s
 * on real turns.
 */
describe('computeRollingTokensPerSec', () => {
  const now = Date.now();

  it('returns null on an empty window', () => {
    expect(computeRollingTokensPerSec([])).toBeNull();
  });

  it('returns null when no entry has a valid tokensPerSec', () => {
    expect(
      computeRollingTokensPerSec([
        { at: now, promptTokens: 100, completionTokens: 0, durationMs: 5_000 },
      ]),
    ).toBeNull();
  });

  it('averages by total tokens over total generation seconds', () => {
    // Two turns:
    //   Turn 1: 50 tokens at 25 tok/s  → 2.0s of generation
    //   Turn 2: 100 tokens at 20 tok/s → 5.0s of generation
    //   Aggregate: 150 tokens / 7.0s = ~21.4 tok/s
    const result = computeRollingTokensPerSec([
      {
        at: now - 10_000,
        promptTokens: 40,
        completionTokens: 50,
        durationMs: 3_000,
        tokensPerSec: 25,
      },
      {
        at: now - 1_000,
        promptTokens: 40,
        completionTokens: 100,
        durationMs: 6_000,
        tokensPerSec: 20,
      },
    ]);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(150 / 7, 1);
  });

  it("doesn't let a tiny fast turn skew the average", () => {
    // Compare per-turn averaging vs. total/total. If we (wrongly)
    // averaged the rates we'd get (200 + 20) / 2 = 110 tok/s.
    // Correct aggregate: (2 + 1000) tokens / ((2/200) + (1000/20))s
    //                  = 1002 / (0.01 + 50) ≈ 20.03 tok/s.
    const result = computeRollingTokensPerSec([
      { at: now - 5_000, promptTokens: 5, completionTokens: 2, durationMs: 50, tokensPerSec: 200 },
      {
        at: now - 1_000,
        promptTokens: 500,
        completionTokens: 1_000,
        durationMs: 50_500,
        tokensPerSec: 20,
      },
    ]);
    expect(result!).toBeCloseTo(1002 / 50.01, 0);
    expect(result!).toBeLessThan(30);
  });

  it('ignores entries with zero or negative tokensPerSec', () => {
    const result = computeRollingTokensPerSec([
      { at: now, promptTokens: 10, completionTokens: 0, durationMs: 100, tokensPerSec: 0 },
      { at: now, promptTokens: 10, completionTokens: 100, durationMs: 5_000, tokensPerSec: 20 },
    ]);
    expect(result!).toBeCloseTo(20, 1);
  });
});

/**
 * Per-model totals answer "how fast is this model on my machine",
 * which is a different question from the 60s window's "how fast is the
 * machine right now". Mixing a 27B and a 4B into one average answers
 * neither.
 */
describe('accumulateModelSpeed / rankModelSpeeds', () => {
  const now = Date.now();
  const empty: ReadonlyMap<string, ModelSpeedTotals> = new Map();

  it('keeps the same map reference for a turn with no model', () => {
    const next = accumulateModelSpeed(empty, {
      at: now,
      promptTokens: 10,
      completionTokens: 100,
      durationMs: 5_000,
      tokensPerSec: 20,
    });
    expect(next).toBe(empty);
  });

  it('keeps the same map reference for a turn with no usable rate', () => {
    const next = accumulateModelSpeed(empty, {
      at: now,
      model: 'qwen3.8-27b-q4',
      promptTokens: 10,
      completionTokens: 100,
      durationMs: 5_000,
    });
    expect(next).toBe(empty);
  });

  it('aggregates by total tokens over total seconds, per model', () => {
    // qwen: 50 tok @ 25 tok/s (2s) then 100 tok @ 20 tok/s (5s)
    //       → 150 / 7 ≈ 21.4 tok/s across 2 turns
    let totals = accumulateModelSpeed(empty, {
      at: now,
      model: 'qwen',
      promptTokens: 40,
      completionTokens: 50,
      durationMs: 3_000,
      tokensPerSec: 25,
    });
    totals = accumulateModelSpeed(totals, {
      at: now,
      model: 'qwen',
      promptTokens: 40,
      completionTokens: 100,
      durationMs: 6_000,
      tokensPerSec: 20,
    });
    const rows = rankModelSpeeds(totals);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('qwen');
    expect(rows[0]!.turns).toBe(2);
    expect(rows[0]!.tokensPerSec).toBeCloseTo(150 / 7, 1);
  });

  it('never blends two models into one figure', () => {
    let totals = accumulateModelSpeed(empty, {
      at: now,
      model: 'qwen-27b',
      promptTokens: 40,
      completionTokens: 300,
      durationMs: 12_000,
      tokensPerSec: 30,
    });
    totals = accumulateModelSpeed(totals, {
      at: now,
      model: 'gemma-4b',
      promptTokens: 40,
      completionTokens: 90,
      durationMs: 1_200,
      tokensPerSec: 90,
    });
    const rows = rankModelSpeeds(totals);
    expect(rows.map((r) => r.model)).toEqual(['qwen-27b', 'gemma-4b']);
    expect(rows[0]!.tokensPerSec).toBeCloseTo(30, 1);
    expect(rows[1]!.tokensPerSec).toBeCloseTo(90, 1);
  });

  it('ranks by generation seconds, not turn count', () => {
    // The 4B racked up three quick turns; the 27B owned the machine.
    // The model doing the work should lead the list.
    let totals = accumulateModelSpeed(empty, {
      at: now,
      model: 'big',
      promptTokens: 40,
      completionTokens: 600,
      durationMs: 30_000,
      tokensPerSec: 20,
    });
    for (let i = 0; i < 3; i++) {
      totals = accumulateModelSpeed(totals, {
        at: now,
        model: 'small',
        promptTokens: 40,
        completionTokens: 90,
        durationMs: 1_000,
        tokensPerSec: 90,
      });
    }
    const rows = rankModelSpeeds(totals);
    expect(rows[0]!.model).toBe('big');
    expect(rows[1]!.turns).toBe(3);
  });

  it('caps the list so the popover cannot grow without bound', () => {
    let totals = empty;
    for (let i = 0; i < 9; i++) {
      totals = accumulateModelSpeed(totals, {
        at: now,
        model: `model-${i}`,
        promptTokens: 10,
        completionTokens: 100,
        durationMs: 5_000,
        tokensPerSec: 20,
      });
    }
    expect(rankModelSpeeds(totals)).toHaveLength(4);
    expect(rankModelSpeeds(totals, 2)).toHaveLength(2);
  });
});

/**
 * The live rate is measured from the generating phase, never from turn
 * start — prefill on a 27B GGUF routinely runs tens of seconds, and
 * folding it in would report a fraction of the real decode speed.
 */
describe('computeLiveTokensPerSec', () => {
  const now = Date.now();

  it('returns null before the sample is long enough to be stable', () => {
    expect(computeLiveTokensPerSec(40, now - 1_000, now)).toBeNull();
  });

  it('returns null when nothing has been generated yet', () => {
    expect(computeLiveTokensPerSec(0, now - 30_000, now)).toBeNull();
  });

  it('divides output tokens by generating seconds', () => {
    expect(computeLiveTokensPerSec(600, now - 20_000, now)).toBeCloseTo(30, 5);
  });
});

describe('estimateLiveOutputTokens', () => {
  it('uses the shared four-characters-per-token heuristic for live text', () => {
    expect(estimateLiveOutputTokens(0)).toBe(0);
    expect(estimateLiveOutputTokens(1)).toBe(1);
    expect(estimateLiveOutputTokens(398)).toBe(100);
  });
});

/**
 * The pill draws from two queue layers — the provider request queue
 * and the per-session backlog. The original bug: the backlog was
 * ignored, so the pill read "Idle" while chats sat enqueued. These
 * cover the fold-down logic that drives the badge, busy styling, and
 * the popover Status/Queue rows.
 */
describe('composeQueueStatus', () => {
  const empty = { running: 0, interactive: 0, background: 0, backlog: 0 };

  it('reports fully idle when nothing is running or waiting', () => {
    const v = composeQueueStatus(empty);
    expect(v.waiting).toBe(0);
    expect(v.active).toBe(false);
    expect(v.idleStatus).toBe('Idle — waiting for a message');
    expect(v.queueRow).toBe('');
  });

  it('counts the per-session backlog even when the provider queue is empty', () => {
    // The reported case: provider queue null/empty, two chats sitting
    // in the conversation backlog. Must NOT read idle.
    const v = composeQueueStatus({ ...empty, backlog: 2 });
    expect(v.waiting).toBe(2);
    expect(v.active).toBe(true);
    expect(v.idleStatus).toBe('2 chats queued');
    expect(v.queueRow).toBe('2 chats waiting');
  });

  it('singularizes a backlog of one', () => {
    const v = composeQueueStatus({ ...empty, backlog: 1 });
    expect(v.idleStatus).toBe('1 chat queued');
    expect(v.queueRow).toBe('1 chat waiting');
  });

  it('counts only chats in the waiting badge, not background one-shots', () => {
    const v = composeQueueStatus({
      running: 1,
      runningInteractive: 1,
      interactive: 1,
      background: 2,
      backlog: 3,
    });
    // 1 interactive + 3 backlog are chats; the 2 background one-shots
    // are named separately rather than inflating the chat count.
    expect(v.waiting).toBe(4);
    expect(v.active).toBe(true);
    expect(v.idleStatus).toBe('1 chat running · 4 queued · 2 background jobs');
    expect(v.queueRow).toBe('1 running · 1 interactive · 2 background · 3 chats waiting');
  });

  /**
   * The wild-caught case: a Boekwachter index-enrichment drive holding
   * the only running slot with five more queued, while
   * `/api/sessions/inflight` reported zero turns. The Status line read
   * "1 running · 5 queued" — both numbers chat-shaped, neither a chat.
   */
  it('never calls a background one-shot a chat', () => {
    const v = composeQueueStatus({
      running: 1,
      runningInteractive: 0,
      interactive: 0,
      background: 5,
      backlog: 0,
    });
    expect(v.waiting).toBe(0);
    expect(v.idleStatus).toBe('No chats · 6 background jobs');
    // Still busy: the GPU is saturated even though nobody is chatting.
    expect(v.active).toBe(true);
  });

  it('treats running chats (no waiting) as active without a queued count', () => {
    const v = composeQueueStatus({ ...empty, running: 1, runningInteractive: 1 });
    expect(v.waiting).toBe(0);
    expect(v.active).toBe(true);
    expect(v.idleStatus).toBe('1 chat running');
    expect(v.queueRow).toBe('1 running');
  });

  it('falls back to treating every running slot as chat work when the lane split is absent', () => {
    // A broker older than the lane split omits `runningInteractive`.
    const v = composeQueueStatus({ ...empty, running: 2 });
    expect(v.idleStatus).toBe('2 chats running');
  });

  it('pluralizes a single background job', () => {
    const v = composeQueueStatus({ ...empty, running: 1, runningInteractive: 0 });
    expect(v.idleStatus).toBe('No chats · 1 background job');
  });
});
