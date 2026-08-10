/**
 * Pure telemetry helpers for the EngineStatusPill dropdown. Lives
 * here separately from `EngineStatusPill.tsx` so the unit test can
 * import the math without pulling in `api.ts` (which touches
 * `window` at module scope and isn't Node-safe).
 */

export interface TurnStatsEntry {
  /** Wall-clock at turn end, used for rolling-window filtering. */
  at: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  tokensPerSec?: number;
}

/**
 * Rolling-average tokens/sec across the entries still inside the
 * 60s window. Aggregates by total tokens / total generation seconds
 * rather than averaging per-turn rates — that way a long slow turn
 * isn't weighted the same as a short fast one. Returns null when we
 * haven't seen enough data (no turns, or none with valid
 * tokensPerSec).
 */
export function computeRollingTokensPerSec(entries: TurnStatsEntry[]): number | null {
  let totalTokens = 0;
  let totalSec = 0;
  for (const e of entries) {
    if (e.tokensPerSec === undefined || e.tokensPerSec <= 0) continue;
    // Back out generation seconds from the rate + completion tokens.
    // This matches how the service computed tokensPerSec in the first
    // place, so we stay consistent even if a provider used
    // wall-clock vs. native generation duration.
    const genSec = e.completionTokens / e.tokensPerSec;
    if (!Number.isFinite(genSec) || genSec <= 0) continue;
    totalTokens += e.completionTokens;
    totalSec += genSec;
  }
  if (totalSec <= 0 || totalTokens <= 0) return null;
  return totalTokens / totalSec;
}

export function formatTokensPerSec(rate: number): string {
  if (rate >= 10) return `${rate.toFixed(0)} tok/s`;
  return `${rate.toFixed(1)} tok/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // RAM and VRAM are sold as e.g. "24 GB" and "128 GB" even though their
  // capacities are binary-sized. Use the same familiar labels while keeping
  // binary math so every engine figure compares directly with that hardware.
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Inputs for the queue-aware status/badge composition. The pill draws
 * from two independent queue layers:
 *   - the provider request queue (`running` / `interactive` /
 *     `background`), and
 *   - the per-session backlog (`backlog`) — messages queued behind an
 *     in-flight turn within a single conversation.
 * A chat the user "enqueued" usually lands in `backlog`, so any view
 * that ignores it (the old pill did) under-reports work and can read
 * "Idle" while chats wait.
 */
export interface QueueStatusInput {
  /** In-flight slots in the provider request queue. */
  running: number;
  /** Foreground turns waiting in the provider request queue. */
  interactive: number;
  /** Background work (memory extraction, auto-recall, fan-out) waiting. */
  background: number;
  /** Summed per-session backlog depth across conversations. */
  backlog: number;
}

export interface QueueStatusView {
  /** Total items waiting across both layers — drives the "+N" badge. */
  waiting: number;
  /** True when anything is in flight or waiting — drives busy styling. */
  active: boolean;
  /** Popover Status line when no turn is actively generating. */
  idleStatus: string;
  /** Popover Queue-row breakdown, empty when nothing is running/waiting. */
  queueRow: string;
}

/**
 * Collapse the two queue layers into the numbers + strings the pill
 * renders. Pure so it can be unit-tested without a React/DOM harness
 * (the component still owns the in-flight "generating" label, which
 * comes from the live SSE phase, not from queue counts).
 */
export function composeQueueStatus(input: QueueStatusInput): QueueStatusView {
  const pending = input.interactive + input.background;
  const waiting = pending + input.backlog;
  const active = input.running > 0 || waiting > 0;
  const idleStatus =
    input.running > 0 || waiting > 0
      ? [
          input.running > 0 ? `${input.running} running` : null,
          waiting > 0 ? `${waiting} queued` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Idle — waiting for a message';
  const queueRow = [
    input.running > 0 ? `${input.running} running` : null,
    input.interactive > 0 ? `${input.interactive} interactive` : null,
    input.background > 0 ? `${input.background} background` : null,
    input.backlog > 0 ? `${input.backlog} chat${input.backlog === 1 ? '' : 's'} waiting` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return { waiting, active, idleStatus, queueRow };
}
