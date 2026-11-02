/**
 * Sign-in backoff. Each account name and each address gets five free
 * failures in a quarter hour; after that every further failure doubles the
 * wait, up to fifteen minutes. An install-wide ceiling stops a spread-out
 * guessing run that rotates names and addresses. In memory only: a restart
 * forgives everyone, which a person locked out by a typo will appreciate.
 */

const FREE_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const MAX_LOCK_MS = 15 * 60_000;
const INSTALL_CEILING_PER_MINUTE = 60;

interface Counter {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

export class SignInThrottle {
  private readonly counters = new Map<string, Counter>();
  private installWindowStart = 0;
  private installFailures = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds to wait before this name/address may try again, or 0. */
  retryAfterSeconds(name: string, address: string | undefined): number {
    const at = this.now();
    if (
      at - this.installWindowStart < 60_000 &&
      this.installFailures >= INSTALL_CEILING_PER_MINUTE
    ) {
      return Math.ceil((this.installWindowStart + 60_000 - at) / 1000);
    }
    let wait = 0;
    for (const key of this.keys(name, address)) {
      const counter = this.counters.get(key);
      if (counter && counter.lockedUntil > at) {
        wait = Math.max(wait, Math.ceil((counter.lockedUntil - at) / 1000));
      }
    }
    return wait;
  }

  recordFailure(name: string, address: string | undefined): void {
    const at = this.now();
    if (at - this.installWindowStart >= 60_000) {
      this.installWindowStart = at;
      this.installFailures = 0;
    }
    this.installFailures++;
    for (const key of this.keys(name, address)) {
      let counter = this.counters.get(key);
      if (!counter || at - counter.firstAt > WINDOW_MS) {
        counter = { failures: 0, firstAt: at, lockedUntil: 0 };
        this.counters.set(key, counter);
      }
      counter.failures++;
      if (counter.failures > FREE_FAILURES) {
        const lockMs = Math.min(MAX_LOCK_MS, 1000 * 2 ** (counter.failures - FREE_FAILURES - 1));
        counter.lockedUntil = at + lockMs;
      }
    }
    this.prune(at);
  }

  recordSuccess(name: string, address: string | undefined): void {
    for (const key of this.keys(name, address)) this.counters.delete(key);
  }

  private keys(name: string, address: string | undefined): string[] {
    const keys = [`name:${name.trim().toLowerCase()}`];
    if (address) keys.push(`addr:${address}`);
    return keys;
  }

  private prune(at: number): void {
    if (this.counters.size < 10_000) return;
    for (const [key, counter] of this.counters) {
      if (at - counter.firstAt > WINDOW_MS && counter.lockedUntil <= at) this.counters.delete(key);
    }
  }
}
