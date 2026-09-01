/**
 * Fresh terminal work stays below chat work for a short grace period.
 *
 * Chat streaming rows normally sort after every persisted row. That makes
 * sense for a conversation, but it used to split a just-launched terminal
 * command from its live output: the persisted command jumped above a pending
 * chat row while the growing terminal output remained below it.
 */
export const TERMINAL_BOTTOM_GRACE_MS = 5 * 60 * 1000;

export type TimelineOrderKind = 'message' | 'streaming' | 'terminal' | 'terminal-streaming';

export interface TimelineOrderRow {
  kind: TimelineOrderKind;
  at: string;
}

export function terminalBottomGraceExpiresAt(at: string): number | undefined {
  const atMs = Date.parse(at);
  return Number.isFinite(atMs) ? atMs + TERMINAL_BOTTOM_GRACE_MS : undefined;
}

export function nextTerminalBottomGraceExpiry(
  entries: Iterable<{ at: string }>,
  nowMs: number,
): number | undefined {
  let next: number | undefined;
  for (const entry of entries) {
    const expiresAt = terminalBottomGraceExpiresAt(entry.at);
    if (expiresAt === undefined || expiresAt < nowMs) continue;
    if (next === undefined || expiresAt < next) next = expiresAt;
  }
  return next;
}

/**
 * Is this row in the bottom-most lane — live terminal output, or a
 * terminal command still inside its grace period?
 *
 * Exported because the active-thread pin has to stop above this lane:
 * hoisting a running command's output away from the command that
 * started it is the exact split {@link TERMINAL_BOTTOM_GRACE_MS} exists
 * to prevent.
 */
export function isTerminalBottomLane(row: { kind: string; at: string }, nowMs: number): boolean {
  if (row.kind === 'terminal-streaming') return true;
  if (row.kind !== 'terminal') return false;
  const expiresAt = terminalBottomGraceExpiresAt(row.at);
  return expiresAt !== undefined && nowMs <= expiresAt;
}

function timelineRowPriority(row: TimelineOrderRow, nowMs: number): number {
  if (isTerminalBottomLane(row, nowMs)) return 2;
  if (row.kind === 'streaming') return 1;
  return 0;
}

/**
 * Ascending timeline order with two live-work lanes:
 *
 *  1. persisted chat/history rows;
 *  2. active chat streaming rows;
 *  3. active terminal output and terminal rows still in their grace period.
 *
 * Timestamps remain the tie-breaker inside each lane.
 */
export function compareTimelineRows(
  a: TimelineOrderRow,
  b: TimelineOrderRow,
  nowMs: number,
): number {
  const priorityDelta = timelineRowPriority(a, nowMs) - timelineRowPriority(b, nowMs);
  if (priorityDelta !== 0) return priorityDelta;
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}
