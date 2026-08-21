/**
 * Group the flat, `at`-sorted timeline row stream into Slack-style
 * threads: each user message (a human turn or a gezel→gezel handoff
 * delivered via `message_gezel`) roots a thread, and every assistant
 * reply attaches to its session's most recent root — even when other
 * sessions' rows landed in between chronologically.
 *
 * Why containment beats strict chronology here: the chat manager's
 * continuation loop can append trailing assistant messages ("closing
 * summary" iterations) minutes after the turn's visible trigger. In a
 * flat interleave those stragglers render directly above whatever
 * message arrived next — e.g. the Meester's next scheduled check-in —
 * and read as (wrong) replies to it. Pulling them up under their real
 * trigger makes cause→effect legible at a glance.
 *
 * Pure and synchronous so the timeline's `useMemo` can call it per
 * render and the unit test can drive it with fabricated row arrays.
 */

import { resolveFanoutDuplicates } from './fanout-dedup.js';

/** Minimum message shape the thread builder reads. */
export interface ThreadMessageLike {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export type ThreadMessageRow<M extends ThreadMessageLike> = {
  kind: 'message';
  msg: M;
  at: string;
};

export type ThreadStreamingRow<S> = {
  kind: 'streaming';
  sessionId: string;
  slot: S;
  /** Stable render anchor when `at` changes with live activity. */
  threadAt?: string;
  at: string;
};

/** Rows the thread builder understands. Terminal rows pass through untouched. */
export type ThreadInputRow<M extends ThreadMessageLike, S, T, TS> =
  | ThreadMessageRow<M>
  | ThreadStreamingRow<S>
  | { kind: 'terminal'; entry: T; at: string }
  | { kind: 'terminal-streaming'; runId: string; slot: TS; at: string };

export interface ThreadGroup<M extends ThreadMessageLike, S> {
  kind: 'thread';
  /**
   * Session the root belongs to. Replies are usually from the same
   * session; merged fan-out threads may carry replies from others.
   */
  sessionId: string;
  /** Sort/render anchor — the root's `at`, or the first reply's when rootless. */
  at: string;
  /**
   * The message that opened this exchange: a user turn or an
   * inter-gezel message (`from` set). Absent when the loaded window
   * starts mid-turn (pagination boundary) or the turn is streaming in
   * a brand-new session whose user message hasn't arrived yet.
   */
  root?: ThreadMessageRow<M>;
  /** Assistant replies + at most one live streaming row, in arrival order. */
  replies: Array<ThreadMessageRow<M> | ThreadStreamingRow<S>>;
}

export type TimelineThreadItem<M extends ThreadMessageLike, S, T, TS> =
  | ThreadGroup<M, S>
  | { kind: 'terminal'; entry: T; at: string }
  | { kind: 'terminal-streaming'; runId: string; slot: TS; at: string };

/**
 * Build the threaded item list from `at`-sorted rows.
 *
 * Rules:
 *  - a user-role message closes its session's open thread and roots a
 *    new one;
 *  - an assistant message or streaming row joins its session's open
 *    thread, or opens a rootless one when the window starts mid-turn;
 *  - a fan-out duplicate user row (same content, different session,
 *    within the dedup window) does not render its own root — its
 *    session's subsequent replies merge into the kept root's thread;
 *  - terminal rows pass through as standalone items in place.
 *
 * A thread moves to each reply's position as it is processed, so top-level
 * groups are ordered by their newest activity rather than forever pinned to
 * the trigger time. The trigger and accumulated replies still stay together:
 * a late continuation cannot masquerade as a reply to a newer handoff, while
 * the active exchange also does not remain stranded above that handoff. The
 * caller orders streaming rows by observable activity, so the thread making
 * the latest progress settles nearest the bottom (before any later
 * terminal-work lane).
 */
export function buildTimelineThreads<M extends ThreadMessageLike, S, T, TS>(
  rows: Array<ThreadInputRow<M, S, T, TS>>,
): Array<TimelineThreadItem<M, S, T, TS>> {
  type MessageRow = ThreadMessageRow<M>;
  type Group = ThreadGroup<M, S>;

  // Fan-out dedup over user message rows. Wrapper objects satisfy the
  // FanoutDedupMessage shape while keeping row identity via `ref`.
  const userWrappers = rows.flatMap((r) =>
    r.kind === 'message' && r.msg.role === 'user'
      ? [
          {
            at: r.msg.at,
            role: r.msg.role,
            content: r.msg.content,
            sessionId: r.msg.sessionId,
            ref: r as MessageRow,
          },
        ]
      : [],
  );
  const wrapperDuplicateOf = resolveFanoutDuplicates(userWrappers);
  const duplicateOf = new Map<MessageRow, MessageRow>();
  for (const [dup, kept] of wrapperDuplicateOf) duplicateOf.set(dup.ref, kept.ref);

  const items: Array<TimelineThreadItem<M, S, T, TS>> = [];
  /**
   * Session → thread currently collecting that session's replies.
   * Never explicitly closed: a session's thread stays open until the
   * session's next user message roots a fresh one, so replies arriving
   * after other sessions' rows still find their way home.
   */
  const openBySession = new Map<string, Group>();
  const groupByRoot = new Map<MessageRow, Group>();

  for (const row of rows) {
    if (row.kind === 'terminal' || row.kind === 'terminal-streaming') {
      items.push(row);
      continue;
    }
    if (row.kind === 'message' && row.msg.role === 'user') {
      const kept = duplicateOf.get(row);
      if (kept) {
        const target = groupByRoot.get(kept);
        if (target) {
          // Fan-out duplicate: suppress the bubble, point this
          // session's replies at the kept root's thread.
          openBySession.set(row.msg.sessionId, target);
          continue;
        }
        // Kept root not materialized (shouldn't happen — it precedes
        // its duplicates in the sorted input); fall through and treat
        // this row as a normal root rather than dropping it.
      }
      const group: Group = {
        kind: 'thread',
        sessionId: row.msg.sessionId,
        at: row.at,
        root: row,
        replies: [],
      };
      items.push(group);
      openBySession.set(row.msg.sessionId, group);
      groupByRoot.set(row, group);
      continue;
    }
    const sessionId = row.kind === 'message' ? row.msg.sessionId : row.sessionId;
    let group = openBySession.get(sessionId);
    if (!group) {
      group = {
        kind: 'thread',
        sessionId,
        at: row.kind === 'streaming' ? (row.threadAt ?? row.at) : row.at,
        replies: [],
      };
      items.push(group);
      openBySession.set(sessionId, group);
    }
    group.replies.push(row);
    // The group may have been opened much earlier by its user trigger.
    // Re-queue the whole unit at every reply (persisted or live) so its
    // top-level position follows newest activity without separating cause
    // from effect. `group` identity remains stable for fan-out aliases in
    // `openBySession` and `groupByRoot`.
    const currentIndex = items.indexOf(group);
    if (currentIndex >= 0 && currentIndex !== items.length - 1) {
      items.splice(currentIndex, 1);
      items.push(group);
    }
  }

  return items;
}
