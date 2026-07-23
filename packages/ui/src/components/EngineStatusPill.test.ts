import { describe, expect, it } from 'vitest';
import { composeQueueStatus, computeRollingTokensPerSec } from './engine-pill-stats.js';

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
    expect(v.idleStatus).toBe('2 queued');
    expect(v.queueRow).toBe('2 chats waiting');
  });

  it('singularizes a backlog of one', () => {
    const v = composeQueueStatus({ ...empty, backlog: 1 });
    expect(v.idleStatus).toBe('1 queued');
    expect(v.queueRow).toBe('1 chat waiting');
  });

  it('sums provider pending and backlog into the waiting badge count', () => {
    const v = composeQueueStatus({ running: 1, interactive: 1, background: 2, backlog: 3 });
    // 1 interactive + 2 background + 3 backlog waiting (running excluded).
    expect(v.waiting).toBe(6);
    expect(v.active).toBe(true);
    expect(v.idleStatus).toBe('1 running · 6 queued');
    expect(v.queueRow).toBe('1 running · 1 interactive · 2 background · 3 chats waiting');
  });

  it('treats running-only (no waiting) as active without a queued count', () => {
    const v = composeQueueStatus({ ...empty, running: 1 });
    expect(v.waiting).toBe(0);
    expect(v.active).toBe(true);
    expect(v.idleStatus).toBe('1 running');
    expect(v.queueRow).toBe('1 running');
  });
});
