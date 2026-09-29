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
    expect(nested.branchBySession.get('parent')).toMatchObject({ hasChildren: true });
    expect(nested.branchBySession.get('child')).toMatchObject({
      hasFollowingSibling: false,
      ancestorContinuationLevels: [],
    });
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
    expect(nested.branchBySession.get('first-child')).toMatchObject({
      hasChildren: true,
      hasFollowingSibling: true,
    });
    expect(nested.branchBySession.get('grandchild')?.ancestorContinuationLevels).toEqual([2]);
    expect(nested.branchBySession.get('second-child')?.hasFollowingSibling).toBe(false);
  });

  it('anchors a child to the parent turn that spawned it, so a newer parent turn stays last', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('parent', '2026-08-01T10:00:00Z'),
      row('child', '2026-08-01T10:01:00Z', 'parent'),
      row('parent', '2026-08-01T13:00:00Z'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual(['parent', 'child', 'parent']);
    expect(nested.items.at(-1)).toMatchObject({ sessionId: 'parent', at: '2026-08-01T13:00:00Z' });
  });

  it('places a child older than every loaded parent turn after the earliest one', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('child', '2026-08-01T09:00:00Z', 'parent'),
      row('parent', '2026-08-01T10:00:00Z'),
      row('parent', '2026-08-01T13:00:00Z'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual(['parent', 'child', 'parent']);
  });

  it('ends each sibling guide at the parent turn its siblings hang from', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('parent', '2026-08-01T10:00:00Z'),
      row('early-a', '2026-08-01T10:01:00Z', 'parent'),
      row('early-b', '2026-08-01T10:02:00Z', 'parent'),
      row('parent', '2026-08-01T12:00:00Z'),
      row('late', '2026-08-01T12:01:00Z', 'parent'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual(['parent', 'early-a', 'early-b', 'parent', 'late']);
    expect(nested.branchBySession.get('early-a')?.hasFollowingSibling).toBe(true);
    expect(nested.branchBySession.get('early-b')?.hasFollowingSibling).toBe(false);
    expect(nested.branchBySession.get('late')?.hasFollowingSibling).toBe(false);
  });

  it('anchors a grandchild to the child turn that spawned it', () => {
    const threads = buildTimelineThreads<Msg, never, { id: string }, never>([
      row('parent', '2026-08-01T10:00:00Z'),
      row('child', '2026-08-01T10:01:00Z', 'parent'),
      row('grandchild', '2026-08-01T10:02:00Z', 'child'),
      row('child', '2026-08-01T11:00:00Z', 'parent'),
      row('parent', '2026-08-01T13:00:00Z'),
    ]);
    const nested = nestChildSessionThreads(threads);

    expect(sessionOrder(nested.items)).toEqual([
      'parent',
      'child',
      'grandchild',
      'child',
      'parent',
    ]);
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
