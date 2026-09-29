import type { ThreadMessageLike, TimelineThreadItem } from './timeline-threads.js';

interface MessageWithParent extends ThreadMessageLike {
  parentSession?: { sessionId: string };
}

export interface SessionTreeBranch {
  /** This session owns at least one visible child session. */
  hasChildren: boolean;
  /** Its parent guide must continue below this node to a later sibling. */
  hasFollowingSibling: boolean;
  /** More-distant ancestor columns that continue through this subtree. */
  ancestorContinuationLevels: number[];
}

export interface NestedSessionThreads<M extends MessageWithParent, S, T, TS, I = never> {
  items: Array<TimelineThreadItem<M, S, T, TS, I>>;
  depthBySession: Map<string, number>;
  branchBySession: Map<string, SessionTreeBranch>;
}

function parentIdFor<M extends MessageWithParent, S>(
  item: Extract<TimelineThreadItem<M, S, unknown, unknown, unknown>, { kind: 'thread' }>,
): string | undefined {
  const rows = item.root ? [item.root, ...item.replies] : item.replies;
  for (const row of rows) {
    if (row.kind === 'message' && row.msg.parentSession?.sessionId) {
      return row.msg.parentSession.sessionId;
    }
  }
  return undefined;
}

type ThreadItem<M extends MessageWithParent, S, T, TS, I> = Extract<
  TimelineThreadItem<M, S, T, TS, I>,
  { kind: 'thread' }
>;

function atMs(at: string): number {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Keep every child session directly after the parent turn that opened it.
 *
 * The ordinary timeline order follows newest activity and deliberately pins
 * the composer's active thread last. That makes a delegated worker look like
 * an unrelated conversation above its launcher. This pass removes only
 * explicitly-related child sessions from that root order and emits each one
 * after the parent turn it was spawned from — the latest parent turn that
 * started no later than the child's first visible turn — preserving each
 * session's own turn order and the relative order of siblings.
 *
 * Anchoring to the spawning turn rather than the parent's final turn is what
 * keeps a newer exchange with the parent at the bottom: emitting every child
 * after the final turn put hours-old consultations and hand-offs beneath the
 * message the user had just sent, and the follow-to-bottom scroll then showed
 * the stale sub-threads instead of the reply.
 */
export function nestChildSessionThreads<M extends MessageWithParent, S, T, TS, I = never>(
  items: Array<TimelineThreadItem<M, S, T, TS, I>>,
): NestedSessionThreads<M, S, T, TS, I> {
  const sessionItems = new Map<string, Array<TimelineThreadItem<M, S, T, TS, I>>>();
  const firstIndex = new Map<string, number>();
  const parentBySession = new Map<string, string>();

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || item.kind !== 'thread') continue;
    const bucket = sessionItems.get(item.sessionId) ?? [];
    bucket.push(item);
    sessionItems.set(item.sessionId, bucket);
    if (!firstIndex.has(item.sessionId)) firstIndex.set(item.sessionId, index);
    const parentId = parentIdFor(item);
    if (parentId && parentId !== item.sessionId) parentBySession.set(item.sessionId, parentId);
  }

  const presentSessions = new Set(sessionItems.keys());
  const childrenByParent = new Map<string, string[]>();
  for (const [childId, parentId] of parentBySession) {
    if (!presentSessions.has(parentId)) continue;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(childId);
    childrenByParent.set(parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (firstIndex.get(a) ?? 0) - (firstIndex.get(b) ?? 0));
  }

  const depthBySession = new Map<string, number>();
  const resolveDepth = (sessionId: string, trail = new Set<string>()): number => {
    const cached = depthBySession.get(sessionId);
    if (cached !== undefined) return cached;
    if (trail.has(sessionId)) return 0;
    const parentId = parentBySession.get(sessionId);
    if (!parentId || !presentSessions.has(parentId)) {
      depthBySession.set(sessionId, 0);
      return 0;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(sessionId);
    const depth = Math.min(4, resolveDepth(parentId, nextTrail) + 1);
    depthBySession.set(sessionId, depth);
    return depth;
  };
  for (const sessionId of presentSessions) resolveDepth(sessionId);

  const nestedSessions = new Set<string>();
  for (const [childId, parentId] of parentBySession) {
    if (presentSessions.has(parentId) && (depthBySession.get(childId) ?? 0) > 0) {
      nestedSessions.add(childId);
    }
  }

  // Delegations can reuse a worker's existing session, so its creation time
  // may predate the launcher; the child's earliest visible turn is the safer
  // spawn estimate. A child older than every loaded parent turn (the window
  // starts mid-history) falls back to the parent's earliest loaded turn.
  const childrenByAnchor = new Map<ThreadItem<M, S, T, TS, I>, string[]>();
  for (const [parentId, siblings] of childrenByParent) {
    const parentGroups = (sessionItems.get(parentId) ?? []).filter(
      (group): group is ThreadItem<M, S, T, TS, I> => group.kind === 'thread',
    );
    for (const childId of siblings) {
      if (!nestedSessions.has(childId)) continue;
      const spawnAt = Math.min(...(sessionItems.get(childId) ?? []).map((group) => atMs(group.at)));
      let anchor: ThreadItem<M, S, T, TS, I> | undefined;
      let anchorAt = Number.NEGATIVE_INFINITY;
      let earliest: ThreadItem<M, S, T, TS, I> | undefined;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const group of parentGroups) {
        const groupAt = atMs(group.at);
        if (groupAt <= spawnAt && groupAt >= anchorAt) {
          anchor = group;
          anchorAt = groupAt;
        }
        if (groupAt < earliestAt) {
          earliest = group;
          earliestAt = groupAt;
        }
      }
      const target = anchor ?? earliest;
      if (!target) continue;
      const bucket = childrenByAnchor.get(target) ?? [];
      bucket.push(childId);
      childrenByAnchor.set(target, bucket);
    }
  }

  // A parent guide continues only to a later sibling under the same turn; the
  // next parent turn starts with its own "continuing" divider.
  const hasFollowingSibling = new Map<string, boolean>();
  for (const bucket of childrenByAnchor.values()) {
    for (let index = 0; index < bucket.length; index++) {
      const sessionId = bucket[index];
      if (sessionId) hasFollowingSibling.set(sessionId, index < bucket.length - 1);
    }
  }

  const branchBySession = new Map<string, SessionTreeBranch>();
  for (const sessionId of presentSessions) {
    const ancestorContinuationLevels: number[] = [];
    if ((depthBySession.get(sessionId) ?? 0) > 0) {
      let ancestor = parentBySession.get(sessionId);
      let levelsUp = 2;
      while (ancestor && parentBySession.has(ancestor)) {
        if (hasFollowingSibling.get(ancestor) === true) {
          ancestorContinuationLevels.push(levelsUp);
        }
        ancestor = parentBySession.get(ancestor);
        levelsUp += 1;
      }
    }
    branchBySession.set(sessionId, {
      hasChildren: (childrenByParent.get(sessionId)?.length ?? 0) > 0,
      hasFollowingSibling: hasFollowingSibling.get(sessionId) === true,
      ancestorContinuationLevels,
    });
  }

  const output: Array<TimelineThreadItem<M, S, T, TS, I>> = [];
  const emitted = new Set<string>();
  const emitSession = (sessionId: string, trail = new Set<string>()) => {
    if (emitted.has(sessionId) || trail.has(sessionId)) return;
    emitted.add(sessionId);
    const nextTrail = new Set(trail);
    nextTrail.add(sessionId);
    for (const item of sessionItems.get(sessionId) ?? []) {
      output.push(item);
      if (item.kind !== 'thread') continue;
      for (const childId of childrenByAnchor.get(item) ?? []) emitSession(childId, nextTrail);
    }
  };

  for (const item of items) {
    if (!item) continue;
    if (item.kind !== 'thread') {
      output.push(item);
      continue;
    }
    if (nestedSessions.has(item.sessionId)) continue;
    output.push(item);
    emitted.add(item.sessionId);
    for (const childId of childrenByAnchor.get(item) ?? []) emitSession(childId);
  }

  // A malformed cycle should never erase history. Append anything the guarded
  // tree walk could not place in its original per-session order.
  for (const sessionId of presentSessions) {
    if (!emitted.has(sessionId)) emitSession(sessionId);
  }

  return { items: output, depthBySession, branchBySession };
}
