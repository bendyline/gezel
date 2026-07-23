import type { HistoryEvent } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { aggregateGateStats, aggregateModelGateEvidence } from './gate-telemetry.js';

function gatedEvent(details: Record<string, unknown>): HistoryEvent {
  return {
    id: `h_${Math.random().toString(36).slice(2, 8)}`,
    at: '2026-07-06T12:00:00.000Z',
    kind: 'task.step.gated',
    projectId: 'p1',
    summary: 'gate event',
    details,
  };
}

const historyWith = (events: HistoryEvent[]) => ({
  listEvents: async () => events,
});

describe('aggregateGateStats', () => {
  it('aggregates approves/holds/pauses/fail-kind histogram per book', async () => {
    const stats = await aggregateGateStats(
      historyWith([
        gatedEvent({
          ref: 'T-1',
          decision: 'approve',
          paused: false,
          bookCatalogId: 'board-game-web',
        }),
        gatedEvent({
          ref: 'T-2',
          decision: 'reject',
          paused: false,
          bookCatalogId: 'board-game-web',
          firstFailKind: 'sniff',
          failedKinds: ['sniff', 'minBytes'],
        }),
        gatedEvent({
          ref: 'T-2',
          decision: 'reject',
          paused: true,
          bookCatalogId: 'board-game-web',
          firstFailKind: 'sniff',
        }),
        gatedEvent({
          ref: 'T-3',
          decision: 'approve',
          paused: false,
          bookCatalogId: 'press-release',
        }),
      ]),
    );
    expect(stats).toHaveLength(2);
    const board = stats.find((s) => s.bookCatalogId === 'board-game-web');
    expect(board).toMatchObject({
      attempts: 3,
      approves: 1,
      holds: 2,
      pauses: 1,
      distinctTasks: 2,
      firstFailKinds: { sniff: 2 },
    });
    // Sorted by attempts desc.
    expect(stats[0]?.bookCatalogId).toBe('board-game-web');
    const press = stats.find((s) => s.bookCatalogId === 'press-release');
    expect(press).toMatchObject({ attempts: 1, approves: 1, holds: 0, pauses: 0 });
  });

  it('buckets events without a book key under (inline) and handles empty history', async () => {
    const stats = await aggregateGateStats(
      historyWith([gatedEvent({ ref: 'T-9', decision: 'reject', paused: false })]),
    );
    expect(stats[0]).toMatchObject({ bookCatalogId: '(inline)', holds: 1 });
    expect(await aggregateGateStats(historyWith([]))).toEqual([]);
  });
});

describe('aggregateModelGateEvidence', () => {
  it('counts per-model outcomes, skipping legacy events without a model stamp', async () => {
    const evidence = await aggregateModelGateEvidence(
      historyWith([
        gatedEvent({
          ref: 'T-1',
          decision: 'approve',
          paused: false,
          bookCatalogId: 'board-game-web',
          model: 'gemma4-e4b-q8',
          provider: 'llama-cpp',
        }),
        gatedEvent({
          ref: 'T-1',
          decision: 'reject',
          paused: false,
          bookCatalogId: 'board-game-web',
          model: 'gemma4-e4b-q8',
          provider: 'llama-cpp',
        }),
        gatedEvent({
          ref: 'T-2',
          decision: 'reject',
          paused: true,
          bookCatalogId: 'board-game-web',
          model: 'qwen3.6-27b-q4',
          provider: 'llama-cpp',
        }),
        // Legacy pre-routing event: no model/provider — skipped.
        gatedEvent({
          ref: 'T-3',
          decision: 'reject',
          paused: false,
          bookCatalogId: 'board-game-web',
        }),
      ]),
    );
    expect(evidence.get('llama-cpp:gemma4-e4b-q8')).toEqual({
      attempts: 2,
      approves: 1,
      holds: 1,
      pauses: 0,
    });
    expect(evidence.get('llama-cpp:qwen3.6-27b-q4')).toEqual({
      attempts: 1,
      approves: 0,
      holds: 1,
      pauses: 1,
    });
    expect(evidence.size).toBe(2);
  });

  it('scopes to one book when bookCatalogId is given', async () => {
    const evidence = await aggregateModelGateEvidence(
      historyWith([
        gatedEvent({
          decision: 'reject',
          paused: false,
          bookCatalogId: 'book-a',
          model: 'm1',
          provider: 'llama-cpp',
        }),
        gatedEvent({
          decision: 'approve',
          paused: false,
          bookCatalogId: 'book-b',
          model: 'm1',
          provider: 'llama-cpp',
        }),
      ]),
      { bookCatalogId: 'book-a' },
    );
    expect(evidence.get('llama-cpp:m1')).toEqual({ attempts: 1, approves: 0, holds: 1, pauses: 0 });
  });
});
