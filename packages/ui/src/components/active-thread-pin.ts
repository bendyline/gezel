/**
 * Keep the thread the composer points at at the bottom of the timeline.
 *
 * The timeline interleaves every session in scope, so a gezel working a
 * task for half an hour parks its bubbles below the thread the user is
 * actually addressing — and the last thing above the composer then
 * belongs to somebody else. Readers take the bottom of a chat log as
 * "what I am replying to", so that layout quietly mis-states where the
 * next message will land.
 *
 * Scope of the move, deliberately small:
 *  - only the active session's NEWEST thread group moves. Its earlier
 *    exchanges keep their chronological place; hoisting a whole day of
 *    history would rewrite the timeline around one dropdown pick.
 *  - a thread nobody has touched for {@link FRESH_THREAD_MAX_AGE_MS}
 *    stays put. Opening a week-old thread from the switcher is reading,
 *    not replying, and dragging it under today's work would be the more
 *    confusing of the two orders.
 *  - the live terminal lane keeps the last position (see
 *    {@link isTerminalBottomLane}).
 */

import { FRESH_THREAD_MAX_AGE_MS } from './chat-thread-freshness.js';
import { isTerminalBottomLane } from './timeline-row-order.js';
import type { ThreadGroup, ThreadMessageLike, TimelineThreadItem } from './timeline-threads.js';

function newestActivityMs<M extends ThreadMessageLike, S>(group: ThreadGroup<M, S>): number {
  let newest = Number.NEGATIVE_INFINITY;
  const rows = group.root ? [group.root, ...group.replies] : group.replies;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

export function pinActiveThreadLast<M extends ThreadMessageLike, S, T, TS, I = never>(
  items: Array<TimelineThreadItem<M, S, T, TS, I>>,
  activeSessionId: string | undefined,
  nowMs: number,
): Array<TimelineThreadItem<M, S, T, TS, I>> {
  if (!activeSessionId) return items;

  let from = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === 'thread' && item.sessionId === activeSessionId) {
      from = i;
      break;
    }
  }
  if (from === -1) return items;

  const group = items[from] as ThreadGroup<M, S>;
  const newest = newestActivityMs(group);
  if (!Number.isFinite(newest) || nowMs - newest > FRESH_THREAD_MAX_AGE_MS) return items;

  let lane = items.length;
  while (lane > 0) {
    const candidate = items[lane - 1];
    if (!candidate || !isTerminalBottomLane(candidate, nowMs)) break;
    lane--;
  }
  const to = lane - 1;
  if (to <= from) return items;

  const next = [...items];
  next.splice(from, 1);
  next.splice(to, 0, group);
  return next;
}
