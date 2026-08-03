/**
 * ProviderPool — owns the lifecycle of every local-engine
 * {@link LLMProvider} instance, keyed by `{provider, modelId,
 * replicaIdx}`. Replaces the singleton "one supervisor per provider"
 * model with a fleet so different gezels can run different models
 * without cold-reload between turns.
 *
 * Capacity is enforced through {@link CapacityBroker}: every `ensure`
 * reserves the model's `residentBytes`; when the budget is exhausted
 * the pool LRU-evicts entries (shutting them down, releasing
 * capacity, flushing any disk-cache work in the provider's
 * `shutdown`) until the new entry fits.
 *
 * The pool is intentionally provider-agnostic — it doesn't know how
 * to launch a llama-server or a Python MLX runtime. Callers inject a
 * builder per `LocalProviderName`; tests inject a `MockProviderBuilder`
 * that produces no-op LLMProviders.
 */

import { createLogger } from '@bendyline/gezel';
import type { LLMProvider } from '../types.js';
import {
  type CapacityBroker,
  CapacityDeniedError,
  EngineBusyError,
  formatCapacityDenial,
} from './capacity-broker.js';
import {
  type LocalProviderName,
  type ParsedEngineKey,
  makeEngineKey,
  parseEngineKey,
} from './engine-key.js';
import type { GpuSpawnGuard } from './gpu-panic-guard.js';

const log = createLogger('provider-pool');

/**
 * The stable, machine-shaped denial log line. Its shape is a contract
 * with the eval harness — evals/src/failure-class.ts:118,
 * evals/src/preflight.ts:196, and evals/src/runner.ts:981 all grep the
 * daemon log for `capacity broker denied <key>: budget exhausted: …`
 * to classify capacity denials as infra (not model) failures. Do not
 * reword either side without updating the other.
 */
export function capacityDenialLogLine(key: string, reason: string): string {
  return `capacity broker denied ${key}: ${reason}`;
}

export interface ProviderBuilderArgs {
  modelId: string;
  replicaIdx: number;
}

/**
 * A builder produces a fully-initialized provider (after
 * `provider.initialize()`) plus the working-set bytes the broker
 * should reserve. Builders are responsible for any per-replica
 * isolation (unique ports, isolated cache dirs).
 */
export type ProviderBuilder = (args: ProviderBuilderArgs) => Promise<{
  provider: LLMProvider;
  residentBytes: number;
  /** Installed parameter payload resident for this replica, when known. */
  modelWeightsBytes?: number;
}>;

export interface ProviderPoolOptions {
  broker: CapacityBroker;
  builders: Partial<Record<LocalProviderName, ProviderBuilder>>;
  /**
   * Test seam — defaults to `Date.now`. Drives the LRU's
   * `lastUsedAt` so tests can advance time without `vi.useFakeTimers`.
   */
  now?: () => number;
  /**
   * Optional hook fired after a successful `ensure` (hit or miss).
   * Used by the surrounding chat layer for telemetry / status pings.
   */
  onChange?: (snapshot: PoolSnapshot) => void;
  /**
   * How long a non-forced {@link evict} waits for a busy engine to
   * drain its in-flight turns before giving up with a "model is busy"
   * error. Deliberately short: an indefinite wait can deadlock via
   * cross-model ask-specialist chains (a turn on engine X blocks on a
   * consultation that needs engine Y, whose spawn is waiting for X to
   * go idle). Default 30s.
   */
  drainWaitMs?: number;
  /** Test seam for the drain poll — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional GPU-panic guard. When present, consulted before spawning a new
   * local GPU engine; a `blocked` decision denies the spawn (same throw path
   * as a capacity denial) so gezel doesn't re-trigger an Apple GPU-driver
   * kernel panic right after one. Off macOS / when omitted, no-op.
   */
  gpuPanicGuard?: GpuSpawnGuard;
  /**
   * Serialize local GPU model LOADS so at most one model maps onto the GPU at
   * a time (never two `builder()` spawns concurrently). The macOS GPU-driver
   * kernel panic we defend against is a memory-refcount *underflow*
   * (`IOGPUMemory` "prepare count underflow") — a concurrency-sensitive bug
   * that interleaved GPU allocate/free from two simultaneous model loads can
   * race into. Serializing removes that class of churn. Bounded, deadlock-free
   * (the lock is held only for the load, which always completes). Default: on
   * for macOS (`GEZEL_SERIALIZE_GPU_LOADS=off` to disable); off elsewhere.
   */
  serializeGpuLoads?: boolean;
}

export interface PoolEntrySnapshot {
  key: string;
  provider: LocalProviderName;
  modelId: string;
  replicaIdx: number;
  residentBytes: number;
  /** Installed parameter payload resident for this replica, when known. */
  modelWeightsBytes?: number;
  lastUsedAt: number;
  createdAt: number;
  /** True while a non-forced eviction is waiting for in-flight turns to finish. */
  draining: boolean;
}

export interface PoolSnapshot {
  entries: PoolEntrySnapshot[];
  committedBytes: number;
  budgetBytes: number;
  enforced: boolean;
  /** Physical RAM — the Settings slider's ceiling. */
  systemRamBytes: number;
  /** What the host would auto-derive; the slider's "Auto" mark. */
  autoBudgetBytes: number;
  /** True when `localEngineMemoryGb` is overriding the auto value. */
  overridden: boolean;
  /** Which pools back the budget — see {@link CapacityCommitted.pools}. */
  pools: import('./capacity-broker.js').CapacityCommitted['pools'];
}

/**
 * Live queue state for one local provider, folded across every
 * resident replica of that provider. Shape mirrors a single provider's
 * `queue.describe()` plus `maxConcurrency`, so `/api/queues` can surface
 * it in the same slot it uses for singleton providers. See
 * {@link ProviderPool.queueSummaries}.
 */
export interface PooledQueueSummary {
  running: number;
  queuedInteractive: number;
  queuedBackground: number;
  /** Pending ambient entries held by the admission gate across replicas. */
  ambientHeld: number;
  concurrency: number;
  interactiveConcurrency: number;
  backgroundConcurrency: number;
  maxConcurrency: number;
  active: Array<{
    sessionId?: string;
    gezelId?: string;
    projectId?: string;
    actorLabel?: string;
    job?: string;
    runningForMs: number;
  }>;
  pending: Array<{
    id: number;
    lane: 'interactive' | 'background';
    ambient?: boolean;
    sessionId?: string;
    gezelId?: string;
    projectId?: string;
    actorLabel?: string;
    job?: string;
    waitedMs: number;
  }>;
}

function emptyPooledQueueSummary(): PooledQueueSummary {
  return {
    running: 0,
    queuedInteractive: 0,
    queuedBackground: 0,
    ambientHeld: 0,
    concurrency: 0,
    interactiveConcurrency: 0,
    backgroundConcurrency: 0,
    maxConcurrency: 0,
    active: [],
    pending: [],
  };
}

interface PoolEntry {
  parsed: ParsedEngineKey;
  provider: LLMProvider;
  residentBytes: number;
  modelWeightsBytes?: number;
  lastUsedAt: number;
  createdAt: number;
  /** See {@link PoolEntrySnapshot.draining}. */
  draining: boolean;
  /**
   * Recent use timestamps (pruned to {@link DEMAND_WINDOW_MS}). Drives
   * demand-weighted eviction: under memory pressure the pool evicts the
   * LEAST-recently-DEMANDED idle model first (not merely the oldest), so a
   * model several tenants hit intermittently isn't dropped out from under
   * them. Multi-tenant remote serving benefits most.
   */
  recentHits: number[];
}

/** Window over which {@link PoolEntry.recentHits} counts toward demand. */
const DEMAND_WINDOW_MS = 60_000;

const DEFAULT_DRAIN_WAIT_MS = 30_000;
const DRAIN_POLL_MS = 500;

/**
 * In-flight work check, via the provider's own queue. A provider
 * without a queue (cloud providers, test fakes) is treated as idle.
 * Known blind spot: turns sent with `bypassQueue: true` (ask-specialist
 * sub-sessions) never appear in the snapshot, so a drain can complete
 * while one of those is still streaming — bounded harm, since those
 * turns are short consultations with their own timeouts.
 */
function isBusy(entry: PoolEntry): boolean {
  const snap = entry.provider.queue?.snapshot();
  if (!snap) return false;
  return snap.running + snap.queuedInteractive + snap.queuedBackground > 0;
}

/** Drop recent-hit timestamps older than the demand window. */
function pruneHits(entry: PoolEntry, now: number): void {
  const cutoff = now - DEMAND_WINDOW_MS;
  if (entry.recentHits.length === 0 || entry.recentHits[0]! >= cutoff) return;
  entry.recentHits = entry.recentHits.filter((t) => t >= cutoff);
}

export class ProviderPool {
  private readonly broker: CapacityBroker;
  private readonly builders: Partial<Record<LocalProviderName, ProviderBuilder>>;
  private readonly now: () => number;
  private readonly onChange?: (snapshot: PoolSnapshot) => void;
  private readonly drainWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gpuPanicGuard?: GpuSpawnGuard;
  private readonly serializeGpuLoads: boolean;
  /** Tail of the serialized-load chain; each load awaits the previous. */
  private gpuLoadChain: Promise<void> = Promise.resolve();
  private readonly entries = new Map<string, PoolEntry>();
  // Lock per key so two parallel `ensure` calls don't race to build
  // the same engine. Hit path stays lock-free (Map.get).
  private readonly buildLocks = new Map<string, Promise<LLMProvider>>();
  // In-flight evictions per key — parallel evict() calls join the
  // same teardown instead of double-shutting-down the provider.
  private readonly evicting = new Map<string, Promise<void>>();

  constructor(opts: ProviderPoolOptions) {
    this.broker = opts.broker;
    this.builders = opts.builders;
    this.now = opts.now ?? Date.now;
    if (opts.onChange) this.onChange = opts.onChange;
    this.drainWaitMs = opts.drainWaitMs ?? DEFAULT_DRAIN_WAIT_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (opts.gpuPanicGuard) this.gpuPanicGuard = opts.gpuPanicGuard;
    this.serializeGpuLoads =
      opts.serializeGpuLoads ??
      (process.platform === 'darwin' && process.env.GEZEL_SERIALIZE_GPU_LOADS !== 'off');
  }

  /**
   * Run a model-LOAD (a `builder()` call, which maps weights onto the GPU)
   * either immediately or serialized behind any in-flight load, per
   * {@link ProviderPoolOptions.serializeGpuLoads}. Deadlock-free: the chain
   * only ever waits for a load to finish, never for a turn or an eviction, and
   * a load's failure doesn't wedge the chain (prior errors are swallowed).
   */
  private async withGpuLoadSlot<T>(load: () => Promise<T>): Promise<T> {
    if (!this.serializeGpuLoads) return load();
    const prior = this.gpuLoadChain;
    let release!: () => void;
    this.gpuLoadChain = new Promise<void>((r) => {
      release = r;
    });
    await prior.catch(() => {});
    try {
      return await load();
    } finally {
      release();
    }
  }

  /**
   * Resolve an engine key to a live, initialized provider. Hits the
   * cache; on miss, evicts LRU as needed to clear `residentBytes`,
   * then builds via the injected builder. The cost of eviction
   * (provider.shutdown) is awaited so the caller never returns to a
   * partially-spawned state.
   */
  async ensure(
    provider: LocalProviderName,
    modelId: string,
    replicaIdx: number,
    residentBytes: number,
  ): Promise<LLMProvider> {
    const key = makeEngineKey(provider, modelId, replicaIdx);
    const hit = this.entries.get(key);
    if (hit && !hit.draining) {
      hit.lastUsedAt = this.now();
      return hit.provider;
    }
    if (hit?.draining) {
      // The entry is being torn down to make room elsewhere. Handing
      // it out would keep it busy forever (starvation); instead wait
      // for the eviction to settle, then rebuild below. If the drain
      // timed out (eviction threw) the entry survives — return it
      // rather than double-building over a still-reserved key.
      await this.evicting.get(key)?.catch(() => {});
      const survived = this.entries.get(key);
      if (survived) {
        survived.lastUsedAt = this.now();
        return survived.provider;
      }
    }
    const pending = this.buildLocks.get(key);
    if (pending) return pending;
    const build = this.buildEntry(provider, modelId, replicaIdx, residentBytes).finally(() => {
      this.buildLocks.delete(key);
    });
    this.buildLocks.set(key, build);
    return build;
  }

  private async buildEntry(
    provider: LocalProviderName,
    modelId: string,
    replicaIdx: number,
    residentBytes: number,
  ): Promise<LLMProvider> {
    const builder = this.builders[provider];
    if (!builder) {
      throw new Error(`no ProviderBuilder registered for '${provider}'`);
    }
    // GPU-panic guard: refuse to spawn a fresh local GPU engine right after a
    // macOS GPU-driver kernel panic so we don't re-trigger the crash loop.
    // Denied the same way as a capacity denial (throw a user-readable reason);
    // no-op off macOS / when no guard is wired. See gpu-panic-guard.ts.
    const panicDecision = this.gpuPanicGuard?.check(provider);
    if (panicDecision?.blocked) {
      throw new Error(
        panicDecision.reason ?? 'Local models are paused after a recent GPU kernel panic.',
      );
    }
    await this.makeRoom(residentBytes);
    const key = makeEngineKey(provider, modelId, replicaIdx);
    // Pre-flight: makeRoom evicts what it can, but on a memory-tight
    // machine a model larger than the whole budget can never fit (no
    // amount of eviction helps). Deny BEFORE spawning so we don't load
    // gigabytes of weights only to immediately tear them down — and
    // surface a human-readable reason instead of a raw byte comparison.
    if (!this.broker.canReserve(residentBytes)) {
      const c = this.broker.committed();
      log.error(capacityDenialLogLine(key, this.broker.denialReason(residentBytes)));
      throw new CapacityDeniedError(
        formatCapacityDenial({
          modelLabel: modelId,
          requestedBytes: residentBytes,
          budgetBytes: c.budgetBytes,
          committedBytes: c.committedBytes,
          systemRamBytes: c.systemRamBytes,
          pools: c.pools,
        }),
      );
    }
    const built = await this.withGpuLoadSlot(() => builder({ modelId, replicaIdx }));
    // The builder's actual residentBytes wins if it differs from the
    // pre-flight estimate (e.g. catalog override). Reserve the truth.
    const finalBytes = built.residentBytes;
    const r = this.broker.reserve(key, finalBytes);
    if (!r.granted) {
      // Reservation race: another concurrent build consumed budget
      // between our makeRoom and reserve. Shut down what we just
      // built, retry one more makeRoom + reserve loop.
      await built.provider.shutdown().catch((err) => {
        log.warn(`shutdown after failed reserve for ${key}: ${err}`);
      });
      await this.makeRoom(finalBytes);
      const r2 = this.broker.reserve(key, finalBytes);
      if (!r2.granted) {
        const c = this.broker.committed();
        log.error(capacityDenialLogLine(key, r2.reason ?? this.broker.denialReason(finalBytes)));
        throw new CapacityDeniedError(
          formatCapacityDenial({
            modelLabel: modelId,
            requestedBytes: finalBytes,
            budgetBytes: c.budgetBytes,
            committedBytes: c.committedBytes,
            systemRamBytes: c.systemRamBytes,
            pools: c.pools,
          }),
        );
      }
      // Re-build under the now-clear budget.
      const rebuilt = await this.withGpuLoadSlot(() => builder({ modelId, replicaIdx }));
      this.installEntry(
        key,
        provider,
        modelId,
        replicaIdx,
        rebuilt.provider,
        rebuilt.residentBytes,
        rebuilt.modelWeightsBytes,
      );
      return rebuilt.provider;
    }
    this.installEntry(
      key,
      provider,
      modelId,
      replicaIdx,
      built.provider,
      finalBytes,
      built.modelWeightsBytes,
    );
    return built.provider;
  }

  private installEntry(
    key: string,
    provider: LocalProviderName,
    modelId: string,
    replicaIdx: number,
    instance: LLMProvider,
    residentBytes: number,
    modelWeightsBytes?: number,
  ): void {
    const at = this.now();
    this.entries.set(key, {
      parsed: { provider, modelId, replicaIdx },
      provider: instance,
      residentBytes,
      ...(typeof modelWeightsBytes === 'number' && Number.isFinite(modelWeightsBytes)
        ? { modelWeightsBytes: Math.max(0, modelWeightsBytes) }
        : {}),
      lastUsedAt: at,
      createdAt: at,
      draining: false,
      recentHits: [at],
    });
    log.info(`spawned ${key} (${residentBytes} bytes)`);
    this.fireChange();
  }

  /**
   * Mark a key as touched. Called by ChatManager after each turn
   * so the LRU evictor doesn't kill the engine the user is
   * actively using.
   */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const now = this.now();
    entry.lastUsedAt = now;
    entry.recentHits.push(now);
    pruneHits(entry, now);
  }

  /** Returns true if the pool currently holds an entry for `key`. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Evict a specific entry. Awaits the provider's `shutdown` so the
   * disk-cache flush (Tier 1 prior plan) completes before the broker
   * releases capacity.
   *
   * When the engine has in-flight or queued turns and `force` is not
   * set, the entry is marked `draining` (no new `ensure` hits, no new
   * binds) and the eviction waits up to `drainWaitMs` for the queue to
   * empty. On timeout it throws a "model is busy" error instead of
   * killing live work — the caller (typically `makeRoom` on behalf of
   * a request for a *different* model) surfaces that as a clear
   * temporary-failure to its own caller. `force: true` (service
   * shutdown) skips the wait entirely.
   *
   * Parallel `evict` calls for the same key join the same teardown.
   */
  async evict(key: string, opts?: { force?: boolean }): Promise<void> {
    const inFlight = this.evicting.get(key);
    if (inFlight && !opts?.force) return inFlight;
    const run = this.evictInner(key, opts?.force === true).finally(() => {
      if (this.evicting.get(key) === run) this.evicting.delete(key);
    });
    this.evicting.set(key, run);
    return run;
  }

  private async evictInner(key: string, force: boolean): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (!force && isBusy(entry)) {
      entry.draining = true;
      this.fireChange();
      const deadline = this.now() + this.drainWaitMs;
      log.info(`evict ${key}: engine busy — draining (cap ${this.drainWaitMs}ms)`);
      while (isBusy(entry)) {
        // A force-evict (service shutdown) may have torn the entry
        // down underneath this drain — if our entry is no longer the
        // resident one, the eviction is done.
        if (this.entries.get(key) !== entry) return;
        if (this.now() >= deadline) {
          entry.draining = false;
          this.fireChange();
          throw new EngineBusyError(
            `engine ${key} is busy serving requests and did not drain within ${Math.round(
              this.drainWaitMs / 1000,
            )}s — not evicting. Retry shortly, or wait for current turns to finish.`,
          );
        }
        await this.sleep(DRAIN_POLL_MS);
      }
      if (this.entries.get(key) !== entry) return;
    }
    this.entries.delete(key);
    try {
      await entry.provider.shutdown();
    } catch (err) {
      log.warn(`shutdown threw for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.broker.release(key);
    log.info(`evicted ${key}`);
    this.fireChange();
  }

  /**
   * Evict entries until the broker reports headroom for `needed`
   * bytes (or the pool is empty). Victim order: oldest *idle* entries
   * first; only when every candidate is busy does it pick the oldest
   * busy one — whose eviction then drains (bounded) rather than
   * killing in-flight turns. Pool-internal; callers never invoke
   * directly.
   *
   * Idle victims are evicted *concurrently* (a model switch on a
   * memory-tight box often has to clear several idle resident models
   * to fit the incoming one): idle `shutdown()` doesn't drain, so the
   * per-engine disk-cache flush of N victims runs in parallel instead
   * of paying each one serially before the new model can spawn. The
   * busy path stays serial to preserve the bounded-drain semantics.
   */
  private async makeRoom(needed: number): Promise<void> {
    while (!this.broker.canReserve(needed) && this.entries.size > 0) {
      const idleBatch = this.idleVictimsFor(needed);
      if (idleBatch.length > 0) {
        await Promise.all(
          idleBatch.map((k) =>
            this.evict(k).catch((err) => {
              // Idle evictions shouldn't throw (no drain wait), but a
              // shutdown() rejection must not abort the sibling evicts
              // or the whole makeRoom — log and let the loop re-check.
              log.warn(
                `makeRoom: idle evict ${k} failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }),
          ),
        );
        continue;
      }
      // No idle candidates — evict a single busy/draining victim. This
      // path keeps the bounded-drain semantics (and may throw on a busy
      // engine that won't drain in time, which propagates to the caller).
      const victim = this.lruKey();
      if (!victim) {
        // Everything is already draining under other evictions — wait
        // for one to settle and re-check the budget.
        if (this.evicting.size === 0) break;
        await Promise.race([...this.evicting.values()]).catch(() => {});
        continue;
      }
      await this.evict(victim);
    }
  }

  /**
   * The idle (non-busy, non-draining) eviction victims — oldest-first —
   * whose combined `residentBytes`, once released, would give `needed`
   * room to fit under the budget. Returns `[]` when there are no idle
   * candidates (the caller then falls back to a single busy eviction)
   * or when no eviction is required. Lets {@link makeRoom} batch idle
   * evictions in parallel instead of one-at-a-time.
   */
  private idleVictimsFor(needed: number): string[] {
    const c = this.broker.committed();
    if (!c.enforced) return [];
    // Bytes we must release for `needed` to fit: canReserve(needed) is
    // `committed + needed <= budget`, so the shortfall is
    // `committed + needed - budget`.
    let deficit = c.committedBytes + needed - c.budgetBytes;
    if (deficit <= 0) return [];
    const now = this.now();
    const idle: Array<{ key: string; at: number; bytes: number; demand: number }> = [];
    for (const [key, entry] of this.entries) {
      if (entry.draining) continue;
      if (isBusy(entry)) continue;
      pruneHits(entry, now);
      idle.push({
        key,
        at: entry.lastUsedAt,
        bytes: entry.residentBytes,
        demand: entry.recentHits.length,
      });
    }
    // Demand-weighted LRU: evict the LEAST-recently-DEMANDED idle model first
    // (fewest hits in the window), breaking ties by oldest `lastUsedAt`. Keeps
    // a model that several tenants hit intermittently resident instead of
    // dropping it just because one caller idled. Falls back to pure-oldest
    // when demand is uniform (e.g. all single-hit), preserving prior behavior.
    idle.sort((a, b) => a.demand - b.demand || a.at - b.at);
    const out: string[] = [];
    for (const v of idle) {
      if (deficit <= 0) break;
      out.push(v.key);
      deficit -= v.bytes;
    }
    return out;
  }

  private lruKey(): string | null {
    let oldestIdle: { key: string; at: number } | null = null;
    let oldestBusy: { key: string; at: number } | null = null;
    for (const [key, entry] of this.entries) {
      if (entry.draining) continue; // already being torn down elsewhere
      if (isBusy(entry)) {
        if (oldestBusy === null || entry.lastUsedAt < oldestBusy.at) {
          oldestBusy = { key, at: entry.lastUsedAt };
        }
      } else if (oldestIdle === null || entry.lastUsedAt < oldestIdle.at) {
        oldestIdle = { key, at: entry.lastUsedAt };
      }
    }
    return oldestIdle?.key ?? oldestBusy?.key ?? null;
  }

  /**
   * Shut down everything the pool owns. Used at service shutdown —
   * forces eviction without waiting for busy engines to drain.
   */
  async shutdown(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((k) => this.evict(k, { force: true })));
  }

  /**
   * Reconcile the resident set toward `target` — a map of
   * `(provider, modelId) → desiredReplicaCount`. Spawns missing
   * replicas (subject to capacity) and evicts replicas at indices
   * `>= count`. Used by the UX layer when the user changes the
   * clone-count picker.
   *
   * `ensureRes` resolves residentBytes for `(provider, modelId)`;
   * typically a closure over the catalog.
   */
  async reconcile(
    target: Array<{ provider: LocalProviderName; modelId: string; clones: number }>,
    ensureRes: (provider: LocalProviderName, modelId: string) => number,
  ): Promise<void> {
    // 1. Evict replicas at indices >= desired clone count.
    const wanted = new Set<string>();
    for (const { provider, modelId, clones } of target) {
      for (let i = 0; i < clones; i++) {
        wanted.add(makeEngineKey(provider, modelId, i));
      }
    }
    // Be careful: only evict entries whose (provider, modelId)
    // appears in `target` at all. Entries the caller didn't enumerate
    // are pre-existing and left alone (typical chat-driven spawns).
    const namedSet = new Set(target.map((t) => `${t.provider}:${t.modelId}`));
    const toEvict: string[] = [];
    for (const [key, entry] of this.entries) {
      const fp = `${entry.parsed.provider}:${entry.parsed.modelId}`;
      if (namedSet.has(fp) && !wanted.has(key)) toEvict.push(key);
    }
    for (const key of toEvict) {
      try {
        await this.evict(key);
      } catch (err) {
        // Busy engine that didn't drain in time — leave it resident
        // and carry on; the user can re-apply the clone change once
        // its turns finish.
        log.warn(
          `reconcile: could not evict ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Spawn missing replicas (best-effort under capacity).
    for (const { provider, modelId, clones } of target) {
      for (let i = 0; i < clones; i++) {
        const key = makeEngineKey(provider, modelId, i);
        if (this.entries.has(key)) continue;
        try {
          await this.ensure(provider, modelId, i, ensureRes(provider, modelId));
        } catch (err) {
          log.warn(
            `reconcile: failed to spawn ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /**
   * Pick a replica index to bind a new session to. Returns the
   * least-loaded existing replica of `(provider, modelId)` based on
   * an external `sessionsPerKey` map (the chat manager owns the
   * tally; the pool stays state-free about sessions). If no replica
   * exists, returns 0 so the caller spawns the first one.
   */
  pickReplicaForBind(
    provider: LocalProviderName,
    modelId: string,
    sessionsPerKey: ReadonlyMap<string, number>,
  ): number {
    let bestIdx = -1;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.parsed.provider !== provider) continue;
      if (entry.parsed.modelId !== modelId) continue;
      if (entry.draining) continue; // being evicted — don't bind new sessions to it
      const load = sessionsPerKey.get(key) ?? 0;
      if (load < bestLoad) {
        bestLoad = load;
        bestIdx = entry.parsed.replicaIdx;
      }
    }
    return bestIdx >= 0 ? bestIdx : 0;
  }

  /**
   * Enumerate `(provider, modelId, replicaIdx)` triples currently
   * resident. The chat layer uses this to validate a session's
   * persisted `engineKey` after restart.
   */
  resolveExisting(key: string): ParsedEngineKey | null {
    const entry = this.entries.get(key);
    if (entry) return entry.parsed;
    return parseEngineKey(key);
  }

  /**
   * Existing replica indices for a `(provider, modelId)` pair,
   * sorted ascending. Used to discover "is replica 1 already
   * resident?" without scanning the whole pool from the outside.
   */
  existingReplicas(provider: LocalProviderName, modelId: string): number[] {
    const out: number[] = [];
    for (const entry of this.entries.values()) {
      if (entry.parsed.provider === provider && entry.parsed.modelId === modelId) {
        out.push(entry.parsed.replicaIdx);
      }
    }
    return out.sort((a, b) => a - b);
  }

  snapshot(): PoolSnapshot {
    const committed = this.broker.committed();
    const entries: PoolEntrySnapshot[] = [];
    for (const [key, e] of this.entries) {
      entries.push({
        key,
        provider: e.parsed.provider,
        modelId: e.parsed.modelId,
        replicaIdx: e.parsed.replicaIdx,
        residentBytes: e.residentBytes,
        ...(e.modelWeightsBytes !== undefined ? { modelWeightsBytes: e.modelWeightsBytes } : {}),
        lastUsedAt: e.lastUsedAt,
        createdAt: e.createdAt,
        draining: e.draining,
      });
    }
    return {
      entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
      committedBytes: committed.committedBytes,
      budgetBytes: committed.budgetBytes,
      enforced: committed.enforced,
      systemRamBytes: committed.systemRamBytes,
      autoBudgetBytes: committed.autoBudgetBytes,
      overridden: committed.overridden,
      pools: committed.pools,
    };
  }

  /**
   * Fold every resident replica's live queue into one summary per
   * {@link LocalProviderName}. Under the pool architecture local
   * providers aren't seeded as singletons in `ChatManager.providers`, so
   * `/api/queues` — which reads only `getProviderIfReady(name).queue` —
   * otherwise misses ALL pooled work: chat turns and background one-shots
   * alike (weekly digest, about.md drafts, memory extraction). That blind
   * spot is what made the engine pill read "Idle" while a one-shot decoded
   * on the GPU.
   *
   * Counts sum across a provider's replicas; `active` / `pending` (with
   * their job labels) concatenate. Draining replicas are included — they
   * can still be finishing in-flight turns. Replicas whose provider
   * exposes no queue (cloud, test fakes) contribute nothing.
   */
  queueSummaries(): Map<LocalProviderName, PooledQueueSummary> {
    const out = new Map<LocalProviderName, PooledQueueSummary>();
    for (const entry of this.entries.values()) {
      const q = entry.provider.queue;
      if (!q) continue;
      const d = q.describe();
      const name = entry.parsed.provider;
      const cur = out.get(name) ?? emptyPooledQueueSummary();
      cur.running += d.running;
      cur.queuedInteractive += d.queuedInteractive;
      cur.queuedBackground += d.queuedBackground;
      cur.ambientHeld += d.ambientHeld;
      cur.concurrency += d.concurrency;
      cur.interactiveConcurrency += d.interactiveConcurrency;
      cur.backgroundConcurrency += d.backgroundConcurrency;
      cur.maxConcurrency += entry.provider.batch?.maxConcurrency ?? 1;
      cur.active.push(...d.active);
      cur.pending.push(...d.pending);
      out.set(name, cur);
    }
    return out;
  }

  /**
   * Cancel a pending queue entry on whichever resident replica of
   * `provider` holds it — the write side of {@link queueSummaries},
   * which the singleton `getProviderIfReady` path can't reach for
   * pool-routed local engines. Queue ids are replica-local (each
   * {@link ProviderQueue} counts from 1), so we cancel on the first
   * replica of this provider whose queue knows the id; in the common
   * single-replica case that is unambiguous, and a stale id simply
   * matches nothing. Returns true when an entry was removed.
   */
  cancelPendingQueueItem(provider: string, id: number): boolean {
    for (const entry of this.entries.values()) {
      if (entry.parsed.provider !== provider) continue;
      if (entry.provider.queue?.cancelPending(id)) return true;
    }
    return false;
  }

  /** Reorder a pending queue entry across this provider's replicas. See
   *  {@link cancelPendingQueueItem} for the id-matching contract. */
  movePendingQueueItem(provider: string, id: number, direction: 'up' | 'down'): boolean {
    for (const entry of this.entries.values()) {
      if (entry.parsed.provider !== provider) continue;
      if (entry.provider.queue?.movePending(id, direction)) return true;
    }
    return false;
  }

  private fireChange(): void {
    if (!this.onChange) return;
    try {
      this.onChange(this.snapshot());
    } catch (err) {
      log.warn(`onChange listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
