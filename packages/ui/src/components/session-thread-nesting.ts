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

export interface NestedSessionThreads<M extends MessageWithParent, S, T, TS> {
  items: Array<TimelineThreadItem<M, S, T, TS>>;
  depthBySession: Map<string, number>;
  branchBySession: Map<string, SessionTreeBranch>;
}

function parentIdFor<M extends MessageWithParent, S>(
  item: Extract<TimelineThreadItem<M, S, unknown, unknown>, { kind: 'thread' }>,
): string | undefined {
  const rows = item.root ? [item.root, ...item.replies] : item.replies;
  for (const row of rows) {
    if (row.kind === 'message' && row.msg.parentSession?.sessionId) {
      return row.msg.parentSession.sessionId;
    }
  }
  return undefined;
}

/**
 * Keep every child session directly after the parent session that opened it.
 *
 * The ordinary timeline order follows newest activity and deliberately pins
 * the composer's active thread last. That makes a delegated worker look like
 * an unrelated conversation above its launcher. This pass removes only
 * explicitly-related child sessions from that root order and emits them after
 * their parent's final visible turn, preserving each session's own turn order
 * and the relative order of siblings.
 */
export function nestChildSessionThreads<M extends MessageWithParent, S, T, TS>(
  items: Array<TimelineThreadItem<M, S, T, TS>>,
): NestedSessionThreads<M, S, T, TS> {
  const sessionItems = new Map<string, Array<TimelineThreadItem<M, S, T, TS>>>();
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

  const hasFollowingSibling = new Map<string, boolean>();
  for (const siblings of childrenByParent.values()) {
    for (let index = 0; index < siblings.length; index++) {
      const sessionId = siblings[index];
      if (sessionId) hasFollowingSibling.set(sessionId, index < siblings.length - 1);
    }
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

  const nestedSessions = new Set<string>();
  for (const [childId, parentId] of parentBySession) {
    if (presentSessions.has(parentId) && (depthBySession.get(childId) ?? 0) > 0) {
      nestedSessions.add(childId);
    }
  }

  const output: Array<TimelineThreadItem<M, S, T, TS>> = [];
  const emitted = new Set<string>();
  const emitSession = (sessionId: string, trail = new Set<string>()) => {
    if (emitted.has(sessionId) || trail.has(sessionId)) return;
    emitted.add(sessionId);
    for (const item of sessionItems.get(sessionId) ?? []) output.push(item);
    const nextTrail = new Set(trail);
    nextTrail.add(sessionId);
    for (const childId of childrenByParent.get(sessionId) ?? []) {
      emitSession(childId, nextTrail);
    }
  };

  const lastTopLevelIndex = new Map<string, number>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.kind === 'thread' && !nestedSessions.has(item.sessionId)) {
      lastTopLevelIndex.set(item.sessionId, index);
    }
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    if (item.kind !== 'thread') {
      output.push(item);
      continue;
    }
    if (nestedSessions.has(item.sessionId)) continue;
    output.push(item);
    if (lastTopLevelIndex.get(item.sessionId) === index) {
      emitted.add(item.sessionId);
      for (const childId of childrenByParent.get(item.sessionId) ?? []) emitSession(childId);
    }
  }

  // A malformed cycle should never erase history. Append anything the guarded
  // tree walk could not place in its original per-session order.
  for (const sessionId of presentSessions) {
    if (!emitted.has(sessionId)) emitSession(sessionId);
  }

  return { items: output, depthBySession, branchBySession };
}
