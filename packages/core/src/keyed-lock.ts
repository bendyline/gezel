/**
 * Serialize async work per string key.
 *
 * This is the one blessed implementation of the promise-chain lock the
 * service used to hand-roll per module. Two invariants are load-bearing and
 * were each independently gotten wrong by copies of this idiom:
 *
 * - The promise HELD in the map must never reject. Both daemon entrypoints
 *   treat an unhandled rejection as fatal (gezeld exits, the Electron shell
 *   shows the final-error dialog and quits), and a rejected lock tail that
 *   nobody awaits is exactly that — a failing disk write inside a locked
 *   section must surface only to the caller, never as a second, unowned
 *   rejection from the chain. Callers still see `run`'s promise reject.
 * - The settle cleanup must identity-compare against the promise actually
 *   stored. Comparing against an earlier link in the chain can never match,
 *   which retains one settled entry per key for the process lifetime.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<undefined>>();

  /** Number of keys with running or queued work. Diagnostics and tests. */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Run `fn` once all work previously enqueued for `key` has settled —
   * including work that failed, so one rejection never poisons the queue
   * behind it. Returns `fn`'s result; its rejection reaches only this
   * caller. Different keys never wait on each other.
   */
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve(undefined);
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /**
   * Settles when everything queued at call time has settled. Never rejects.
   * Work enqueued after the call is not waited on — shutdown paths want a
   * snapshot, not a moving target.
   */
  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
