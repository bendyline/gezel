/**
 * Engine-side contract for the {@link SessionCacheController}.
 *
 * The controller owns *policy* — which sessions deserve cache, when to
 * evict, what the operator sees. The adapter owns *mechanism* — how a
 * specific engine actually preserves and reuses prompt-cache state.
 *
 * Two adapters exist today:
 *   - `LlamaCppCacheAdapter` — talks to llama-server's slot-based cache
 *     via `cache_prompt: true` + `id_slot` in the request body, scrapes
 *     `/slots` for memory stats.
 *   - `MlxCacheAdapter` — talks to our wrapped `gezel_mlx_server.py`
 *     via a `cache_id` request field + `/v1/cache/{stats,evict,warm}`
 *     endpoints. Phase 1 ships a no-op stub here so Phase 2 can drop
 *     in the real implementation without touching the controller.
 *
 * All methods are best-effort: an adapter that fails to honor an
 * `evict()` doesn't break the controller, it just means the engine's
 * cache is slightly larger than the controller thinks. The controller
 * is the source of truth for policy decisions; the adapter is the
 * source of truth for what's actually loaded in engine memory.
 */

export interface EngineCacheAdapter {
  /**
   * Per-provider name (e.g. `'mlx'`, `'llama-cpp'`) — keyed in the
   * controller's adapter registry. Mirrors `LLMProvider.name`.
   */
  readonly providerName: string;

  /**
   * Build the request-body extras that will tell the engine "reuse the
   * cache for this session." For llama-server: `{ cache_prompt: true,
   * id_slot: <allocated> }`. For our MLX wrapper: `{ cache_id: <stable
   * per-session id> }`. Returns an empty object for engines that don't
   * support cache reuse.
   *
   * Called on every send by the provider's session implementation.
   * Cheap — must not do I/O.
   */
  buildRequestExtras(sessionId: string): Record<string, unknown>;

  /**
   * Tell the engine to drop these sessions' caches now. Fired by the
   * controller when LRU evicts, when the operator clicks "clear", or
   * when a session is archived/deleted. Best-effort: a failed evict
   * is logged and forgotten — the controller assumes the cache is
   * gone for accounting purposes either way.
   */
  evict(sessionIds: readonly string[]): Promise<void>;

  /**
   * Snapshot of what the engine currently has cached. Polled by the
   * controller every few seconds for telemetry; also informs the
   * watermark-based eviction (controller compares its tracked usage
   * against engine reality and reconciles).
   *
   * Returns an empty array when the engine doesn't support inspection
   * or when no sessions are warm. `estBytes` is best-effort — engines
   * estimate per-token cache size from model dimensions.
   */
  reportUsage(): Promise<readonly EngineCacheUsage[]>;

  /**
   * Phase 4: pre-warm a session by running prefill without generating.
   * For llama-server: send a prefill-only request. For our MLX wrapper:
   * `POST /v1/cache/warm`. Optional — engines that don't support it
   * leave this unimplemented and the controller skips the warm path.
   *
   * `messages` is the prompt to warm with — usually the session's
   * current message list as the controller sees it.
   */
  warm?(sessionId: string, messages: readonly CacheWarmMessage[]): Promise<void>;
}

/**
 * Cumulative stable layers of the system prompt, used by layered prefix
 * caching (flag `layeredPrefixCache`). Each field is a *cumulative*
 * leading substring of the stable system message, so `gezel` is a true
 * byte-prefix of `project`:
 *
 *   gezel   = the gezel-identity leading portion (header, about, traits,
 *             lessons) — the bytes BEFORE the project-context band.
 *             Shared across projects/sessions of the same gezel.
 *   project = the full STABLE system message (identity + project +
 *             discipline + tools-prose) that gets sent as `messages[0]`.
 *             Shared across sessions of the same (model, gezel, project).
 *
 * Adapters hash each into a `prefix-gezel-<h>` / `prefix-gp-<h>` id and
 * try them longest-first on a per-session cache miss, so a brand-new
 * session inherits the warmest matching layer (gezel+project > gezel)
 * instead of cold-prefilling.
 *
 * Note there is intentionally NO model-universal layer: that would
 * require front-loading the discipline/cookbook prose, which the eval
 * history (manager.ts buildInstructions, the Phase-2.4 ordering note)
 * shows causes small-model "stuck-planning" regressions. The discipline
 * and tool-prose bands stay in their proven late positions; the cache
 * win comes from moving the VOLATILE band out of the system message so
 * `project` (and the engine-templated tool schemas that follow it) form
 * a reusable wire prefix.
 */
export interface SystemPromptLayers {
  /** Gezel-identity leading prefix (before the project-context band). */
  gezel: string;
  /** Full stable system message (= the bytes sent as messages[0]). */
  project: string;
}

export interface EngineCacheUsage {
  sessionId: string;
  /** Approximate token count cached for this session. */
  tokenCount: number;
  /** Best-effort byte estimate. Used for budget enforcement. */
  estBytes: number;
  /** Last time this entry was hit, in epoch ms. Drives LRU. */
  lastUsedAt: number;
}

export interface CacheWarmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}
