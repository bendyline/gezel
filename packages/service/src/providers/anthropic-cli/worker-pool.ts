import { createLogger } from '@bendyline/gezel';
import {
  ClaudeWorker,
  type ClaudeWorkerOpts,
  type SendTurnOpts,
  type WorkerTurnHooks,
} from './worker.js';

const log = createLogger('anthropic-cli');

/**
 * Per-turn spec the pool needs from the session class. Same shape as
 * `ClaudeWorkerOpts` but without the pool-owned bits (idle timer, lifecycle
 * callbacks, test seams) — those are filled in by the pool.
 */
export type ClaudeWorkerSpec = Omit<
  ClaudeWorkerOpts,
  'idleTimeoutMs' | 'onIdleEvict' | 'onCrash' | 'spawnImpl' | 'now'
>;

export type WorkerFactory = (opts: ClaudeWorkerOpts) => ClaudeWorker;

/**
 * Captures the state needed to telemetry-snapshot the pool. Exposed via
 * `ClaudeWorkerPool.snapshot()` for future debugging surfaces (mirrors
 * `ProviderQueue.snapshot()`).
 */
export interface PoolSnapshot {
  size: number;
  workers: Array<{
    sessionId: string;
    idle: boolean;
    alive: boolean;
    lastUsedAt: number;
    claudeSessionId: string | null;
  }>;
}

export interface ClaudeWorkerPoolOpts {
  /** Max concurrent warm workers. Default 4. */
  poolSize: number;
  /** Worker idle timeout in milliseconds. Default 600_000 (10 min). */
  workerIdleMs: number;
  /** Test seam — defaults to `new ClaudeWorker(opts)`. */
  factory?: WorkerFactory;
  /**
   * Concurrency cap reported by the surrounding `ProviderQueue`. When
   * concurrency > poolSize, every-worker-busy is possible and the pool
   * has to fall back to a wait loop. We log a warning on construction
   * so operators see the misconfiguration.
   */
  providerConcurrency?: number;
}

/**
 * Session-affinitized pool of long-lived `claude` subprocesses.
 *
 * Every chat session gets at most one worker. Turn requests for a session
 * are routed to its existing worker; on miss, a fresh worker is spawned,
 * evicting the least-recently-used non-busy worker first when the pool is
 * at capacity.
 *
 * The pool does NOT serialize turns — that's the surrounding
 * `ProviderQueue`'s job. The pool just owns subprocess lifecycle and
 * affinity. A worker handles one turn at a time (Claude is sequential), so
 * routing two simultaneous turns to the same `sessionId` would race on the
 * worker; we don't enforce this at the pool layer because the
 * per-`ChatSession` queueing in `ChatManager.pendingSends` already
 * guarantees one in-flight turn per session.
 */
export class ClaudeWorkerPool {
  private readonly workers = new Map<string, ClaudeWorker>();
  /** Most-recently-used at the front, least at the back. */
  private readonly lru: string[] = [];
  private readonly factory: WorkerFactory;
  private readonly poolSize: number;
  private readonly workerIdleMs: number;
  private shuttingDown = false;

  constructor(opts: ClaudeWorkerPoolOpts) {
    this.poolSize = Math.max(1, opts.poolSize);
    this.workerIdleMs = Math.max(0, opts.workerIdleMs);
    this.factory = opts.factory ?? ((workerOpts) => new ClaudeWorker(workerOpts));
    if (typeof opts.providerConcurrency === 'number' && opts.providerConcurrency > this.poolSize) {
      log.warn(
        `[anthropic-cli/pool] providerConcurrency (${opts.providerConcurrency}) > poolSize (${this.poolSize}); parallel turns may have to wait for a worker to free up.`,
      );
    }
  }

  size(): number {
    return this.workers.size;
  }

  snapshot(): PoolSnapshot {
    const workers: PoolSnapshot['workers'] = [];
    for (const [sessionId, worker] of this.workers) {
      workers.push({
        sessionId,
        idle: worker.idle(),
        alive: worker.isAlive(),
        lastUsedAt: worker.lastUsedAt(),
        claudeSessionId: worker.claudeSessionId(),
      });
    }
    return { size: this.workers.size, workers };
  }

  /**
   * Get-or-create a worker for `spec.context.sessionId`, then run one turn
   * on it. Resolves with the assistant text. The pool does not retry on
   * crash — the caller (`AnthropicCliSession`) bubbles errors verbatim.
   */
  async runTurn(
    spec: ClaudeWorkerSpec,
    prompt: string,
    hooks: WorkerTurnHooks,
    sendOpts?: SendTurnOpts,
  ): Promise<string> {
    if (this.shuttingDown) {
      throw new Error('[anthropic-cli/pool] pool is shutting down');
    }
    const sessionId = spec.context.sessionId;

    const worker = await this.acquire(sessionId, spec);
    try {
      return await worker.sendTurn(prompt, hooks, sendOpts);
    } catch (err) {
      // If the worker is now dead (turn crashed it), drop it from the pool
      // so the next turn for this session spawns fresh.
      if (!worker.isAlive()) {
        this.dropFromPool(sessionId, worker);
      }
      throw err;
    }
  }

  /**
   * Forcibly evict a session's worker and shut it down. Called by
   * `AnthropicCliSession.disconnect()` and by LRU eviction.
   */
  async evict(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (!worker) return;
    this.dropFromPool(sessionId, worker);
    try {
      await worker.shutdown();
    } catch (err) {
      log.warn(`[anthropic-cli/pool] evict(${sessionId}) shutdown error:`, err);
    }
  }

  /** Tear down every worker. Used by `AnthropicCliProvider.shutdown()`. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const all = Array.from(this.workers.values());
    this.workers.clear();
    this.lru.length = 0;
    await Promise.all(
      all.map((w) =>
        w.shutdown().catch((err) => {
          log.warn('[anthropic-cli/pool] shutdown worker error:', err);
        }),
      ),
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async acquire(sessionId: string, spec: ClaudeWorkerSpec): Promise<ClaudeWorker> {
    const existing = this.workers.get(sessionId);
    if (existing) {
      if (existing.isAlive()) {
        this.touchLRU(sessionId);
        return existing;
      }
      // Stale entry — worker crashed since last turn. Drop and respawn,
      // preserving any captured Claude session id so we can `--resume`.
      const captured = existing.claudeSessionId() ?? spec.initialResumeId;
      this.dropFromPool(sessionId, existing);
      // Don't await shutdown of a crashed worker — already dead.
      void existing.shutdown().catch(() => {});
      return this.spawn(sessionId, { ...spec, initialResumeId: captured });
    }

    if (this.workers.size >= this.poolSize) {
      await this.evictLRU();
    }
    return this.spawn(sessionId, spec);
  }

  private async spawn(sessionId: string, spec: ClaudeWorkerSpec): Promise<ClaudeWorker> {
    const worker = this.factory({
      ...spec,
      idleTimeoutMs: this.workerIdleMs,
      onIdleEvict: () => {
        // Worker self-evicting due to idle timer. Detach from the pool;
        // the worker will shut itself down via the pool's evict call.
        const current = this.workers.get(sessionId);
        if (current === worker) {
          void this.evict(sessionId);
        }
      },
      onCrash: () => {
        // Worker observed an unexpected exit. Drop it; next runTurn for
        // this session will respawn with `--resume`.
        const current = this.workers.get(sessionId);
        if (current === worker) {
          this.dropFromPool(sessionId, worker);
        }
      },
    });
    this.workers.set(sessionId, worker);
    this.touchLRU(sessionId);
    try {
      await worker.start();
    } catch (err) {
      // Spawn failed (resume failure / startup timeout / spawn-syscall
      // error). Drop the entry so a retry creates a fresh one. The error
      // bubbles up to the session class.
      this.dropFromPool(sessionId, worker);
      throw err;
    }
    return worker;
  }

  /**
   * Find the LRU worker that is not currently mid-turn and shut it down.
   * If every worker is busy, do nothing — the new turn will end up
   * waiting for a worker to free up via the standard `acquire` path on
   * the next attempt. (This only matters when provider concurrency
   * exceeds pool size, which we warn about at construction.)
   */
  private async evictLRU(): Promise<void> {
    // Walk from the back (LRU) forward; pick the first non-busy.
    for (let i = this.lru.length - 1; i >= 0; i--) {
      const sessionId = this.lru[i]!;
      const worker = this.workers.get(sessionId);
      if (!worker) {
        // Stale LRU entry — clean up.
        this.lru.splice(i, 1);
        continue;
      }
      if (worker.idle() || !worker.isAlive()) {
        await this.evict(sessionId);
        return;
      }
    }
    // All workers are busy. Wait briefly for one to become idle, then
    // try again. We cap the wait at 30s to avoid hanging forever; if
    // nothing frees up, we let the new spawn proceed at over-cap (better
    // than blocking the user). This is a degenerate config — the
    // construction-time warning fires when providerConcurrency > poolSize.
    await this.waitForIdleSlot(30_000);
    for (let i = this.lru.length - 1; i >= 0; i--) {
      const sessionId = this.lru[i]!;
      const worker = this.workers.get(sessionId);
      if (!worker) {
        this.lru.splice(i, 1);
        continue;
      }
      if (worker.idle() || !worker.isAlive()) {
        await this.evict(sessionId);
        return;
      }
    }
    // Still all busy — let the caller spawn anyway. Going over poolSize
    // by one transient slot is preferable to hanging the user's turn.
    log.warn('[anthropic-cli/pool] LRU eviction: all workers busy; allowing transient over-cap.');
  }

  private waitForIdleSlot(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (Date.now() - start >= timeoutMs) return resolve();
        for (const worker of this.workers.values()) {
          if (worker.idle() || !worker.isAlive()) return resolve();
        }
        setTimeout(tick, 100).unref?.();
      };
      tick();
    });
  }

  private dropFromPool(sessionId: string, worker: ClaudeWorker): void {
    const current = this.workers.get(sessionId);
    if (current !== worker) return;
    this.workers.delete(sessionId);
    const idx = this.lru.indexOf(sessionId);
    if (idx >= 0) this.lru.splice(idx, 1);
  }

  private touchLRU(sessionId: string): void {
    const idx = this.lru.indexOf(sessionId);
    if (idx >= 0) this.lru.splice(idx, 1);
    this.lru.unshift(sessionId);
  }
}
