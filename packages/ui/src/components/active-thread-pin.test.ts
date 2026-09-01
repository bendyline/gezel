import { describe, expect, it } from 'vitest';
import { pinActiveThreadLast } from './active-thread-pin.js';
import { FRESH_THREAD_MAX_AGE_MS } from './chat-thread-freshness.js';
import type { ThreadMessageLike, TimelineThreadItem } from './timeline-threads.js';

const now = Date.parse('2026-08-31T12:00:00.000Z');

type Item = TimelineThreadItem<ThreadMessageLike, { id: string }, { id: string }, { id: string }>;

function msg(sessionId: string, at: string, role: 'user' | 'assistant' = 'user') {
  return { kind: 'message' as const, msg: { sessionId, role, content: 'x', at }, at };
}

function thread(sessionId: string, at: string): Item {
  return { kind: 'thread', sessionId, at, root: msg(sessionId, at), replies: [] };
}

function ids(items: Item[]): string[] {
  return items.map((item) =>
    item.kind === 'thread' ? `${item.sessionId}@${item.at}` : `${item.kind}@${item.at}`,
  );
}

const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();

describe('pinActiveThreadLast', () => {
  it('moves the composer thread below another session that spoke more recently', () => {
    const items = [thread('wren', minutesAgo(6)), thread('koray', minutesAgo(1))];
    expect(ids(pinActiveThreadLast(items, 'wren', now))).toEqual([
      `koray@${minutesAgo(1)}`,
      `wren@${minutesAgo(6)}`,
    ]);
  });

  it('moves only the newest exchange of the active session', () => {
    const items = [
      thread('wren', minutesAgo(90)),
      thread('koray', minutesAgo(60)),
      thread('wren', minutesAgo(30)),
      thread('koray', minutesAgo(1)),
    ];
    expect(ids(pinActiveThreadLast(items, 'wren', now))).toEqual([
      `wren@${minutesAgo(90)}`,
      `koray@${minutesAgo(60)}`,
      `koray@${minutesAgo(1)}`,
      `wren@${minutesAgo(30)}`,
    ]);
  });

  it('counts a live reply as the thread activity that keeps it fresh', () => {
    const stale = new Date(now - FRESH_THREAD_MAX_AGE_MS - 60_000).toISOString();
    const items: Item[] = [
      {
        kind: 'thread',
        sessionId: 'wren',
        at: stale,
        root: msg('wren', stale),
        replies: [
          { kind: 'streaming', sessionId: 'wren', slot: { id: 'live' }, at: minutesAgo(1) },
        ],
      },
      thread('koray', minutesAgo(2)),
    ];
    expect(ids(pinActiveThreadLast(items, 'wren', now)).at(-1)).toBe(`wren@${stale}`);
  });

  it('leaves a thread nobody has touched in a day where it sits', () => {
    const stale = new Date(now - FRESH_THREAD_MAX_AGE_MS - 60_000).toISOString();
    const items = [thread('wren', stale), thread('koray', minutesAgo(1))];
    expect(ids(pinActiveThreadLast(items, 'wren', now))).toEqual([
      `wren@${stale}`,
      `koray@${minutesAgo(1)}`,
    ]);
  });

  it('stays above live terminal output so a command keeps its own results', () => {
    const items: Item[] = [
      thread('wren', minutesAgo(6)),
      thread('koray', minutesAgo(2)),
      { kind: 'terminal', entry: { id: 't1' }, at: minutesAgo(1) },
      { kind: 'terminal-streaming', runId: 'r1', slot: { id: 'r1' }, at: minutesAgo(1) },
    ];
    expect(ids(pinActiveThreadLast(items, 'wren', now))).toEqual([
      `koray@${minutesAgo(2)}`,
      `wren@${minutesAgo(6)}`,
      `terminal@${minutesAgo(1)}`,
      `terminal-streaming@${minutesAgo(1)}`,
    ]);
  });

  it('drops below terminal rows that have aged out of the bottom lane', () => {
    const old = new Date(now - 30 * 60_000).toISOString();
    const items: Item[] = [
      thread('wren', minutesAgo(6)),
      { kind: 'terminal', entry: { id: 't1' }, at: old },
    ];
    expect(ids(pinActiveThreadLast(items, 'wren', now))).toEqual([
      `terminal@${old}`,
      `wren@${minutesAgo(6)}`,
    ]);
  });

  it('is a no-op without an active session, or when it is already last', () => {
    const items = [thread('koray', minutesAgo(2)), thread('wren', minutesAgo(1))];
    expect(pinActiveThreadLast(items, undefined, now)).toBe(items);
    expect(pinActiveThreadLast(items, 'wren', now)).toBe(items);
    expect(pinActiveThreadLast(items, 'nobody', now)).toBe(items);
  });
});
