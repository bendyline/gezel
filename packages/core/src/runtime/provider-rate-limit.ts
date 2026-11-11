/**
 * Provider rate limits: an error type for a turn the provider refused, and a
 * governor that narrows a provider's queue while it refuses.
 *
 * A cloud model service answers a burst it will not serve with HTTP 429.
 * Without backpressure every turn in a full-width batch keeps asking, each
 * refusal resets the service's window, and the batch makes almost no
 * progress. Codex CLI makes this worse by retrying a 429 quietly: its turns
 * show no output for minutes and are then killed by the turn budget as if
 * they had hung (2026-11-10: an account held to ~5 requests/minute turned 40
 * concurrent media reviews into 180 s timeouts).
 *
 * {@link RateLimitGovernor} is additive-increase / multiplicative-decrease
 * over {@link ProviderQueue.throttle}:
 *   - each refusal halves the admission limit (at most once per
 *     `decreaseSpacingMs`, so one burst of simultaneous refusals counts once)
 *     and holds new dispatch for the provider's retry-after, or `holdMs`;
 *   - once refusals have stopped for `recoveryDelayMs`, each turn that
 *     finishes unrefused adds one slot (at most once per
 *     `increaseSpacingMs`) until the configured caps return, and the
 *     throttle is lifted.
 *
 * Providers own the signals: they call {@link RateLimitGovernor.rateLimited}
 * when the service refuses a request (even one the provider retries itself)
 * and {@link RateLimitGovernor.succeeded} when a turn completes without a
 * refusal. A turn that finally fails on a refusal rejects with
 * {@link ProviderRateLimitError}, so callers can wait for capacity instead of
 * spending their bounded recovery on a provider that is only saying "slower".
 *
 * Related: provider-queue.ts (the throttle it drives); the Codex CLI provider
 * (service/src/providers/codex-cli) is the first signal source.
 */

import type { ProviderQueue } from './provider-queue.js';

/**
 * A turn the model service refused for rate (HTTP 429), as opposed to one
 * that failed. Matched by name as well as class, so a copy from another
 * bundle of this package is still recognized.
 */
export class ProviderRateLimitError extends Error {
  readonly rateLimited = true as const;
  /** Provider's suggested wait, when it gave one. */
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ProviderRateLimitError';
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isProviderRateLimitError(err: unknown): err is ProviderRateLimitError {
  return (
    err instanceof ProviderRateLimitError ||
    (err instanceof Error && err.name === 'ProviderRateLimitError')
  );
}

export interface RateLimitGovernorState {
  /** Admission limit in force, or undefined at the configured caps. */
  limit: number | undefined;
  /** What changed: a refusal narrowed it, a clean turn widened it, or it lifted. */
  change: 'narrowed' | 'held' | 'widened' | 'lifted';
  detail?: string;
}

export interface RateLimitGovernorOptions {
  /** Lowest admission limit. Default 1. */
  minLimit?: number;
  /** Refusals closer together than this halve the limit once. Default 30 s. */
  decreaseSpacingMs?: number;
  /** Dispatch hold after a refusal without a retry-after. Default 30 s. */
  holdMs?: number;
  /** Longest hold a provider's retry-after may ask for. Default 2 min. */
  maxHoldMs?: number;
  /** Quiet time after the last refusal before widening starts. Default 60 s. */
  recoveryDelayMs?: number;
  /** At most one extra slot per this interval while widening. Default 10 s. */
  increaseSpacingMs?: number;
  /** Notified on every change, for logging. */
  onChange?: (state: RateLimitGovernorState) => void;
  /** Injectable clock; defaults to the queue's. */
  now?: () => number;
}

export class RateLimitGovernor {
  private current: number | undefined;
  private lastRefusalAt = Number.NEGATIVE_INFINITY;
  private lastDecreaseAt = Number.NEGATIVE_INFINITY;
  private lastIncreaseAt = Number.NEGATIVE_INFINITY;
  private readonly minLimit: number;
  private readonly decreaseSpacingMs: number;
  private readonly holdMs: number;
  private readonly maxHoldMs: number;
  private readonly recoveryDelayMs: number;
  private readonly increaseSpacingMs: number;
  private readonly onChange: ((state: RateLimitGovernorState) => void) | undefined;
  private readonly now: () => number;

  constructor(
    private readonly queue: ProviderQueue,
    opts: RateLimitGovernorOptions = {},
  ) {
    this.minLimit = Math.max(1, Math.floor(opts.minLimit ?? 1));
    this.decreaseSpacingMs = opts.decreaseSpacingMs ?? 30_000;
    this.holdMs = opts.holdMs ?? 30_000;
    this.maxHoldMs = opts.maxHoldMs ?? 120_000;
    this.recoveryDelayMs = opts.recoveryDelayMs ?? 60_000;
    this.increaseSpacingMs = opts.increaseSpacingMs ?? 10_000;
    this.onChange = opts.onChange;
    this.now = opts.now ?? (() => queue.currentTime());
  }

  /** Admission limit in force, or undefined at the configured caps. */
  get limit(): number | undefined {
    return this.current;
  }

  /**
   * The service refused a request. Narrows the queue (once per spacing) and
   * holds new dispatch for the retry-after, so work already running gets the
   * service's attention first.
   */
  rateLimited(info: { retryAfterMs?: number; detail?: string } = {}): void {
    const now = this.now();
    this.lastRefusalAt = now;
    const hold = Math.min(this.maxHoldMs, Math.max(0, info.retryAfterMs ?? this.holdMs));
    const reason = info.detail ?? 'provider is rate limiting (429)';
    if (now - this.lastDecreaseAt < this.decreaseSpacingMs) {
      this.queue.throttle({ holdUntil: now + hold, reason });
      this.onChange?.({ limit: this.current, change: 'held', detail: reason });
      return;
    }
    // Halve what is actually in flight, not the configured width: a refusal
    // with three turns running says three is too many, not twenty.
    const inFlight = this.queue.snapshot().running;
    const from = this.current ?? Math.min(this.queue.concurrency, Math.max(1, inFlight));
    this.current = Math.max(this.minLimit, Math.floor(from / 2));
    this.lastDecreaseAt = now;
    this.queue.throttle({ limit: this.current, holdUntil: now + hold, reason });
    this.onChange?.({ limit: this.current, change: 'narrowed', detail: reason });
  }

  /** A turn finished without a refusal. Widens once the refusals have stopped. */
  succeeded(): void {
    if (this.current === undefined) return;
    const now = this.now();
    if (now - this.lastRefusalAt < this.recoveryDelayMs) return;
    if (now - this.lastIncreaseAt < this.increaseSpacingMs) return;
    this.lastIncreaseAt = now;
    const next = this.current + 1;
    if (next >= this.queue.concurrency) {
      this.current = undefined;
      this.queue.clearThrottle();
      this.onChange?.({ limit: undefined, change: 'lifted' });
      return;
    }
    this.current = next;
    this.queue.throttle({ limit: next });
    this.onChange?.({ limit: next, change: 'widened' });
  }
}
