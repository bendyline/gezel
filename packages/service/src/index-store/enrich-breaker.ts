import { awakeNow, formatSuspension } from '@bendyline/gezel';
import { isCapacityDeniedError, isEngineBusyError } from '../providers/native/capacity-broker.js';

/**
 * Consecutive-timeout circuit breaker for the enrichment summarizer.
 *
 * The enrichment sweep walks files one at a time and issues a one-shot per
 * file. Nothing in that loop backs off: on a captured morning the sweep failed,
 * logged, and re-issued the next one-shot within 6 ms, over and over for four
 * hours. Each attempt woke a 284B model on a closed-lid MacBook, reheated the
 * SoC inside the dark-wake thermal envelope, and got the machine forced back to
 * sleep — which timed out the call it had just issued. The retry loop was the
 * thing sustaining the condition it was retrying against.
 *
 * A timeout streak means the target cannot serve right now, whatever the cause
 * — a suspended host, a wedged engine, a machine under thermal or memory
 * pressure. The honest response is to stop asking for a while. Only timeouts
 * count: a policy refusal or a parse failure is about the file, not the target,
 * and files already have their own capped-attempt gate.
 *
 * The cooldown is measured on the awake clock, so a machine that sleeps through
 * it comes back still backed off rather than treating a nap as recovery time.
 *
 * Backing off repeatedly is not the same as giving up, and a breaker that only
 * ever cycles will re-test a permanently unusable target until the window
 * closes. After {@link EnrichTimeoutBreakerOptions.standDownAfter} cooldowns
 * with nothing completed in between, it stands down until reset.
 */
/**
 * `unavailable` is the "never dispatched" arm: the pool refused to make room
 * because another engine was mid-turn, or refused the spawn outright because
 * the accelerator had no room left, so the request never reached a model. It
 * is evidence about neither the target nor the file, and must neither advance
 * the streak nor clear it — see {@link EnrichTimeoutBreaker.observe}.
 */
export type EnrichOutcome = 'ok' | 'timeout' | 'failed' | 'unavailable';

export interface EnrichTimeoutBreakerOptions {
  /** Consecutive timeouts that trip the breaker. */
  threshold?: number;
  /** Awake ms to stay open once tripped. */
  cooldownMs?: number;
  /**
   * Cooldowns that may elapse with no successful call in between before the
   * breaker stops re-testing at all. See {@link EnrichTimeoutBreaker.isStoodDown}.
   */
  standDownAfter?: number;
  /** Clock seam for tests; defaults to the awake clock. */
  now?: () => number;
  onOpen?: (detail: { streak: number; cooldownMs: number }) => void;
  onClose?: () => void;
  onStandDown?: (detail: { cycles: number }) => void;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
/**
 * Cooldown cycles before the breaker gives up for good. Four cycles of three
 * timeouts is upwards of forty minutes of asking — long enough that a slow
 * cold start, a single wedged turn, or a passing thermal excursion has been
 * given every chance, and short enough that a night of it does not go by.
 */
const DEFAULT_STAND_DOWN_AFTER = 4;

export class EnrichTimeoutBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly standDownAfter: number;
  private readonly onOpen?: (detail: { streak: number; cooldownMs: number }) => void;
  private readonly onClose?: () => void;
  private readonly onStandDown?: (detail: { cycles: number }) => void;
  private streak = 0;
  private openUntil = 0;
  private openCycles = 0;
  private stoodDown = false;

  constructor(opts: EnrichTimeoutBreakerOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? DEFAULT_THRESHOLD);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.standDownAfter = Math.max(1, opts.standDownAfter ?? DEFAULT_STAND_DOWN_AFTER);
    this.now = opts.now ?? awakeNow;
    if (opts.onOpen) this.onOpen = opts.onOpen;
    if (opts.onClose) this.onClose = opts.onClose;
    if (opts.onStandDown) this.onStandDown = opts.onStandDown;
  }

  observe(outcome: EnrichOutcome): void {
    // A call that never reached the target proves nothing either way. Left to
    // fall through as `failed` it would RESET a genuine timeout streak, and a
    // busy engine interleaving with a wedged one would keep the breaker from
    // ever tripping — the exact feedback loop this class exists to stop.
    if (outcome === 'unavailable') return;
    if (outcome !== 'timeout') {
      // Any completed call — even one that failed for a file-specific reason —
      // proves the target is answering, which is the whole question here. That
      // is also the only evidence that lifts a stand-down: the thing it was
      // waiting to learn just happened.
      const wasOpen = this.isOpen();
      this.streak = 0;
      this.openUntil = 0;
      this.openCycles = 0;
      this.stoodDown = false;
      if (wasOpen) this.onClose?.();
      return;
    }
    // Settle an elapsed cooldown BEFORE counting this timeout. `isOpen` is
    // what re-arms the streak, so testing it after the increment (the old
    // order) let the re-arm land between the count and the log: the breaker
    // reported "timed out 0x in a row" and re-opened on this single timeout,
    // skipping the threshold the re-arm had just restored.
    if (this.isOpen()) return;
    this.streak += 1;
    if (this.streak < this.threshold) return;
    this.openUntil = this.now() + this.cooldownMs;
    this.openCycles += 1;
    this.onOpen?.({ streak: this.streak, cooldownMs: this.cooldownMs });
    if (this.openCycles >= this.standDownAfter && !this.stoodDown) {
      this.stoodDown = true;
      this.onStandDown?.({ cycles: this.openCycles });
    }
  }

  isOpen(): boolean {
    if (this.stoodDown) return true;
    if (this.openUntil === 0) return false;
    if (this.now() < this.openUntil) return true;
    // Cooldown elapsed. Re-arm the streak too, so one more timeout does not
    // immediately re-trip a breaker that has not yet had a chance to succeed.
    this.openUntil = 0;
    this.streak = 0;
    this.onClose?.();
    return false;
  }

  /**
   * True once repeated cooldowns have gone by without a single completed call.
   * Cycling forever is its own failure mode: on a captured night two gezel
   * installs shared one 12 GB card, and the summarizer re-tested the same
   * oversubscribed GPU every seven minutes until morning, each attempt holding
   * an engine resident on a card that had no room for it. Past this point the
   * target is presumed unusable until something proves otherwise — a completed
   * call, or {@link reset} at the top of the next shift.
   */
  isStoodDown(): boolean {
    return this.stoodDown;
  }

  /** Awake ms left on the cooldown, for log lines. */
  remainingMs(): number {
    return this.openUntil === 0 ? 0 : Math.max(0, this.openUntil - this.now());
  }

  describe(): string {
    return formatSuspension(this.remainingMs());
  }

  reset(): void {
    this.streak = 0;
    this.openUntil = 0;
    this.openCycles = 0;
    this.stoodDown = false;
  }
}

/**
 * Classify a completion failure. Deliberately message-based: the one-shot path
 * stamps `TimeoutError`, but a provider-level timeout surfaces as a plain Error
 * whose message is the only durable marker (`[llama-cpp] timed out after 439s`,
 * `[Mac AI] timed out after 180s`).
 */
export function classifyEnrichFailure(err: unknown): EnrichOutcome {
  // Checked before the timeout arms: contention and a refused spawn are not a
  // slow target, and a drain refusal names a duration ("did not drain within
  // 30s") that a looser matcher could mistake for one.
  if (isEngineBusyError(err) || isCapacityDeniedError(err)) return 'unavailable';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  const message = err instanceof Error ? err.message : String(err);
  return /timed out after/i.test(message) ? 'timeout' : 'failed';
}
