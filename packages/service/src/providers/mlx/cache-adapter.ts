/**
 * MLX cache adapter — talks to our wrapped `gezel_mlx_server.py`.
 *
 * The wrapped server preserves prompt-cache state across requests when a
 * `cache_id` is supplied. This adapter:
 *
 *   - Allocates a stable `cache_id` per gezel sessionId. The mapping
 *     is the cache key from the engine's perspective, so two sessions
 *     never collide and one session always reuses its own cache.
 *   - Augments each `/v1/chat/completions` request body with that id
 *     plus, when known, a `prefix_cache_id` derived from a hash of the
 *     gezel's stable system prompt. The server uses prefix_cache_id as
 *     a fallback seed when the per-session cache_id misses — so a brand-
 *     new session for an existing gezel inherits the warmed prefix
 *     instead of cold-prefilling 2 KB of system prompt.
 *   - Calls `DELETE /v1/cache/{id}` on `evict` (controller-driven LRU
 *     or chat-manager invalidation hook).
 *   - Polls `GET /v1/cache/stats` on `reportUsage` so the controller
 *     reconciles its tracked usage against engine reality.
 *   - Calls `POST /v1/cache/warm` on `warm` — pre-prefill when the user
 *     opens a chat. With `persist=true`, the warmed entry is also
 *     written to disk so subsequent supervisor boots / new sessions
 *     find it ready.
 */

import { createHash } from 'node:crypto';

import type {
  CacheWarmMessage,
  EngineCacheAdapter,
  EngineCacheUsage,
  SystemPromptLayers,
} from '../../cache/adapter.js';

/**
 * Bytes-per-token estimate for MLX KV cache, used only as a fallback
 * when the wrapped server's `est_bytes` is missing. The server itself
 * reports real per-layer `nbytes` sums (fixed recurrent state priced
 * in, full-attention KV no longer ~55% over-priced) and only falls
 * back to its matching _BYTES_PER_TOKEN constant when a layer hides
 * its size — keep the two constants in sync.
 */
const ESTIMATED_BYTES_PER_TOKEN = 100 * 1024;

export interface MlxCacheAdapterOptions {
  /**
   * URL of the wrapped MLX server. Resolved lazily on each call so a
   * supervisor-restart-with-new-port stays correct without re-creating
   * the adapter.
   */
  resolveBaseUrl: () => Promise<string | null>;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Serializes engine-touching requests with chat completions. Cache
   * warming performs model prefill too; letting it run beside a chat
   * stream can starve the stream pre-first-byte on large MLX models.
   */
  runExclusive?: <T>(label: string, work: () => Promise<T>) => Promise<T>;
}

/**
 * Compute a stable id used for cross-session prefix sharing. The hash
 * input is the verbatim system prompt text — when the gezel's about,
 * the project context, or the tools block change, the hash changes and
 * a new prefix file gets created on next warm. Old prefix files become
 * orphaned and are pruned by the engine's disk-LRU eventually.
 *
 * Truncated to 16 hex chars (64 bits) — collision probability over a
 * lifetime of installs is negligible at this scale and the shorter id
 * is friendlier in logs.
 */
/**
 * Order-independent signature of the tool roster: names + argument keys,
 * sorted. Stable against harmless description churn while separating real
 * rosters. Shared by the flat and layered prefix ids — both must treat the
 * roster as identity, because Qwen-family templates render the tool block
 * at the TOP of the system message: two renders whose rosters differ share
 * ~3 tokens no matter how identical the prompt text is.
 */
function toolRosterSignature(tools: readonly unknown[]): string {
  return tools
    .map((t) => {
      const fn = (t as { function?: { name?: string; parameters?: { properties?: object } } })
        ?.function;
      const props = fn?.parameters?.properties ?? {};
      return `${fn?.name ?? '?'}:${Object.keys(props).sort().join(',')}`;
    })
    .sort()
    .join('|');
}

export function gezelPrefixId(systemPrompt: string, tools?: readonly unknown[]): string {
  const h = createHash('sha256').update(systemPrompt, 'utf8');
  // The tool ROSTER is part of the prefix identity — see
  // {@link toolRosterSignature}. Roles carry different rosters, so mixed
  // rosters over one prompt text are the common case, not an edge case.
  if (tools && tools.length > 0) {
    h.update('\u0000tools\u0000', 'utf8').update(toolRosterSignature(tools), 'utf8');
  }
  return `prefix-${h.digest('hex').slice(0, 16)}`;
}

/**
 * Shared-band prefix id (flag `mlxSharedBandPrefix`). Hashes only the leading
 * run of the system prompt that sibling sessions of the same (gezel, project)
 * render identically — everything before the task band — instead of the whole
 * prompt.
 *
 * Why a SEPARATE `prefix-band-` namespace rather than reusing
 * {@link gezelPrefixId}'s: a band entry is deliberately SHORT (it holds only
 * the shared head), while a legacy whole-prompt entry holds a full session.
 * On this model family a prefix entry longer than the shared head is not a
 * miss, it is a full re-prefill (`lcp < n` cannot be trimmed — 48 of
 * qwen3.8's 64 layers are linear-attention `ArraysCache` with no `trim()`).
 * Keeping the namespaces disjoint means the two shapes can never collide.
 * See ADR 0010.
 */
export function gezelBandPrefixId(sharedPrefix: string, tools?: readonly unknown[]): string {
  const h = createHash('sha256').update(sharedPrefix, 'utf8');
  // The roster is prefix IDENTITY on every id in this file — see
  // {@link toolRosterSignature}.
  if (tools && tools.length > 0) {
    h.update('\u0000tools\u0000', 'utf8').update(toolRosterSignature(tools), 'utf8');
  }
  return `prefix-band-${h.digest('hex').slice(0, 16)}`;
}

/**
 * Layered prefix ids (flag `layeredPrefixCache`). Distinct `gp` / `gezel`
 * namespaces, most-specific first. `gp` (full stable system) is the
 * workhorse — shared across sessions of the same model+gezel+project;
 * `gezel` (identity-only prefix) is shared across projects of the gezel.
 * The server tries them longest-first and seeds `gp` from the first real
 * session save, so the shared prefix carries the engine-templated tools.
 */
export function gezelLayerPrefixIds(
  layers: SystemPromptLayers,
  tools?: readonly unknown[],
): { gp: string; gezel: string } {
  // The roster folds into BOTH layered ids for the same reason it feeds
  // {@link gezelPrefixId}: the tool block heads the rendered prompt, so a
  // gp/gezel prefix saved under roster A is ~3 shared tokens for roster B.
  // MLX's batched KV is untrimmable and the server seeds session caches
  // from these entries before any LCP check, so a same-id/different-roster
  // collision does not degrade to a miss — it seeds a wrong-shape cache
  // that forces a full re-prefill. Distinct ids per roster line let each
  // shape keep its own entry instead of fighting over one.
  const sig = tools && tools.length > 0 ? `\u0000tools\u0000${toolRosterSignature(tools)}` : '';
  const h = (s: string) =>
    createHash('sha256').update(s, 'utf8').update(sig, 'utf8').digest('hex').slice(0, 16);
  return { gp: `prefix-gp-${h(layers.project)}`, gezel: `prefix-gezel-${h(layers.gezel)}` };
}

export class MlxCacheAdapter implements EngineCacheAdapter {
  readonly providerName = 'mlx' as const;
  private readonly resolveBaseUrl: MlxCacheAdapterOptions['resolveBaseUrl'];
  private readonly fetchImpl: typeof fetch;
  private readonly runExclusive: NonNullable<MlxCacheAdapterOptions['runExclusive']>;
  /**
   * Map of sessionId → stable per-gezel prefix id. Populated on
   * `setSessionPrefix(sessionId, systemPrompt)` and consulted by
   * `buildRequestExtras` to attach `prefix_cache_id` to each request.
   * Prefix id changes (system-prompt drift) just overwrite the entry —
   * no migration needed; the next request carries the new id and the
   * engine treats the old one as orphaned.
   */
  private readonly sessionPrefix = new Map<string, string>();
  /**
   * Per-session LAYERED prefix ids (flag ON), ordered most-specific-first
   * (`[gp, gezel]`). `buildRequestExtras` sends them as `prefix_cache_ids`;
   * the server tries them longest-first on a per-session miss.
   */
  private readonly sessionLayerPrefixIds = new Map<string, string[]>();
  /** Tracks which prefixes we've already warmed in this process so
   *  back-to-back session opens don't issue redundant warm requests. */
  /**
   * sessionId → length in CHARACTERS of the shared band inside this session's
   * system message. Sent to the engine as `stable_prefix_chars` so the sidecar
   * can plant its prompt-snapshot cut at the band boundary and publish a
   * SHORT prefix entry rather than the session's full post-turn state.
   * Chars, not tokens: only the engine has the tokenizer, and its snapshot
   * capture already verifies the token-prefix and drops a mismatched cut.
   */
  private readonly sessionBandChars = new Map<string, number>();

  private readonly warmedPrefixes = new Set<string>();
  /**
   * Prefix warms already in progress. `warmedPrefixes` is only populated after
   * the HTTP request succeeds, so without this single-flight map two app turns
   * arriving together can submit duplicate warm sequences into one MLX wave.
   */
  private readonly warmingPrefixes = new Map<string, Promise<void>>();

  constructor(opts: MlxCacheAdapterOptions = { resolveBaseUrl: async () => null }) {
    this.resolveBaseUrl = opts.resolveBaseUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.runExclusive = opts.runExclusive ?? (async (_label, work) => work());
  }

  /**
   * Tell the adapter which gezel-prefix id this session belongs to.
   * Called by the chat manager when it hydrates a session — sees the
   * stable system prompt for the session's (gezel, project) pair and
   * derives the hash via {@link gezelPrefixId}. Idempotent; same
   * (sessionId, systemPrompt) → same prefixId → same map state.
   */
  setSessionPrefix(
    sessionId: string,
    systemPrompt: string,
    tools?: readonly unknown[],
    sharedPrefix?: string,
  ): string {
    const prefixId = sharedPrefix
      ? gezelBandPrefixId(sharedPrefix, tools)
      : gezelPrefixId(systemPrompt, tools);
    this.sessionPrefix.set(sessionId, prefixId);
    if (sharedPrefix) this.sessionBandChars.set(sessionId, sharedPrefix.length);
    else this.sessionBandChars.delete(sessionId);
    return prefixId;
  }

  /**
   * Async session prep matching the cross-engine `prepareForSend` shape.
   * Registers the session's prefix mapping and warms the prefix so
   * subsequent sessions for the same gezel can inherit it on miss.
   * Idempotent — repeated calls are a no-op past the first thanks to
   * `warmedPrefixes`.
   */
  async prepareForSend(
    sessionId: string,
    systemPrompt?: string,
    layers?: SystemPromptLayers,
    tools?: readonly unknown[],
    sharedPrefix?: string,
  ): Promise<void> {
    if (layers) {
      // Layered mode: register the [gp, gezel] ids the server will try
      // longest-first. We do NOT system-only-warm the prefix here — the
      // server seeds the shared `gp` prefix from the first real session
      // save, so the inherited prefix carries the engine-templated tools
      // (a system-only warm would strand them). Mirrors the llama-cpp
      // disk-prefix path that the A/B proved out. The roster feeds the
      // ids so save-backs from different rosters land in different
      // entries instead of overwriting each other.
      const { gp, gezel } = gezelLayerPrefixIds(layers, tools);
      this.sessionLayerPrefixIds.set(sessionId, [gp, gezel]);
      this.sessionPrefix.set(sessionId, gp);
      return;
    }
    if (sharedPrefix) {
      // Band path: register the id and stop. We deliberately do NOT warm.
      // A synthetic warm renders a different template branch than the real
      // turn (on Qwen the tool block heads the system message, so a
      // no-tools render shares ~3 tokens), and `persist: true` would write
      // that shape over a good entry — the measured oscillation in §3.7.
      // The entry is instead published from a real turn's boundary snapshot,
      // so it is a genuine token prefix by construction.
      this.setSessionPrefix(sessionId, systemPrompt ?? '', tools, sharedPrefix);
      return;
    }
    if (!systemPrompt) return;
    // Tools are part of the prefix IDENTITY unconditionally — a prefix
    // saved for roster A must never be offered to roster B, whatever we
    // decide about warming. The server seeds session caches from prefix
    // entries before any LCP check, and MLX batched KV is untrimmable, so
    // an id collision across rosters is not a miss — it is a wrong-shape
    // seed that forces a full re-prefill.
    const prefixId = this.setSessionPrefix(sessionId, systemPrompt, tools);
    const hasTools = !!tools && tools.length > 0;
    // Whether to WARM is a separate question from identity:
    //   - No tools: a system-only warm renders the same template branch a
    //     real tool-less turn will, so it is a genuine token-prefix. Warm.
    //   - Tools + GEZEL_MLX_STABLE_PREFIX: warm WITH the roster. Costs
    //     ~5-6K tokens of warm prefill; gated because the payoff needs the
    //     snapshot boundary too (measured as a net regression alone).
    //   - Tools, flag off: DO NOT WARM. A system-only warm renders Qwen's
    //     no-tools branch, which shares ~3 tokens with the real turn, and
    //     `persist: true` writes that shape to disk where it overwrites
    //     the good entry the last real session saved back. Wild-caught
    //     (koray PR-review fanout): `prefix-0b60345fcefa9ffd` oscillated
    //     between a 15,563-token no-tools render and the 24,796-token
    //     real one on every daemon boot — lcp=3, mode=fresh reused=0, 40
    //     full re-prefills, 1.58M tokens re-prefilled vs 238K of new
    //     work. Registration alone still routes save-backs correctly;
    //     the first turn just pays cold prefill once.
    const stablePrefix =
      process.env.GEZEL_MLX_STABLE_PREFIX === '1' || process.env.GEZEL_MLX_STABLE_PREFIX === 'true';
    if (hasTools && !stablePrefix) return;
    await this.warmPrefix(prefixId, systemPrompt, hasTools ? tools : undefined);
  }

  buildRequestExtras(sessionId: string): Record<string, unknown> {
    // The engine accepts `cache_id` as an extension field; absent the
    // field, it behaves like upstream mlx_vlm.server (cache cleared
    // every request). We always set it so cache reuse engages.
    const extras: Record<string, unknown> = { cache_id: sessionId };
    const layered = this.sessionLayerPrefixIds.get(sessionId);
    if (layered && layered.length > 0) {
      extras.prefix_cache_ids = layered;
      // Back-compat for older engine builds that only read the singular.
      extras.prefix_cache_id = layered[0];
      return extras;
    }
    const prefixId = this.sessionPrefix.get(sessionId);
    if (prefixId) extras.prefix_cache_id = prefixId;
    // Band path only: tells the sidecar where to cut its prompt snapshot so
    // the published entry is the shared head, not the whole session. Absent
    // ⇒ the sidecar keeps its end-minus-margin default, i.e. today's shape.
    const bandChars = this.sessionBandChars.get(sessionId);
    if (bandChars !== undefined && bandChars > 0) extras.stable_prefix_chars = bandChars;
    return extras;
  }

  async evict(sessionIds: readonly string[]): Promise<void> {
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return;
    // Forget local prefix mapping on evict — the controller is signaling
    // this session is gone. Keep `warmedPrefixes` though: other sessions
    // sharing the same prefix still benefit from "already warmed" state.
    for (const id of sessionIds) {
      this.sessionPrefix.delete(id);
      this.sessionLayerPrefixIds.delete(id);
      this.sessionBandChars.delete(id);
    }
    // Fire deletes in parallel — they're idempotent and small.
    await Promise.all(
      sessionIds.map(async (id) => {
        try {
          await this.fetchImpl(`${baseUrl}/v1/cache/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
        } catch {
          // Eviction is best-effort; the controller already removed
          // its tracking, and the engine will eventually evict via
          // its own LRU when memory pressure grows.
        }
      }),
    );
  }

  async reportUsage(): Promise<readonly EngineCacheUsage[]> {
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return [];
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/v1/cache/stats`);
    } catch {
      return [];
    }
    if (!res.ok) return [];
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return [];
    }
    if (!Array.isArray(payload)) return [];

    const usage: EngineCacheUsage[] = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const cacheId = e.cache_id;
      const tokenCount = e.token_count;
      const estBytes = e.est_bytes;
      const lastUsedTs = e.last_used_ts;
      if (typeof cacheId !== 'string' || typeof tokenCount !== 'number') continue;
      usage.push({
        sessionId: cacheId,
        tokenCount,
        estBytes: typeof estBytes === 'number' ? estBytes : tokenCount * ESTIMATED_BYTES_PER_TOKEN,
        // Server reports as Unix seconds; convert to epoch ms for the
        // controller's clock.
        lastUsedAt: typeof lastUsedTs === 'number' ? Math.round(lastUsedTs * 1000) : Date.now(),
      });
    }
    return usage;
  }

  async warm(sessionId: string, messages: readonly CacheWarmMessage[]): Promise<void> {
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return;
    await this.runExclusive(`cache-warm:${sessionId}`, async () => {
      try {
        await this.fetchImpl(`${baseUrl}/v1/cache/warm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cache_id: sessionId,
            messages: messages.map((m) => ({ role: m.role, content: m.content ?? '' })),
          }),
        });
      } catch {
        // Warming is best-effort. The next real send will prefill cold.
      }
    });
  }

  /**
   * Persist every in-memory cache entry to disk without evicting them.
   * Called by the supervisor's Stage-1 idle-freeze hook so a long
   * idle window doesn't risk losing warm state to a SIGKILL between
   * Stage 1 (freeze) and Stage 2 (full SIGTERM). The wrapped server
   * handles the actual save loop via `/admin/flush`.
   */
  async flushAll(): Promise<void> {
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return;
    try {
      await this.fetchImpl(`${baseUrl}/admin/flush`, { method: 'POST' });
    } catch {
      // Best-effort. The server's own SIGTERM handler is the
      // belt-and-braces fallback even if this round-trip fails.
    }
  }

  /**
   * Pre-warm a per-gezel prefix entry. Called fire-and-forget on session
   * open — the first session for a given gezel pays the prefill cost
   * once and writes the entry to disk; subsequent sessions for the same
   * gezel inherit the warm prefix without paying again.
   *
   * Idempotent across a single process lifetime — repeated calls for
   * the same prefixId are a no-op locally (the engine itself short-
   * circuits when its own in-memory entry already matches the prompt
   * tokens, but skipping the round-trip saves a few ms and one log
   * line per session open).
   */
  async warmPrefix(
    prefixId: string,
    systemPrompt: string,
    tools?: readonly unknown[],
  ): Promise<void> {
    if (this.warmedPrefixes.has(prefixId)) return;
    const existing = this.warmingPrefixes.get(prefixId);
    if (existing) return existing;

    const warming = this.warmPrefixOnce(prefixId, systemPrompt, tools);
    this.warmingPrefixes.set(prefixId, warming);
    try {
      await warming;
    } finally {
      if (this.warmingPrefixes.get(prefixId) === warming) {
        this.warmingPrefixes.delete(prefixId);
      }
    }
  }

  private async warmPrefixOnce(
    prefixId: string,
    systemPrompt: string,
    tools?: readonly unknown[],
  ): Promise<void> {
    if (this.warmedPrefixes.has(prefixId)) return;
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return;
    await this.runExclusive(`cache-prefix:${prefixId}`, async () => {
      if (this.warmedPrefixes.has(prefixId)) return;
      try {
        await this.fetchImpl(`${baseUrl}/v1/cache/warm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cache_id: prefixId,
            // The "system" role gives the model the same context it'll see at
            // chat time. The sidecar supplies two different synthetic users
            // for templates that reject system-only input, then snapshots
            // their stable token prefix before either user turn.
            messages: [{ role: 'system', content: systemPrompt }],
            // Render through the same tool-aware template branch the real
            // turns use, or the warmed tokens are not their prefix.
            ...(tools && tools.length > 0 ? { tools } : {}),
            // Critical: persist=true writes the warmed entry to disk so
            // sibling sessions opened after this process restart still
            // benefit. Without persist the prefix would only live in
            // this process's memory.
            persist: true,
          }),
        });
        this.warmedPrefixes.add(prefixId);
      } catch {
        // Best-effort — first turn just pays cold prefill cost.
      }
    });
  }
}
