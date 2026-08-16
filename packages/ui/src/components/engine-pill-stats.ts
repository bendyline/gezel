/**
 * Pure telemetry helpers for the EngineStatusPill dropdown. Lives
 * here separately from `EngineStatusPill.tsx` so the unit test can
 * import the math without pulling in `api.ts` (which touches
 * `window` at module scope and isn't Node-safe).
 */

export interface TurnStatsEntry {
  /** Wall-clock at turn end, used for rolling-window filtering. */
  at: number;
  /** Model that generated the turn, when the daemon reported one. */
  model?: string;
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

/**
 * Per-model generation speed used to be tallied here, over the life of the
 * page. It now comes from the daemon's own usage record (`rollUpModelSpeeds`
 * in the service's chat/usage.ts, served on `/api/usage`): the question is
 * "how fast is this model on my machine", and the honest answer spans every
 * session the daemon has run, not the handful this browser tab witnessed.
 */

/**
 * Minimum decoding time before a live rate is worth showing. Under this
 * the sample is dominated by the first few chunks arriving in a burst
 * and the number swings wildly enough to look broken.
 */
const LIVE_RATE_MIN_ELAPSED_MS = 3_000;

/**
 * Live generation rate for the turn in flight, measured from the moment
 * the engine entered its generating phase — not from turn start, which
 * would fold a 30s prefill into the decode speed and report a third of
 * the real number.
 *
 * Returns null while the sample is too short to mean anything.
 */
export function computeLiveTokensPerSec(
  outputTokens: number,
  generatingSince: number,
  now: number,
): number | null {
  if (outputTokens <= 0) return null;
  const elapsedMs = now - generatingSince;
  if (!Number.isFinite(elapsedMs) || elapsedMs < LIVE_RATE_MIN_ELAPSED_MS) return null;
  return outputTokens / (elapsedMs / 1000);
}

/**
 * Best-effort live output-token count for providers that only publish their
 * exact usage in the terminal stream frame. The UI prefixes this value with
 * an approximation mark; the engine's exact counter still wins whenever its
 * phase detail already contains one.
 */
export function estimateLiveOutputTokens(outputChars: number): number {
  if (!Number.isFinite(outputChars) || outputChars <= 0) return 0;
  return Math.max(1, Math.round(outputChars / 4));
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
  /** In-flight slots in the provider request queue, all lanes. */
  running: number;
  /**
   * In-flight slots held by the interactive lane — i.e. live
   * conversations. Omit on a queue that predates the lane split and the
   * whole of `running` is treated as chat work, preserving the old copy.
   */
  runningInteractive?: number;
  /** Foreground turns waiting in the provider request queue. */
  interactive: number;
  /** Background work (memory extraction, auto-recall, fan-out) waiting. */
  background: number;
  /** Summed per-session backlog depth across conversations. */
  backlog: number;
}

export interface QueueStatusView {
  /** Chats waiting across both layers — drives the "+N" badge. */
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
  // Chats are the headline noun. A queue slot is not a conversation:
  // index enrichment, memory extraction and digests all occupy `running`
  // while zero humans are being talked to, which is how the Status line
  // came to read "1 running" against an empty inflight-turn registry.
  const chatsRunning = input.runningInteractive ?? input.running;
  const chatsQueued = input.interactive + input.backlog;
  const chores = Math.max(0, input.running - chatsRunning) + input.background;
  const waiting = chatsQueued;
  // Chores still light the pill — going quiet while the GPU decodes a
  // one-shot is the regression the background counts were folded in to
  // fix; they just never get to call themselves chats.
  const active = input.running > 0 || chatsQueued > 0 || input.background > 0;
  const parts: string[] = [];
  if (chatsRunning > 0) {
    parts.push(`${chatsRunning} ${chatsRunning === 1 ? 'chat' : 'chats'} running`);
  }
  if (chatsQueued > 0) {
    parts.push(
      chatsRunning > 0
        ? `${chatsQueued} queued`
        : `${chatsQueued} ${chatsQueued === 1 ? 'chat' : 'chats'} queued`,
    );
  }
  if (parts.length === 0 && chores > 0) parts.push('No chats');
  if (chores > 0) parts.push(`${chores} background ${chores === 1 ? 'job' : 'jobs'}`);
  const idleStatus = parts.length > 0 ? parts.join(' · ') : 'Idle — waiting for a message';
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
