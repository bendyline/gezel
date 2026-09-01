import { describe, expect, it } from 'vitest';
import { erroredSlotsWithPersistedTwin, staleLiveSessionIds } from './chat-live-slot.js';

describe('staleLiveSessionIds', () => {
  it('retires only clean slots observed before the in-flight request', () => {
    const stale = {};
    const active = {};
    const errored = { error: 'provider failed' };
    const replacedBeforeResponse = {};
    const current = new Map<string, { error?: string }>([
      ['stale', stale],
      ['active', active],
      ['errored', errored],
      ['replaced', replacedBeforeResponse],
      ['new-after-request', {}],
    ]);
    const observed = new Map<string, object>([
      ['stale', stale],
      ['active', active],
      ['errored', errored],
      ['replaced', {}],
    ]);

    expect(staleLiveSessionIds(current, observed, new Set(['active']))).toEqual(['stale']);
  });
});

describe('erroredSlotsWithPersistedTwin', () => {
  const rows = (
    entries: Array<[string, string, string | undefined]>,
  ): Array<{ sessionId: string; synthetic?: string; at: string }> =>
    entries.map(([sessionId, at, synthetic]) => ({
      sessionId,
      at,
      ...(synthetic ? { synthetic } : {}),
    }));

  it('retires an errored shell once its persisted twin lands', () => {
    // One failed turn was drawn twice: the salvaged `turn-aborted` bubble
    // AND the live shell that still carried the same sentence, a second
    // author row, and an elapsed clock ticking past the turn's death.
    const current = new Map([
      ['failed', { error: 'no first byte', startedAt: Date.parse('2026-08-31T23:00:00Z') }],
      ['healthy', { startedAt: Date.parse('2026-08-31T23:00:00Z') }],
    ]);
    const twin = rows([
      ['failed', '2026-08-31T23:02:01Z', 'turn-aborted'],
      ['healthy', '2026-08-31T23:02:05Z', undefined],
    ]);

    expect(erroredSlotsWithPersistedTwin(current, twin)).toEqual(['failed']);
  });

  it('keeps a shell whose only twin predates it', () => {
    // Failed, retried, failed again: the older twin belongs to the first
    // attempt and must not retire the shell showing the second.
    const current = new Map([
      ['failed', { error: 'boom', startedAt: Date.parse('2026-08-31T23:05:00Z') }],
    ]);
    const stale = rows([['failed', '2026-08-31T23:02:01Z', 'turn-aborted']]);

    expect(erroredSlotsWithPersistedTwin(current, stale)).toEqual([]);
  });

  it('keeps an errored shell that has no persisted record at all', () => {
    // A preflight failure publishes error+done without persisting anything.
    // Retiring that shell would erase the only copy of the error.
    const current = new Map([['failed', { error: 'boom', startedAt: 1 }]]);
    expect(erroredSlotsWithPersistedTwin(current, rows([]))).toEqual([]);
  });
});
