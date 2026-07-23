/**
 * Filter out user messages duplicated by @-mention fan-out.
 *
 * Background: when the user @-mentions another gezel while talking to
 * the active recipient, the *same* user prompt persists into both
 * gezels' sessions. The timeline interleaves messages from every
 * project session, so the cross-session view ends up showing two
 * identical "YOU: …" bubbles for what was logically one user message.
 * That reads as if the user said the same thing twice.
 *
 * Dedup keeps the first occurrence (chronologically, by `at`) and
 * drops every subsequent cross-session match that falls inside the
 * fan-out window. Within-session repeats are user intent and stay
 * visible — even an accidental double-send is a real user signal,
 * not fan-out noise.
 *
 * Pure / synchronous so the timeline's `useMemo` can call it without
 * wiring extra effects, and so the unit test can drive it with
 * pre-fabricated message arrays without a real timeline mounted.
 */

/**
 * Minimum shape this needs from a TimelineMessage. Defined here (not
 * imported from the schema) so the dedup helper stays library-free
 * and the test file doesn't have to construct full TimelineMessage
 * objects with every optional field set.
 */
export interface FanoutDedupMessage {
  /** ISO-8601 timestamp. Date.parse-able. */
  at: string;
  /** 'user' | 'assistant'. Only user messages are eligible for dedup. */
  role: 'user' | 'assistant';
  /** Trimmed content is the equality key for fan-out match. */
  content: string;
  /** Per-session id; cross-session match is what triggers dedup. */
  sessionId: string;
}

/**
 * Window in which two cross-session user messages with identical
 * content are treated as fan-out duplicates. 5 seconds is comfortably
 * larger than the actual fan-out persist time (<100ms in practice)
 * without false-positiving on an honest "I'll repeat that" 30s later.
 */
export const FANOUT_DEDUP_WINDOW_MS = 5_000;

/**
 * Map each fan-out duplicate user row to the kept original it
 * duplicates. Rows absent from the map survive dedup. The mapping (not
 * just the filtered list) is what the timeline's thread builder needs:
 * a duplicate root's session must attach its replies to the *kept*
 * root's thread, so the one visible user bubble collects the replies
 * from every fanned-out session.
 *
 * Same matching rule as {@link dedupeFanoutUserMessages}: identical
 * trimmed content, different session, within the fan-out window of the
 * kept occurrence. A dropped duplicate does not refresh the window —
 * later matches still compare against the kept original.
 */
export function resolveFanoutDuplicates<T extends FanoutDedupMessage>(rows: T[]): Map<T, T> {
  const lastSeen = new Map<string, { atMs: number; sessionId: string; row: T }>();
  const duplicateOf = new Map<T, T>();
  for (const row of rows) {
    if (row.role !== 'user') continue;
    const key = row.content.trim();
    const atMs = Date.parse(row.at);
    const prior = lastSeen.get(key);
    if (prior && prior.sessionId !== row.sessionId && atMs - prior.atMs <= FANOUT_DEDUP_WINDOW_MS) {
      duplicateOf.set(row, prior.row);
      continue;
    }
    lastSeen.set(key, { atMs, sessionId: row.sessionId, row });
  }
  return duplicateOf;
}

/**
 * Returns the rows that survive fan-out deduplication.
 *
 * Stable: a duplicate row is skipped, but the surrounding non-user /
 * cross-content rows keep their original chronological order.
 */
export function dedupeFanoutUserMessages<T extends FanoutDedupMessage>(rows: T[]): T[] {
  const duplicateOf = resolveFanoutDuplicates(rows);
  return rows.filter((row) => !duplicateOf.has(row));
}
