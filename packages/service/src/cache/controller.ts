/**
 * Engine-agnostic policy controller for prompt-cache reuse across local
 * inference engines.
 *
 * Local engines (MLX via our wrapped server, llama.cpp via llama-server's
 * slot system) preserve KV cache across requests so the per-turn prefill
 * cost drops from O(full prompt) to O(new tokens). The mechanism differs
 * per engine — see {@link EngineCacheAdapter}. This controller owns
 * everything that's the same across both:
 *
 *   - Tracking which sessions are "warm" (have cache) per provider
 *   - LRU eviction when total cache memory exceeds a configured budget
 *   - Invalidation routing on compaction / archive / delete / reset
 *   - Stats surface for telemetry (engine pill, queue meter, /api/cache)
 *
 * State model: a `Map<providerName, ProviderState>` where each provider
 * holds its own `Map<sessionId, CacheEntry>`. Per-session entries record
 * the bytes the controller *thinks* the engine has cached (an estimate
 * the controller maintains based on `recordTurn`'s `approxPromptTokens`
 * argument); periodic `adapter.reportUsage()` polls reconcile against
 * engine reality.
 *
 * LRU is per-provider, not global — MLX and llama.cpp have independent
 * memory budgets because they're independent processes.
 */

import type { EngineCacheAdapter, EngineCacheUsage } from './adapter.js';

const DEFAULT_BUDGET_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB; Phase 3 makes this RAM-aware.
const RECONCILE_INTERVAL_MS = 5_000;
const EVICTION_HIGH_WATERMARK = 1.0; // evict when usage ≥ budget
const EVICTION_LOW_WATERMARK = 0.8; // stop evicting when usage drops below 80% of budget

/**
 * KV cache size estimate in bytes per token. Used only for the
 * controller's pre-reconcile bookkeeping; the adapter's
 * `reportUsage()` returns engine-truth bytes that take precedence.
 *
 * 100 KB/token is reasonable for sliding-window-attention models
 * (Gemma 3/4 family) where most layers are windowed and don't grow
 * linearly with token count. Higher estimates overcommit memory
 * accounting and trigger spurious eviction; the in-engine bound is
 * the actual safety net for real memory pressure.
 */
const ESTIMATED_BYTES_PER_TOKEN = 100 * 1024;

export interface SessionCacheStats {
  sessionId: string;
  gezelId?: string;
  /** Approximate token count cached. */
  tokenCount: number;
  /** Approximate bytes used. */
  bytes: number;
  /** Epoch ms of the last turn that used this session. */
  lastUsedAt: number;
  /** Eviction priority — `low` is pinned (last to evict). */
  evictionPriority: EvictionPriority;
}

export type EvictionPriority = 'low' | 'normal';

/**
 * Where a turn's prompt cache came from, reported by the engine adapter
 * (MLX wrapper stdout `[cache] hit/disk-hit/prefix-hit/miss`; llama-server
 * `/slots` reuse inference). `memory`/`disk`/`prefix` all count as a hit
 * for hit-rate; `fresh` is a miss. Drives the `hitsBySource` telemetry
 * that the layered-prefix A/B reads to attribute reuse to the right
 * layer.
 */
export type HitSource = 'memory' | 'disk' | 'prefix' | 'fresh';

export interface HitsBySource {
  memory: number;
  disk: number;
  prefix: number;
  fresh: number;
}

export interface GezelCacheStats {
  gezelId: string;
  hits: number;
  misses: number;
}

export interface ProviderCacheStats {
  providerName: string;
  totalBytes: number;
  budgetBytes: number;
  warmSessionCount: number;
  hits: number;
  misses: number;
  /** Cache hit rate over the last `RECENT_TURN_WINDOW` turns. */
  recentHitRate: number;
  /** Cumulative hit counts split by where the cache came from (#6). */
  hitsBySource: HitsBySource;
  /** Per-gezel hit/miss breakdown — surfaces which gezels' prefixes pay off. */
  gezels: GezelCacheStats[];
  sessions: SessionCacheStats[];
}

interface CacheEntry {
  sessionId: string;
  gezelId?: string;
  tokenCount: number;
  bytes: number;
  lastUsedAt: number;
  evictionPriority: EvictionPriority;
}

interface ProviderState {
  adapter: EngineCacheAdapter;
  budgetBytes: number;
  entries: Map<string, CacheEntry>;
  hits: number;
  misses: number;
  /** Cumulative hits split by source (#6). */
  hitsBySource: HitsBySource;
  /** Per-gezel hit/miss tallies for the layered-prefix telemetry. */
  gezelOutcomes: Map<string, { hits: number; misses: number }>;
  /** Sliding window of last 50 turn outcomes for `recentHitRate`. */
  recentOutcomes: boolean[];
}

function emptyHitsBySource(): HitsBySource {
  return { memory: 0, disk: 0, prefix: 0, fresh: 0 };
}

const RECENT_TURN_WINDOW = 50;

export interface SessionCacheControllerOptions {
  /** Replaceable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Replaceable logger. Defaults to `console`. */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
  /** Skip the periodic reconcile timer (tests drive reconciliation manually). */
  disableReconcileTimer?: boolean;
}

export class SessionCacheController {
  private readonly providers = new Map<string, ProviderState>();
  /**
   * Pre-registration budget overrides. Operator config can set a
   * budget at service boot — before any provider's adapter has been
   * lazily registered. We stash the value here and apply it the
   * moment the adapter shows up via `registerAdapter`. Without this,
   * the boot-time `setBudget` would be a silent no-op and the engine
   * would run with `DEFAULT_BUDGET_BYTES` until the first manual
   * `setBudget` after construction.
   */
  private readonly pendingBudgets = new Map<string, number>();
  private readonly now: () => number;
  private readonly logger: NonNullable<SessionCacheControllerOptions['logger']>;
  private reconcileTimer?: NodeJS.Timeout;

  constructor(opts: SessionCacheControllerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? {};
    if (!opts.disableReconcileTimer) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcileAll().catch((err) => {
          this.logger.warn?.(`[cache] reconcile loop error: ${err}`);
        });
      }, RECONCILE_INTERVAL_MS);
      this.reconcileTimer.unref?.();
    }
  }

  /**
   * Register an adapter for a provider. Idempotent — re-registering
   * replaces the prior adapter and clears its tracked state (e.g.
   * supervisor restart hands us a new adapter instance for the same
   * provider name). Default budget is `DEFAULT_BUDGET_BYTES`; Phase 3
   * sets a per-engine RAM-aware default via `setBudget`.
   */
  registerAdapter(adapter: EngineCacheAdapter): void {
    // If the operator already set a budget for this provider before
    // any adapter showed up (boot-time config), honor it now. Otherwise
    // start at the conservative default.
    const initialBudget = this.pendingBudgets.get(adapter.providerName) ?? DEFAULT_BUDGET_BYTES;
    this.pendingBudgets.delete(adapter.providerName);
    this.providers.set(adapter.providerName, {
      adapter,
      budgetBytes: initialBudget,
      entries: new Map(),
      hits: 0,
      misses: 0,
      hitsBySource: emptyHitsBySource(),
      gezelOutcomes: new Map(),
      recentOutcomes: [],
    });
  }

  /**
   * Set the memory budget for a provider. Operator-tunable; Phase 3
   * exposes this in the Settings UI. Eviction kicks in immediately if
   * the new budget is below current usage. Calls before the provider's
   * adapter has registered are remembered and applied on registration
   * — this lets `service.ts` set boot-time budgets from config without
   * coordinating with lazy provider construction.
   */
  setBudget(providerName: string, bytes: number): void {
    const state = this.providers.get(providerName);
    if (!state) {
      this.pendingBudgets.set(providerName, bytes);
      return;
    }
    state.budgetBytes = bytes;
    void this.enforceBudget(providerName);
  }

  /**
   * Record that a turn just ran for this session. Updates LRU position
   * and tracks token count for byte accounting. Called from
   * `ChatManager.runSend` after `sendAndWait` returns.
   *
   * `approxPromptTokens` is the controller's best estimate of cache
   * size — derived from `prompt_chars / 4`. The next `reportUsage()`
   * poll reconciles against the engine's actual numbers.
   *
   * `wasHit` is whether the engine reused cache from a prior turn.
   * Adapters know this from their own bookkeeping (llama-server `/slots`
   * cache_tokens vs prefill cost; MLX wrapper's `[cache] hit` log).
   * Default `false` — recording a turn without a hit signal counts as a
   * miss for hit-rate purposes.
   *
   * `hitSource` (optional, #6) attributes the hit to a layer — `memory`/
   * `disk`/`prefix` all count as a hit (and override `wasHit`); `fresh`
   * is a miss. When supplied it drives the per-source / per-gezel
   * telemetry the layered-prefix A/B reads.
   */
  recordTurn(args: {
    providerName: string;
    sessionId: string;
    gezelId?: string;
    approxPromptTokens: number;
    wasHit?: boolean;
    hitSource?: HitSource;
  }): void {
    const state = this.providers.get(args.providerName);
    if (!state) return;
    const existing = state.entries.get(args.sessionId);
    const bytes = args.approxPromptTokens * ESTIMATED_BYTES_PER_TOKEN;
    const entry: CacheEntry = {
      sessionId: args.sessionId,
      ...(args.gezelId ? { gezelId: args.gezelId } : {}),
      tokenCount: args.approxPromptTokens,
      bytes,
      lastUsedAt: this.now(),
      evictionPriority: existing?.evictionPriority ?? 'normal',
    };
    state.entries.set(args.sessionId, entry);
    // hitSource subsumes wasHit when provided: anything but `fresh` is a hit.
    const wasHit = args.hitSource ? args.hitSource !== 'fresh' : (args.wasHit ?? false);
    if (args.hitSource) state.hitsBySource[args.hitSource]++;
    if (wasHit) {
      state.hits++;
      state.recentOutcomes.push(true);
    } else {
      state.misses++;
      state.recentOutcomes.push(false);
    }
    if (args.gezelId) {
      const g = state.gezelOutcomes.get(args.gezelId) ?? { hits: 0, misses: 0 };
      if (wasHit) g.hits++;
      else g.misses++;
      state.gezelOutcomes.set(args.gezelId, g);
    }
    if (state.recentOutcomes.length > RECENT_TURN_WINDOW) {
      state.recentOutcomes.shift();
    }
    void this.enforceBudget(args.providerName);
  }

  /**
   * Invalidate a single session across all providers. Fired by
   * ChatManager on `compactInFlight` (cache no longer matches the
   * compacted message list), `archiveSession`, and `deleteSession`.
   * Best-effort — adapter eviction is async and may be ignored by
   * engines that have already lost the cache.
   */
  invalidate(sessionId: string): void {
    for (const [name, state] of this.providers) {
      if (!state.entries.has(sessionId)) continue;
      state.entries.delete(sessionId);
      void state.adapter.evict([sessionId]).catch((err) => {
        this.logger.warn?.(`[cache] evict failed for ${name}/${sessionId}: ${err}`);
      });
    }
  }

  /**
   * Drop everything for one provider. Fired on `resetClient` — the
   * provider is about to be torn down and rebuilt, so any state we held
   * is now stale by definition.
   */
  invalidateProvider(providerName: string): void {
    const state = this.providers.get(providerName);
    if (!state) return;
    const sessionIds = Array.from(state.entries.keys());
    state.entries.clear();
    state.recentOutcomes = [];
    state.hits = 0;
    state.misses = 0;
    state.hitsBySource = emptyHitsBySource();
    state.gezelOutcomes.clear();
    if (sessionIds.length > 0) {
      void state.adapter.evict(sessionIds).catch((err) => {
        this.logger.warn?.(`[cache] provider-wide evict failed for ${providerName}: ${err}`);
      });
    }
  }

  /**
   * Pin a session against eviction (Phase 4 — voorman / starred
   * sessions). `low` priority means "evict me last"; `normal` is the
   * default LRU treatment.
   */
  pin(sessionId: string, priority: EvictionPriority): void {
    for (const state of this.providers.values()) {
      const entry = state.entries.get(sessionId);
      if (entry) entry.evictionPriority = priority;
    }
  }

  /**
   * Snapshot for telemetry. Cheap — pure read of in-memory state.
   * Empty `sessions` array when the provider has no warm cache.
   */
  getStats(providerName: string): ProviderCacheStats | null {
    const state = this.providers.get(providerName);
    if (!state) return null;
    let totalBytes = 0;
    const sessions: SessionCacheStats[] = [];
    for (const entry of state.entries.values()) {
      totalBytes += entry.bytes;
      sessions.push({
        sessionId: entry.sessionId,
        ...(entry.gezelId ? { gezelId: entry.gezelId } : {}),
        tokenCount: entry.tokenCount,
        bytes: entry.bytes,
        lastUsedAt: entry.lastUsedAt,
        evictionPriority: entry.evictionPriority,
      });
    }
    const recentHits = state.recentOutcomes.filter((x) => x).length;
    const recentHitRate =
      state.recentOutcomes.length === 0 ? 0 : recentHits / state.recentOutcomes.length;
    const gezels: GezelCacheStats[] = Array.from(state.gezelOutcomes.entries()).map(
      ([gezelId, o]) => ({ gezelId, hits: o.hits, misses: o.misses }),
    );
    return {
      providerName,
      totalBytes,
      budgetBytes: state.budgetBytes,
      warmSessionCount: state.entries.size,
      hits: state.hits,
      misses: state.misses,
      recentHitRate,
      hitsBySource: { ...state.hitsBySource },
      gezels,
      sessions,
    };
  }

  /** All providers' stats in one shot. */
  getAllStats(): ProviderCacheStats[] {
    return Array.from(this.providers.keys())
      .map((n) => this.getStats(n))
      .filter((s): s is ProviderCacheStats => s !== null);
  }

  /**
   * Reconcile the controller's tracked usage against what the engine
   * actually has cached. Replaces the controller's view with the
   * adapter's truth — engines know their cache size more precisely than
   * the controller's per-token estimate. Called on a timer; tests can
   * call manually via `reconcileProvider`.
   */
  async reconcileProvider(providerName: string): Promise<void> {
    const state = this.providers.get(providerName);
    if (!state) return;
    let usage: readonly EngineCacheUsage[];
    try {
      usage = await state.adapter.reportUsage();
    } catch (err) {
      this.logger.warn?.(`[cache] reportUsage failed for ${providerName}: ${err}`);
      return;
    }
    // Replace the entries map — adapter's view wins. We preserve
    // eviction priority across the rebuild (operator pinning shouldn't
    // be lost on reconcile).
    const oldPriorities = new Map<string, EvictionPriority>();
    for (const [id, entry] of state.entries) {
      oldPriorities.set(id, entry.evictionPriority);
    }
    state.entries.clear();
    for (const u of usage) {
      state.entries.set(u.sessionId, {
        sessionId: u.sessionId,
        tokenCount: u.tokenCount,
        bytes: u.estBytes,
        lastUsedAt: u.lastUsedAt,
        evictionPriority: oldPriorities.get(u.sessionId) ?? 'normal',
      });
    }
    await this.enforceBudget(providerName);
  }

  /** Stop the background reconcile timer. Call on shutdown. */
  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  /**
   * Watermark-based LRU eviction. When usage ≥ budget, evict
   * least-recently-used entries (skipping `low`-priority pins until
   * nothing else remains) until usage drops below 80% of budget. The
   * gap prevents thrashing when usage hovers right at the budget
   * boundary.
   */
  private async enforceBudget(providerName: string): Promise<void> {
    const state = this.providers.get(providerName);
    if (!state) return;
    let totalBytes = 0;
    for (const entry of state.entries.values()) totalBytes += entry.bytes;
    if (totalBytes < state.budgetBytes * EVICTION_HIGH_WATERMARK) return;

    const target = state.budgetBytes * EVICTION_LOW_WATERMARK;
    // Sort: normal-priority first (oldest first), then low-priority
    // (oldest first). We only touch the low-priority bucket if normal
    // is exhausted and we're still over the watermark.
    const candidates = Array.from(state.entries.values()).sort((a, b) => {
      if (a.evictionPriority !== b.evictionPriority) {
        return a.evictionPriority === 'low' ? 1 : -1;
      }
      return a.lastUsedAt - b.lastUsedAt;
    });

    const toEvict: string[] = [];
    for (const entry of candidates) {
      if (totalBytes < target) break;
      toEvict.push(entry.sessionId);
      totalBytes -= entry.bytes;
    }
    if (toEvict.length === 0) return;

    for (const id of toEvict) state.entries.delete(id);
    this.logger.info?.(
      `[cache] evicted ${toEvict.length} session(s) from ${providerName} ` +
        `(now ${(totalBytes / (1024 * 1024)).toFixed(1)} MB / ${(state.budgetBytes / (1024 * 1024)).toFixed(0)} MB)`,
    );
    try {
      await state.adapter.evict(toEvict);
    } catch (err) {
      this.logger.warn?.(`[cache] adapter.evict failed for ${providerName}: ${err}`);
    }
  }

  private async reconcileAll(): Promise<void> {
    for (const name of this.providers.keys()) {
      await this.reconcileProvider(name);
    }
  }
}
