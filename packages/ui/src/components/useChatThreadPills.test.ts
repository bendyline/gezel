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
  groupedTaskRefs?: string[];
  finishedTaskRefs?: string[];
  liveTools?: Array<[string, string]>;
}) {
  return selectThreadPills({
    sessions: input.sessions,
    inflight: new Set(input.inflight ?? []),
    errored: new Map(input.errored ?? []),
    now: NOW,
    ...(input.pinnedSessionId ? { pinnedSessionId: input.pinnedSessionId } : {}),
    ...(input.groupedTaskRefs ? { groupedTaskRefs: new Set(input.groupedTaskRefs) } : {}),
    ...(input.finishedTaskRefs ? { finishedTaskRefs: new Set(input.finishedTaskRefs) } : {}),
    ...(input.liveTools ? { liveTools: new Map(input.liveTools) } : {}),
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

  it('always keeps the newest independent thread even after the recency window', () => {
    const { pills } = run({
      sessions: [session('last-independent', 30 * 24 * HOUR)],
    });
    expect(ids(pills)).toEqual(['last-independent']);
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

  it('keeps the newest independent thread inline past the cap', () => {
    const sessions = [
      ...Array.from({ length: 8 }, (_, i) =>
        session(`task-${i}`, (i + 1) * 60_000, { taskRef: `p1/${i + 1}` }),
      ),
      session('independent', 2 * HOUR),
    ];
    const { pills, overflow } = run({ sessions });
    expect(ids(pills)).toContain('independent');
    expect(ids(overflow)).not.toContain('independent');
  });
});

describe('selectThreadPills task grouping', () => {
  it('groups an idle thread into its task instead of returning a second pill', () => {
    const { pills, taskPills } = run({
      sessions: [session('t', 1 * HOUR, { taskRef: 'p1/4' })],
      groupedTaskRefs: ['p1/4'],
    });
    expect(pills).toEqual([]);
    expect(taskPills.get('p1/4')?.sessionId).toBe('t');
  });

  it('keeps streaming state on the unified task pill without returning a second pill', () => {
    const { pills, taskPills } = run({
      sessions: [session('t', 1 * HOUR, { taskRef: 'p1/4' })],
      inflight: ['t'],
      groupedTaskRefs: ['p1/4'],
    });
    expect(pills).toEqual([]);
    expect(taskPills.get('p1/4')).toMatchObject({ sessionId: 't', state: 'inflight' });
  });

  it('uses the newest non-archived chat for each task', () => {
    const { taskPills } = run({
      sessions: [
        session('new', 1 * HOUR, { taskRef: 'p1/4' }),
        session('archived-newer', 30_000, { taskRef: 'p1/4', archived: true }),
        session('old', 2 * HOUR, { taskRef: 'p1/4' }),
      ],
      groupedTaskRefs: ['p1/4'],
    });
    expect(taskPills.get('p1/4')?.sessionId).toBe('new');
  });
});

describe('selectThreadPills settled tasks', () => {
  it('drops an idle thread whose task is done or canceled', () => {
    const { pills, overflow } = run({
      sessions: [
        session('independent', 1 * HOUR),
        session('done-task', 1 * HOUR, { taskRef: 'p1/7' }),
      ],
      finishedTaskRefs: ['p1/7'],
    });
    expect(ids(pills)).toEqual(['independent']);
    expect(overflow).toEqual([]);
  });

  it('keeps a settled task thread that is streaming or errored', () => {
    const { pills } = run({
      sessions: [
        session('live', 1 * HOUR, { taskRef: 'p1/7' }),
        session('broke', 2 * HOUR, { taskRef: 'p1/8' }),
      ],
      inflight: ['live'],
      errored: [['broke', 'provider timeout']],
      finishedTaskRefs: ['p1/7', 'p1/8'],
    });
    expect(ids(pills)).toEqual(['live', 'broke']);
  });

  it('keeps the pinned thread even when its task is settled', () => {
    const { pills } = run({
      sessions: [session('reading-it', 1 * HOUR, { taskRef: 'p1/7' })],
      pinnedSessionId: 'reading-it',
      finishedTaskRefs: ['p1/7'],
    });
    expect(ids(pills)).toEqual(['reading-it']);
  });

  it('leaves an unsettled task thread alone', () => {
    const { pills } = run({
      sessions: [session('paused-task', 1 * HOUR, { taskRef: 'p1/9' })],
      finishedTaskRefs: ['p1/7'],
    });
    expect(ids(pills)).toEqual(['paused-task']);
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

describe('selectThreadPills live tools', () => {
  it('carries the running tool onto a streaming pill', () => {
    const { pills } = run({
      sessions: [session('s1', 0)],
      inflight: ['s1'],
      liveTools: [['s1', 'grep_files']],
    });
    expect(pills[0]?.liveToolName).toBe('grep_files');
  });

  // A stale entry outlives its turn whenever a `done` envelope is dropped —
  // the 20s inflight reconcile is what heals that, so the pill must key off
  // state rather than off the map still holding a name.
  it('drops it once the turn is no longer in flight', () => {
    const { pills } = run({
      sessions: [session('s1', 0)],
      liveTools: [['s1', 'grep_files']],
    });
    expect(pills[0]?.liveToolName).toBeUndefined();
  });
});
