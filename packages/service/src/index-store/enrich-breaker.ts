import { awakeNow, formatSuspension } from '@bendyline/gezel';

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
 */
export type EnrichOutcome = 'ok' | 'timeout' | 'failed';

export interface EnrichTimeoutBreakerOptions {
  /** Consecutive timeouts that trip the breaker. */
  threshold?: number;
  /** Awake ms to stay open once tripped. */
  cooldownMs?: number;
  /** Clock seam for tests; defaults to the awake clock. */
  now?: () => number;
  onOpen?: (detail: { streak: number; cooldownMs: number }) => void;
  onClose?: () => void;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

export class EnrichTimeoutBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onOpen?: (detail: { streak: number; cooldownMs: number }) => void;
  private readonly onClose?: () => void;
  private streak = 0;
  private openUntil = 0;

  constructor(opts: EnrichTimeoutBreakerOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? DEFAULT_THRESHOLD);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.now = opts.now ?? awakeNow;
    if (opts.onOpen) this.onOpen = opts.onOpen;
    if (opts.onClose) this.onClose = opts.onClose;
  }

  observe(outcome: EnrichOutcome): void {
    if (outcome !== 'timeout') {
      // Any completed call — even one that failed for a file-specific reason —
      // proves the target is answering, which is the whole question here.
      const wasOpen = this.isOpen();
      this.streak = 0;
      this.openUntil = 0;
      if (wasOpen) this.onClose?.();
      return;
    }
    this.streak += 1;
    if (this.streak < this.threshold || this.isOpen()) return;
    this.openUntil = this.now() + this.cooldownMs;
    this.onOpen?.({ streak: this.streak, cooldownMs: this.cooldownMs });
  }

  isOpen(): boolean {
    if (this.openUntil === 0) return false;
    if (this.now() < this.openUntil) return true;
    // Cooldown elapsed. Re-arm the streak too, so one more timeout does not
    // immediately re-trip a breaker that has not yet had a chance to succeed.
    this.openUntil = 0;
    this.streak = 0;
    this.onClose?.();
    return false;
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
  }
}

/**
 * Classify a completion failure. Deliberately message-based: the one-shot path
 * stamps `TimeoutError`, but a provider-level timeout surfaces as a plain Error
 * whose message is the only durable marker (`[llama-cpp] timed out after 439s`,
 * `[Mac AI] timed out after 180s`).
 */
export function classifyEnrichFailure(err: unknown): EnrichOutcome {
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  const message = err instanceof Error ? err.message : String(err);
  return /timed out after/i.test(message) ? 'timeout' : 'failed';
}
