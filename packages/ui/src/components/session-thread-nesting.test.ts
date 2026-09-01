import { describe, expect, it } from 'vitest';
import { nestChildSessionThreads } from './session-thread-nesting.js';
import {
  type ThreadInputRow,
  type ThreadMessageLike,
  buildTimelineThreads,
} from './timeline-threads.js';

interface Msg extends ThreadMessageLike {
  parentSession?: { sessionId: string };
}

type Row = ThreadInputRow<Msg, never, { id: string }, never>;

function row(
  sessionId: string,
  at: string,
  parentSessionId?: string,
): Extract<Row, { kind: 'message' }> {
  return {
    kind: 'message',
    at,
    msg: {
      sessionId,
      role: 'user',
      content: sessionId,
      at,
      ...(parentSessionId ? { parentSession: { sessionId: parentSessionId } } : {}),
    },
  };
}

function sessionOrder(
  items: ReturnType<typeof buildTimelineThreads<Msg, never, { id: string }, never>>,
) {
  return items.flatMap((item) => (item.kind === 'thread' ? [item.sessionId] : []));
}

describe('nestChildSessionThreads', () => {
  it('reattaches a child after its parent when another ordering pass moved the parent last', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('child', '2026-08-01T10:01:00Z', 'parent'),
      row('parent', '2026-08-01T10:00:00Z'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual(['parent', 'child']);
    expect(nested.depthBySession.get('parent')).toBe(0);
    expect(nested.depthBySession.get('child')).toBe(1);
  });

  it('supports nested delegations and preserves sibling order', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('parent', '2026-08-01T10:00:00Z'),
      row('first-child', '2026-08-01T10:01:00Z', 'parent'),
      row('grandchild', '2026-08-01T10:02:00Z', 'first-child'),
      row('second-child', '2026-08-01T10:03:00Z', 'parent'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual([
      'parent',
      'first-child',
      'grandchild',
      'second-child',
    ]);
    expect(nested.depthBySession.get('grandchild')).toBe(2);
  });

  it('leaves a child at top level when its parent is outside the loaded timeline', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('visible-child', '2026-08-01T10:01:00Z', 'not-loaded'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual(['visible-child']);
    expect(nested.depthBySession.get('visible-child')).toBe(0);
  });
});
