import type { ChatSessionSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_THREAD_PILLS,
  RECENT_THREAD_WINDOW_MS,
  selectThreadPills,
} from './useChatThreadPills.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function session(id: string, agoMs: number, extra: Partial<ChatSessionSummary> = {}) {
  return {
    id,
    gezelId: `gezel-${id}`,
    projectId: 'p1',
    providerName: 'openai',
    title: `Thread ${id}`,
    createdAt: new Date(NOW - agoMs).toISOString(),
    lastActivityAt: new Date(NOW - agoMs).toISOString(),
    ...extra,
  } as ChatSessionSummary;
}

function run(input: {
  sessions: ChatSessionSummary[];
  inflight?: string[];
  errored?: Array<[string, string]>;
  pinnedSessionId?: string;
  suppressedTaskRefs?: string[];
}) {
  return selectThreadPills({
    sessions: input.sessions,
    inflight: new Set(input.inflight ?? []),
    errored: new Map(input.errored ?? []),
    now: NOW,
    ...(input.pinnedSessionId ? { pinnedSessionId: input.pinnedSessionId } : {}),
    ...(input.suppressedTaskRefs ? { suppressedTaskRefs: new Set(input.suppressedTaskRefs) } : {}),
  });
}

const ids = (pills: Array<{ sessionId: string }>) => pills.map((p) => p.sessionId);

describe('selectThreadPills recency', () => {
  it('keeps an idle thread inside the window and drops one outside it', () => {
    const { pills } = run({
      sessions: [session('fresh', 23 * HOUR), session('stale', 25 * HOUR)],
    });
    expect(ids(pills)).toEqual(['fresh']);
  });

  it('uses the exported window as the cutoff', () => {
    const { pills } = run({
      sessions: [
        session('edge', RECENT_THREAD_WINDOW_MS),
        session('past', RECENT_THREAD_WINDOW_MS + 1),
      ],
    });
    expect(ids(pills)).toEqual(['edge']);
  });

  it('keeps ancient threads that are streaming or errored — state beats recency', () => {
    const { pills } = run({
      sessions: [session('live', 30 * 24 * HOUR), session('broke', 30 * 24 * HOUR)],
      inflight: ['live'],
      errored: [['broke', 'provider timeout']],
    });
    expect(ids(pills)).toEqual(['live', 'broke']);
    expect(pills[1]?.error).toBe('provider timeout');
  });

  it('treats a durable lastTurnError as errored without a live event', () => {
    const { pills } = run({
      sessions: [session('broke', 30 * 24 * HOUR, { lastTurnError: 'aborted' })],
    });
    expect(pills[0]?.state).toBe('errored');
    expect(pills[0]?.error).toBe('aborted');
  });

  it('excludes archived sessions regardless of state', () => {
    const { pills, overflow } = run({
      sessions: [session('gone', 0, { archived: true })],
      inflight: ['gone'],
    });
    expect(pills).toEqual([]);
    expect(overflow).toEqual([]);
  });
});

describe('selectThreadPills ordering', () => {
  it('sorts inflight, then errored, then idle — each newest first', () => {
    const { pills } = run({
      sessions: [
        session('idle-old', 5 * HOUR),
        session('idle-new', 1 * HOUR),
        session('err-old', 6 * HOUR),
        session('err-new', 2 * HOUR),
        session('live-old', 7 * HOUR),
        session('live-new', 3 * HOUR),
      ],
      inflight: ['live-old', 'live-new'],
      errored: [
        ['err-old', 'boom'],
        ['err-new', 'boom'],
      ],
    });
    expect(ids(pills)).toEqual([
      'live-new',
      'live-old',
      'err-new',
      'err-old',
      'idle-new',
      'idle-old',
    ]);
  });
});

describe('selectThreadPills cap and overflow', () => {
  it('caps idle pills at the inline budget and overflows the rest', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, (i + 1) * 60_000));
    const { pills, overflow } = run({ sessions });
    expect(pills).toHaveLength(MAX_INLINE_THREAD_PILLS);
    expect(overflow).toHaveLength(10 - MAX_INLINE_THREAD_PILLS);
    expect(ids(pills)[0]).toBe('s0');
  });

  it('never overflows a thread that needs attention', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session(`s${i}`, (i + 1) * 60_000));
    const { pills, overflow } = run({ sessions, inflight: sessions.map((s) => s.id) });
    expect(pills).toHaveLength(8);
    expect(overflow).toEqual([]);
  });

  it('keeps the pinned thread visible past the cap and past the window', () => {
    const sessions = [
      ...Array.from({ length: 8 }, (_, i) => session(`s${i}`, (i + 1) * 60_000)),
      session('pinned', 30 * 24 * HOUR),
    ];
    const { pills, overflow } = run({ sessions, pinnedSessionId: 'pinned' });
    expect(ids(pills)).toContain('pinned');
    expect(ids(overflow)).not.toContain('pinned');
  });
});

describe('selectThreadPills task de-duplication', () => {
  it('suppresses an idle thread whose task already has a pill', () => {
    const { pills } = run({
      sessions: [session('t', 1 * HOUR, { taskRef: 'p1/4' })],
      suppressedTaskRefs: ['p1/4'],
    });
    expect(pills).toEqual([]);
  });

  it('keeps that thread when it is streaming — the state is what the task pill cannot show', () => {
    const { pills } = run({
      sessions: [session('t', 1 * HOUR, { taskRef: 'p1/4' })],
      inflight: ['t'],
      suppressedTaskRefs: ['p1/4'],
    });
    expect(ids(pills)).toEqual(['t']);
  });
});

describe('selectThreadPills titles', () => {
  it('normalizes the new-thread sentinel and flattens mentions', () => {
    const { pills } = run({
      sessions: [
        session('a', 0, { title: 'New session' }),
        session('b', 60_000, { title: 'ask @[Ada](gezel:g1) about it' }),
      ],
    });
    expect(pills[0]?.title).toBe('New thread');
    expect(pills[1]?.title).toBe('ask @Ada about it');
  });
});
