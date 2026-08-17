/**
 * EngineRouter — the glue between {@link ProviderPool} +
 * {@link CapacityBroker} and the chat-layer concepts (sessions,
 * gezels, modelIds). It answers two questions:
 *
 *   1. "What replica should this session run on?" — `bindForSession`
 *      picks (and remembers) a replica index per session so KV cache
 *      lives in one process for the session's lifetime.
 *   2. "Give me the live LLMProvider for this engine key." — `ensure`
 *      hands the pool a `(provider, modelId, replicaIdx, residentBytes)`
 *      tuple and gets back the provider.
 *
 * The router does NOT decide which modelId a session uses — that's
 * resolved upstream by the chat layer from gezel frontmatter +
 * config defaults. The router takes the resolved modelId as input.
 *
 * Live consumers: ChatManager's `ensureProviderForSession` (internal
 * `/api` chat turns, session-sticky via persisted `engineKey`) and
 * `getProviderForModel` (`/v1` + Ollama-compat one-shots, record-free).
 */

import { createLogger } from '@bendyline/gezel';
import type { LLMProvider } from '../types.js';
import { CapacityBroker } from './capacity-broker.js';
import {
  type LocalProviderName,
  isLocalProvider,
  makeEngineKey,
  parseEngineKey,
} from './engine-key.js';
import type { PoolSnapshot, ProviderBuilder, ProviderPool } from './provider-pool.js';

const log = createLogger('engine-router');

/**
 * Resolves the catalog `residentBytes` for a model. The chat layer
 * supplies this with knowledge of the installed catalog; the router
 * is provider-agnostic so it doesn't import the catalog directly.
 * Returning `undefined` triggers the broker's
 * `estimateResidentBytes` fallback.
 */
export type ResidentBytesResolver = (
  provider: LocalProviderName,
  modelId: string,
) => number | undefined;

export interface EngineRouterOptions {
  broker: CapacityBroker;
  pool: ProviderPool;
  /**
   * Per-provider builders. The chat layer wraps
   * `buildLlamaCppProvider` / `buildMlxProvider` here, threading
   * through the `modelId` and `replicaIdx` so the underlying
   * factories can produce per-replica isolation (unique port,
   * isolated slot-save-path, etc.).
   */
  builders: Partial<Record<LocalProviderName, ProviderBuilder>>;
  /**
   * Catalog-driven residentBytes lookup. Falls back to
   * {@link CapacityBroker.estimateResidentBytes} when the lookup
   * returns undefined.
   */
  resolveResidentBytes: ResidentBytesResolver;
  /**
   * Fallback per-engine approx size in bytes used by the broker
   * estimator when the catalog has no entry at all. Lets the router
   * be useful in tests / dev installs before any models are pulled.
   * Defaults to 8 GB which is a defensible middle-of-the-road
   * working-set for an unknown 4-bit quant.
   */
  fallbackApproxBytes?: number;
}

export interface BindResult {
  /** The engine key the session is bound to (now persisted). */
  engineKey: string;
  /** Live provider instance for the bound replica. */
  provider: LLMProvider;
}

export interface BindContext {
  /** The session's id, used by the chat layer to weight `pickReplicaForBind`. */
  sessionId: string;
  /** Active session count per existing engine key — drives load balancing. */
  sessionsPerKey?: ReadonlyMap<string, number>;
}

const DEFAULT_FALLBACK_APPROX_BYTES = 8 * 1024 ** 3;

export class EngineRouter {
  readonly broker: CapacityBroker;
  readonly pool: ProviderPool;
  private readonly builders: Partial<Record<LocalProviderName, ProviderBuilder>>;
  private readonly resolveResidentBytes: ResidentBytesResolver;
  private readonly fallbackApproxBytes: number;

  constructor(opts: EngineRouterOptions) {
    this.broker = opts.broker;
    this.pool = opts.pool;
    this.builders = opts.builders;
    this.resolveResidentBytes = opts.resolveResidentBytes;
    this.fallbackApproxBytes = opts.fallbackApproxBytes ?? DEFAULT_FALLBACK_APPROX_BYTES;
  }

  /**
   * Compute the working-set bytes the broker should reserve for
   * `(provider, modelId)`. Catalog lookup wins; missing entry →
   * fallback via {@link CapacityBroker.estimateResidentBytes}.
   */
  resolveBytes(provider: LocalProviderName, modelId: string): number {
    const hit = this.resolveResidentBytes(provider, modelId);
    if (hit !== undefined && hit > 0) return hit;
    return CapacityBroker.estimateResidentBytes(provider, this.fallbackApproxBytes);
  }

  /**
   * Bind a session to a specific replica. Idempotent — if a prior
   * `engineKey` was supplied AND the replica still exists, returns
   * the same key and ensures it. Otherwise picks the least-loaded
   * replica of `(provider, modelId)` and returns its key. Caller
   * is responsible for persisting the returned `engineKey` onto the
   * session record.
   */
  async bindForSession(
    provider: LocalProviderName,
    modelId: string,
    ctx: BindContext,
    priorEngineKey?: string,
  ): Promise<BindResult> {
    if (priorEngineKey) {
      const parsed = parseEngineKey(priorEngineKey);
      if (parsed && parsed.provider === provider && parsed.modelId === modelId) {
        if (this.pool.has(priorEngineKey)) {
          this.pool.touch(priorEngineKey);
          const p = await this.ensureExisting(priorEngineKey);
          if (p) return { engineKey: priorEngineKey, provider: p };
        }
        // Prior key was valid but the replica is gone (LRU-evicted,
        // clones reduced, etc.). Re-spawn at the same index if budget
        // allows; otherwise fall through to least-loaded pick.
        try {
          const provider = await this.ensure(parsed.provider, parsed.modelId, parsed.replicaIdx);
          return { engineKey: priorEngineKey, provider };
        } catch (err) {
          log.warn(
            `bindForSession: prior key ${priorEngineKey} unavailable (${
              err instanceof Error ? err.message : String(err)
            }); rebinding to least-loaded replica`,
          );
        }
      }
    }
    const replicaIdx = this.pool.pickReplicaForBind(
      provider,
      modelId,
      ctx.sessionsPerKey ?? new Map(),
    );
    const engineKey = makeEngineKey(provider, modelId, replicaIdx);
    const instance = await this.ensure(provider, modelId, replicaIdx);
    log.info(`bind ${ctx.sessionId} → ${engineKey}`);
    return { engineKey, provider: instance };
  }

  /**
   * Get-or-build the provider for `(provider, modelId, replicaIdx)`.
   * Reserves the catalog `residentBytes` and triggers LRU eviction
   * inside the pool when budget is tight.
   */
  async ensure(
    provider: LocalProviderName,
    modelId: string,
    replicaIdx: number,
  ): Promise<LLMProvider> {
    if (!this.builders[provider]) {
      throw new Error(`EngineRouter: no builder registered for provider '${provider}'`);
    }
    const bytes = this.resolveBytes(provider, modelId);
    return this.pool.ensure(provider, modelId, replicaIdx, bytes);
  }

  /**
   * Resolve a persisted engine key back to a live provider, only if
   * the replica is currently resident. Used by the chat layer to
   * fast-path subsequent turns without re-running the bind logic.
   * Returns null when the key is absent from the pool (caller falls
   * back to a fresh bind).
   */
  async ensureExisting(engineKey: string): Promise<LLMProvider | null> {
    const parsed = parseEngineKey(engineKey);
    if (!parsed) return null;
    if (!this.pool.has(engineKey)) return null;
    // ensure on an existing entry is a fast O(1) hit.
    return this.pool.ensure(
      parsed.provider,
      parsed.modelId,
      parsed.replicaIdx,
      this.resolveBytes(parsed.provider, parsed.modelId),
    );
  }

  /**
   * Reconcile the resident set to match a target clone-count map.
   * `target` is keyed by modelId; values are the desired clone count
   * (>= 0; 0 means "evict all resident replicas of this model").
   * Provider is fixed to the caller's chosen engine.
   */
  async reconcileClones(
    provider: LocalProviderName,
    target: Record<string, number>,
  ): Promise<void> {
    const items = Object.entries(target).map(([modelId, clones]) => ({
      provider,
      modelId,
      clones,
    }));
    await this.pool.reconcile(items, (p, m) => this.resolveBytes(p, m));
  }

  /**
   * Unload every resident replica that is not mid-turn. Returns the keys left
   * resident because they were busy. Used by a live config reset, which needs
   * the memory back but must not sever work in flight.
   */
  async releaseIdle(): Promise<string[]> {
    return this.pool.releaseIdle();
  }

  /** Unload one resident replica immediately, provided it is still idle. */
  async unloadIdle(
    provider: LocalProviderName,
    modelId: string,
    replicaIdx: number,
  ): Promise<boolean> {
    return this.pool.unloadIdle(makeEngineKey(provider, modelId, replicaIdx));
  }

  snapshot(): PoolSnapshot {
    return this.pool.snapshot();
  }

  /** Best-effort shutdown — evicts every entry. */
  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  /** Gracefully drain every admitted turn, including background one-shots,
   * and permanently prevent this user daemon from spawning another engine. */
  async retire(): Promise<void> {
    await this.pool.retire();
  }
}

/**
 * Helper consumed by the chat layer to derive a provider+modelId
 * from a session record / gezel frontmatter / config defaults. Pure
 * function; kept on the router module for colocation with the rest
 * of the routing logic.
 */
export function resolveLocalRoute(args: {
  providerName: string;
  frontmatterModel?: string;
  recordModel?: string;
  configDefaultModel?: string;
}): { provider: LocalProviderName; modelId: string } | null {
  if (!isLocalProvider(args.providerName)) return null;
  const modelId = args.recordModel ?? args.frontmatterModel ?? args.configDefaultModel;
  if (!modelId) return null;
  return { provider: args.providerName, modelId };
}
