import { createLogger } from '@bendyline/gezel';
import { QUEUE_WAIT_NOTICE_DELAY_MS, QUEUE_WAIT_NOTICE_REPEAT_MS } from '../queue.js';

const log = createLogger('mlx');

/** Who is waiting on an engine request — see `SendAndWaitOpts.queue.enginePriority`. */
export type EngineRequestPriority = 'interactive' | 'background';

interface EngineGateWaiter {
  priority: EngineRequestPriority;
  resolve: (slot: 'normal' | 'overflow') => void;
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
 *
 * Interactive requests (a person is waiting) are handed slots before
 * background ones, and get ONE slot beyond the width when every request in
 * flight is background. The sidecar parks a wave of background work for a
 * waiting interactive request (python/wave_policy.py), but only a request
 * that reached it can be served that way: with every slot held by task
 * steps, a person's message used to wait here, invisible to the engine,
 * until a whole task turn finished. The overflow never adds a concurrent
 * generation — the parked wave is suspended while the interactive one runs —
 * and the sidecar still refuses to park when live memory is tight.
 */
export class MlxEngineGate {
  private normal = 0;
  private overflow = 0;
  private interactiveHeld = 0;
  private readonly waiters: EngineGateWaiter[] = [];
  /** Exclusive claims ({@link acquireAll}) in progress; they close the overflow slot. */
  private exclusivePending = 0;
  private overflowDrained: Array<() => void> = [];

  constructor(readonly width: number) {}

  /** True while a physical request is being served or is queued for a slot. */
  get busy(): boolean {
    return this.normal + this.overflow > 0 || this.waiters.length > 0;
  }

  private slotFor(priority: EngineRequestPriority): 'normal' | 'overflow' | null {
    if (this.normal < this.width) return 'normal';
    if (
      priority === 'interactive' &&
      this.overflow === 0 &&
      this.interactiveHeld === 0 &&
      this.exclusivePending === 0
    ) {
      return 'overflow';
    }
    return null;
  }

  private take(slot: 'normal' | 'overflow', priority: EngineRequestPriority): void {
    if (slot === 'normal') this.normal++;
    else this.overflow++;
    if (priority === 'interactive') this.interactiveHeld++;
  }

  /** Grant every waiter the rules now allow, interactive first, FIFO within a priority. */
  private drain(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const waiter = this.waiters[i]!;
      const slot = this.slotFor(waiter.priority);
      if (!slot) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.take(slot, waiter.priority);
      waiter.resolve(slot);
    }
  }

  private enqueue(waiter: EngineGateWaiter): void {
    if (waiter.priority === 'background') {
      this.waiters.push(waiter);
      return;
    }
    const firstBackground = this.waiters.findIndex((w) => w.priority === 'background');
    if (firstBackground === -1) this.waiters.push(waiter);
    else this.waiters.splice(firstBackground, 0, waiter);
  }

  async acquire(
    label: string,
    signal?: AbortSignal,
    onWait?: (info: { aheadOf: number }) => void,
    priority: EngineRequestPriority = 'interactive',
  ): Promise<() => void> {
    const waitStartedAt = Date.now();
    let slot = this.waiters.length === 0 ? this.slotFor(priority) : null;
    // Waiters ahead in priority order keep their place: a newcomer may only
    // skip the line through the overflow slot, which no waiter ahead of it
    // could have used.
    if (
      !slot &&
      priority === 'interactive' &&
      !this.waiters.some((w) => w.priority === 'interactive')
    ) {
      const overflow = this.slotFor('interactive');
      if (overflow === 'overflow') slot = overflow;
    }
    if (slot) {
      this.take(slot, priority);
    } else {
      let waitNotice: ReturnType<typeof setInterval> | null = null;
      let waitNoticeDelay: ReturnType<typeof setTimeout> | null = null;
      try {
        slot = await new Promise<'normal' | 'overflow'>((resolve, reject) => {
          const waiter: EngineGateWaiter = {
            priority,
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
          this.enqueue(waiter);
          // Announce the park. Same reasoning as the llama.cpp gate: a turn
          // that already cleared the ProviderQueue can still wait here for
          // the length of another session's round-trip, and a wait with no
          // signal reads to the user as a wedged model.
          if (onWait) {
            const publish = () => {
              const idx = this.waiters.indexOf(waiter);
              if (idx === -1) return;
              onWait({ aheadOf: this.normal + this.overflow + idx });
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
    if (slot === 'overflow') {
      log.info(
        `engine request ${label} took the interactive overflow slot — every slot was held by background work`,
      );
    }
    const held = slot;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (held === 'normal') this.normal--;
      else this.overflow--;
      if (priority === 'interactive') this.interactiveHeld--;
      if (held === 'overflow' && this.overflow === 0) {
        const drained = this.overflowDrained;
        this.overflowDrained = [];
        for (const resolve of drained) resolve();
      }
      this.drain();
    };
  }

  /**
   * Every slot at once, for work that must not overlap any request — an
   * engine reload. The N claims are queued back to back in one synchronous
   * pass, so interactive requests already waiting are served first and
   * nothing queued later can slip in between two of them. A reload is made
   * for a person's request (an image to look at), so its claims rank as
   * interactive: background work already waiting goes after it. The
   * overflow slot is closed for the duration and drained before this
   * resolves.
   */
  async acquireAll(label: string): Promise<() => void> {
    this.exclusivePending++;
    let releases: Array<() => void>;
    try {
      releases = await Promise.all(
        Array.from({ length: this.width }, (_, i) =>
          this.acquire(`${label}:${i + 1}/${this.width}`, undefined, undefined, 'interactive'),
        ),
      );
      if (this.overflow > 0) {
        await new Promise<void>((resolve) => this.overflowDrained.push(resolve));
      }
    } catch (err) {
      this.exclusivePending--;
      throw err;
    }
    return () => {
      this.exclusivePending--;
      for (const release of releases) release();
    };
  }
}
