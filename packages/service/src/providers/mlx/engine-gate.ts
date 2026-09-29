import { createLogger } from '@bendyline/gezel';
import { QUEUE_WAIT_NOTICE_DELAY_MS, QUEUE_WAIT_NOTICE_REPEAT_MS } from '../queue.js';

const log = createLogger('mlx');

interface EngineGateWaiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Width-N gate over actual engine requests. The width is the engine's batch
 * capability (`batchMaxConcurrency`). At width 1 this is strict FIFO with one
 * HTTP request in flight, while the sidecar still uses its snapshot-capable
 * BatchGenerator internally. A wider gate lets up to N requests reach the
 * sidecar for one static batched wave.
 */
export class MlxEngineGate {
  private active = 0;
  private readonly waiters: EngineGateWaiter[] = [];

  constructor(readonly width: number) {}

  /** True while a physical request is being served or is queued for a slot. */
  get busy(): boolean {
    return this.active > 0 || this.waiters.length > 0;
  }

  async acquire(
    label: string,
    signal?: AbortSignal,
    onWait?: (info: { aheadOf: number }) => void,
  ): Promise<() => void> {
    const width = this.width;
    const waitStartedAt = Date.now();
    if (this.active < width) {
      this.active++;
    } else {
      // Park FIFO until a release hands us its slot. The active count
      // stays at `width` across the handoff, so we never exceed it — at
      // Width 1 is a strict provider-side FIFO; the sidecar still uses its
      // singleton BatchGenerator path for cache snapshots.
      let waitNotice: ReturnType<typeof setInterval> | null = null;
      let waitNoticeDelay: ReturnType<typeof setTimeout> | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          const waiter: EngineGateWaiter = {
            resolve,
            reject,
            ...(signal ? { signal } : {}),
          };
          if (signal) {
            waiter.onAbort = () => {
              const idx = this.waiters.indexOf(waiter);
              if (idx === -1) return;
              this.waiters.splice(idx, 1);
              signal.removeEventListener('abort', waiter.onAbort!);
              reject(new DOMException(`MLX engine request ${label} aborted`, 'AbortError'));
            };
            signal.addEventListener('abort', waiter.onAbort, { once: true });
          }
          this.waiters.push(waiter);
          // Announce the park. Same reasoning as the llama.cpp gate: a turn
          // that already cleared the ProviderQueue can still wait here for
          // the length of another session's round-trip, and a wait with no
          // signal reads to the user as a wedged model.
          if (onWait) {
            const publish = () => {
              const idx = this.waiters.indexOf(waiter);
              if (idx === -1) return;
              onWait({ aheadOf: this.active + idx });
            };
            waitNoticeDelay = setTimeout(() => {
              publish();
              waitNotice = setInterval(publish, QUEUE_WAIT_NOTICE_REPEAT_MS);
              waitNotice.unref?.();
            }, QUEUE_WAIT_NOTICE_DELAY_MS);
            waitNoticeDelay.unref?.();
          }
        });
      } finally {
        if (waitNoticeDelay) clearTimeout(waitNoticeDelay);
        if (waitNotice) clearInterval(waitNotice);
      }
    }
    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs > 1_000) {
      log.debug(`engine request ${label} waited ${waitedMs}ms for an MLX engine slot`);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        // Hand our slot straight to the next waiter — active count unchanged.
        next.resolve();
      } else {
        this.active--;
      }
    };
  }

  /**
   * Every slot at once, for work that must not overlap any request — an
   * engine reload. The N claims are queued back to back in one synchronous
   * pass, so requests already waiting are served first and nothing queued
   * later can slip in between two of them.
   */
  async acquireAll(label: string): Promise<() => void> {
    const releases = await Promise.all(
      Array.from({ length: this.width }, (_, i) => this.acquire(`${label}:${i + 1}/${this.width}`)),
    );
    return () => {
      for (const release of releases) release();
    };
  }
}
