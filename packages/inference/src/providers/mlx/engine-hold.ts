/**
 * Engine-side holds. The sidecar runs requests in waves and prints a
 * `waiting` marker for every request it is holding behind other work (and
 * `paused` for a background wave that stepped aside for a chat), from its
 * worker loop, every few seconds. Each one is proof the engine is alive and
 * busy, so the session re-arms whichever idle bound is live: a turn waiting
 * its turn is not a stall, however long the work ahead of it takes. Measured
 * before this: a 300-token question was labelled "Processing prompt" behind a
 * 55k-token re-prefill and aborted at 407s by the pre-first-byte bound without
 * ever starting. The turn's own deadline still bounds the whole wait.
 */
import type { EnginePhaseEvent } from '../streaming-session.js';

export type EngineQueueMarker = NonNullable<EnginePhaseEvent['engineQueue']>;

/**
 * How often a turn the engine is holding re-asserts the chat's "model queue"
 * notice. Inside the UI's freshness window (12s) so the notice holds steady
 * even when one engine step outlasts the sidecar's own marker cadence.
 */
const ENGINE_HOLD_NOTICE_REPEAT_MS = 5_000;

function othersAhead(queue: EngineQueueMarker): number {
  return Math.max(1, queue.behind?.length ?? 1) + (queue.ahead ?? 0);
}

/**
 * The pill's words for a request the engine is holding. Plain language: the
 * person needs to know their turn has not started and why, not which engine
 * phase it is in.
 */
export function engineHoldLabelFor(queue: EngineQueueMarker): string {
  if (queue.state === 'paused') return 'Paused while a chat goes first';
  const others = othersAhead(queue);
  return others === 1
    ? 'Waiting for another chat to finish'
    : `Waiting for ${others} other chats to finish`;
}

/**
 * One session's hold state before its first byte. While held, {@link label}
 * wins over the prefill heartbeat's label, which would otherwise keep calling
 * a queued turn "Processing prompt" — the label a person read for seven
 * minutes before the watchdog killed a turn that had never started.
 */
export class EngineHold {
  private heldLabel: string | null = null;
  private aheadOf = 0;
  private noticeTimer: ReturnType<typeof setInterval> | null = null;

  get label(): string | null {
    return this.heldLabel;
  }

  /**
   * Mark the request held and publish the queue notice. The chat bubble's
   * "model queue" state expires a few seconds after the last notice, and one
   * engine step can outlast that on a long prefill, so the notice is
   * re-asserted on a timer until {@link end}.
   */
  begin(queue: EngineQueueMarker, onQueueWait?: (info: { aheadOf: number }) => void): string {
    this.heldLabel = engineHoldLabelFor(queue);
    this.aheadOf = othersAhead(queue);
    const publish = () => onQueueWait?.({ aheadOf: this.aheadOf });
    publish();
    if (!this.noticeTimer) {
      this.noticeTimer = setInterval(publish, ENGINE_HOLD_NOTICE_REPEAT_MS);
      this.noticeTimer.unref?.();
    }
    return this.heldLabel;
  }

  end(): void {
    this.heldLabel = null;
    if (this.noticeTimer) clearInterval(this.noticeTimer);
    this.noticeTimer = null;
  }
}
