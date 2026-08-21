import { describe, expect, it } from 'vitest';
import {
  type ThreadInputRow,
  type ThreadMessageLike,
  buildTimelineThreads,
} from './timeline-threads.js';

interface Msg extends ThreadMessageLike {
  from?: { gezelId: string; gezelName: string };
}

type Row = ThreadInputRow<Msg, { anchor: string }, { id: string }, { id: string }>;

function userRow(sessionId: string, at: string, content: string, fromName?: string): Row {
  return {
    kind: 'message',
    at,
    msg: {
      sessionId,
      role: 'user',
      content,
      at,
      ...(fromName ? { from: { gezelId: fromName.toLowerCase(), gezelName: fromName } } : {}),
    },
  };
}

function assistantRow(sessionId: string, at: string, content: string): Row {
  return { kind: 'message', at, msg: { sessionId, role: 'assistant', content, at } };
}

function streamingRow(sessionId: string, at: string): Row {
  return { kind: 'streaming', sessionId, at, threadAt: at, slot: { anchor: at } };
}

function terminalRow(id: string, at: string): Row {
  return { kind: 'terminal', entry: { id }, at };
}

/** Compact shape signature: thread(session,root?,replyCount) / terminal(id). */
function shape(
  items: ReturnType<
    typeof buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>
  >,
) {
  return items.map((item) => {
    if (item.kind === 'terminal') return `terminal(${item.entry.id})`;
    if (item.kind === 'terminal-streaming') return `terminal-streaming(${item.runId})`;
    const root = item.root ? item.root.msg.content.slice(0, 20) : '<rootless>';
    return `thread(${item.sessionId}, "${root}", replies=${item.replies.length})`;
  });
}

describe('buildTimelineThreads', () => {
  it('groups a simple turn: user root + assistant replies', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('s1', '2026-07-10T15:36:27.215Z', 'hey there'),
      assistantRow('s1', '2026-07-10T15:39:07.032Z', 'Hola!'),
      assistantRow('s1', '2026-07-10T15:39:23.745Z', 'From my perspective, waiting…'),
    ]);
    expect(shape(items)).toEqual(['thread(s1, "hey there", replies=2)']);
  });

  it('keeps trailing continuation replies with their trigger, not the next root (Sofiya/Yusuf)', () => {
    // Real-world shape from a live install: "hey there" turn produced
    // a greeting plus two continuation-loop status bubbles; 14 minutes
    // later the Meester's scheduled check-in (a from-gezel user
    // message) landed, followed by its own replies. Flat rendering put
    // the status bubbles directly above the check-in and they read as
    // its replies.
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('sofiya', '2026-07-10T15:36:27.215Z', 'hey there'),
      assistantRow('sofiya', '2026-07-10T15:39:07.032Z', '¡Hola! Bienvenid@!'),
      assistantRow(
        'sofiya',
        '2026-07-10T15:39:23.745Z',
        'From my perspective, waiting for the user',
      ),
      assistantRow('sofiya', '2026-07-10T15:39:32.523Z', 'Waiting for the user to respond.'),
      userRow('sofiya', '2026-07-10T15:53:11.162Z', '[Message from Yusuf]: Checking in…', 'Yusuf'),
      assistantRow('sofiya', '2026-07-10T15:55:19.939Z', ''),
      assistantRow('sofiya', '2026-07-10T15:55:34.197Z', 'I sent you a question card.'),
    ]);
    expect(shape(items)).toEqual([
      'thread(sofiya, "hey there", replies=3)',
      'thread(sofiya, "[Message from Yusuf]", replies=2)',
    ]);
  });

  it('reattaches replies to their own session across interleaved sessions', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('a', '2026-01-01T10:00:00.000Z', 'question for A'),
      userRow('b', '2026-01-01T10:00:30.000Z', 'question for B'),
      assistantRow('b', '2026-01-01T10:01:00.000Z', 'B reply'),
      assistantRow('a', '2026-01-01T10:02:00.000Z', 'A reply (slow)'),
      assistantRow('b', '2026-01-01T10:03:00.000Z', 'B followup'),
    ]);
    expect(shape(items)).toEqual([
      'thread(a, "question for A", replies=1)',
      'thread(b, "question for B", replies=2)',
    ]);
  });

  it('opens a rootless thread for replies with no loaded trigger (pagination boundary)', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      assistantRow('s1', '2026-01-01T10:00:00.000Z', 'tail of an older turn'),
      userRow('s1', '2026-01-01T10:05:00.000Z', 'next turn'),
      assistantRow('s1', '2026-01-01T10:06:00.000Z', 'reply'),
    ]);
    expect(shape(items)).toEqual([
      'thread(s1, "<rootless>", replies=1)',
      'thread(s1, "next turn", replies=1)',
    ]);
  });

  it('attaches streaming rows to the session’s open thread and moves active work last', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('s1', '2026-01-01T10:00:00.000Z', 'go'),
      userRow('s2', '2026-01-01T10:00:10.000Z', 'other session'),
      // Streaming rows sort to the live-work lane at the bottom of the
      // flat input. The builder moves the complete s1 group there rather
      // than leaving its live reply stranded at s1's old trigger.
      streamingRow('s1', '2026-01-01T10:00:20.000Z'),
    ]);
    expect(shape(items)).toEqual([
      'thread(s2, "other session", replies=0)',
      'thread(s1, "go", replies=1)',
    ]);
    const active = items[1]!;
    if (active.kind !== 'thread') throw new Error('expected thread');
    expect(active.replies[0]!.kind).toBe('streaming');
  });

  it('orders multiple active threads by their streaming-row activity', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('older-active', '2026-01-01T10:00:00.000Z', 'first task'),
      userRow('newer-active', '2026-01-01T10:00:10.000Z', 'second task'),
      userRow('waiting', '2026-01-01T10:00:20.000Z', 'pending task'),
      streamingRow('newer-active', '2026-01-01T10:01:00.000Z'),
      streamingRow('older-active', '2026-01-01T10:02:00.000Z'),
    ]);

    expect(shape(items)).toEqual([
      'thread(waiting, "pending task", replies=0)',
      'thread(newer-active, "second task", replies=1)',
      'thread(older-active, "first task", replies=1)',
    ]);
  });

  it('keeps a thread at its newest completed reply after live work retires', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('iterating', '2026-01-01T10:00:00.000Z', 'work through the task'),
      userRow('pending', '2026-01-01T10:01:00.000Z', 'queued handoff'),
      assistantRow('iterating', '2026-01-01T10:02:00.000Z', 'iteration complete'),
    ]);

    expect(shape(items)).toEqual([
      'thread(pending, "queued handoff", replies=0)',
      'thread(iterating, "work through the tas", replies=1)',
    ]);
  });

  it('keeps the later terminal-work lane below a re-queued active chat thread', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('active', '2026-01-01T10:00:00.000Z', 'chat task'),
      userRow('waiting', '2026-01-01T10:00:10.000Z', 'pending task'),
      streamingRow('active', '2026-01-01T10:01:00.000Z'),
      terminalRow('recent-terminal', '2026-01-01T10:01:30.000Z'),
    ]);

    expect(shape(items)).toEqual([
      'thread(waiting, "pending task", replies=0)',
      'thread(active, "chat task", replies=1)',
      'terminal(recent-terminal)',
    ]);
  });

  it('creates a bottom thread for a streaming row in a brand-new session', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('s1', '2026-01-01T10:00:00.000Z', 'existing conversation'),
      streamingRow('fresh', '2026-01-01T10:00:30.000Z'),
    ]);
    expect(shape(items)).toEqual([
      'thread(s1, "existing conversatio", replies=0)',
      'thread(fresh, "<rootless>", replies=1)',
    ]);
  });

  it('keeps a rootless live thread render anchor stable while activity moves', () => {
    const row: Row = {
      kind: 'streaming',
      sessionId: 'background',
      at: '2026-01-01T10:05:00.000Z',
      threadAt: '2026-01-01T10:00:00.000Z',
      slot: { anchor: 'stable' },
    };
    const [item] = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      row,
    ]);

    expect(item?.kind).toBe('thread');
    expect(item?.at).toBe('2026-01-01T10:00:00.000Z');
  });

  it('merges fan-out duplicate roots into the kept root’s thread', () => {
    // @-mention fan-out: the same user prompt persists into two
    // sessions within the dedup window. One visible root; both
    // sessions' replies thread under it.
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('leo', '2026-01-01T10:00:00.000Z', 'compare notes, both of you'),
      userRow('linnea', '2026-01-01T10:00:01.000Z', 'compare notes, both of you'),
      assistantRow('leo', '2026-01-01T10:00:30.000Z', 'Leo reply'),
      assistantRow('linnea', '2026-01-01T10:00:45.000Z', 'Linnea reply'),
    ]);
    expect(shape(items)).toEqual(['thread(leo, "compare notes, both ", replies=2)']);
  });

  it('does not merge same-content roots outside the fan-out window', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('a', '2026-01-01T10:00:00.000Z', 'status?'),
      assistantRow('a', '2026-01-01T10:00:10.000Z', 'fine'),
      userRow('b', '2026-01-01T10:30:00.000Z', 'status?'),
      assistantRow('b', '2026-01-01T10:30:10.000Z', 'also fine'),
    ]);
    expect(shape(items)).toEqual([
      'thread(a, "status?", replies=1)',
      'thread(b, "status?", replies=1)',
    ]);
  });

  it('passes terminal rows through and orders a later chat reply after them', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('s1', '2026-01-01T10:00:00.000Z', 'run the build'),
      terminalRow('t1', '2026-01-01T10:00:30.000Z'),
      assistantRow('s1', '2026-01-01T10:01:00.000Z', 'build passed'),
    ]);
    expect(shape(items)).toEqual(['terminal(t1)', 'thread(s1, "run the build", replies=1)']);
  });

  it('starts a fresh thread per user turn in the same session', () => {
    const items = buildTimelineThreads<Msg, { anchor: string }, { id: string }, { id: string }>([
      userRow('s1', '2026-01-01T10:00:00.000Z', 'first'),
      assistantRow('s1', '2026-01-01T10:00:10.000Z', 'reply one'),
      userRow('s1', '2026-01-01T10:01:00.000Z', 'second'),
      assistantRow('s1', '2026-01-01T10:01:10.000Z', 'reply two'),
    ]);
    expect(shape(items)).toEqual([
      'thread(s1, "first", replies=1)',
      'thread(s1, "second", replies=1)',
    ]);
  });
});
