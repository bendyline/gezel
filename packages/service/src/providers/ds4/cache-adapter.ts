/**
 * ds4 (DwarfStar) `EngineCacheAdapter`.
 *
 * ds4-server manages its own KV persistence internally: it keys live and
 * on-disk KV snapshots by token-text hash (`--kv-disk-dir`, LRU'd under
 * `--kv-disk-space-mb`) and restores on prefix match without any
 * client-visible handle. That inverts the shape of the other adapters:
 *
 *   - There is NO `cache_id`/slot to attach per request —
 *     {@link buildRequestExtras} is empty.
 *   - There is NO per-session eviction or inspection API — the engine
 *     can't map a sessionId to its token-text keys, so `evict()` is a
 *     best-effort no-op and `reportUsage()` reports nothing (both
 *     explicitly allowed by the contract).
 *
 * What the adapter DOES contribute is {@link warm}: run the next real
 * turn's prefill early, while the user is still reading/thinking (the
 * UI fires `POST /api/cache/warm` whenever a session gains focus). On a
 * 284B SSD-streamed model a cold conversation prefill takes minutes;
 * warming converts that wait into background work — the real turn then
 * lands on hot live KV or a disk prefix hit.
 *
 * CRITICAL: the warm request must be BYTE-IDENTICAL to the prefix of
 * the next real request — ds4 KV is prefix-keyed from token 0, so a
 * warm that renders the prompt even slightly differently (missing
 * system block, missing tool schemas, different reasoning replay)
 * stores a key no real turn can ever hit AND pollutes the disk-KV LRU
 * with a junk chunk. That is why `warm` does NOT build a request from
 * the raw transcript: it delegates to {@link Ds4CacheAdapterOptions.prefillSession},
 * which routes through the live session's own request assembly
 * (`LlamaCppSession.prefillOnly`) — the same wire-message transforms,
 * tool schemas, and tuning the real turn will use.
 *
 * Safety: ds4 runs a single request lane (`concurrency: 1`, no
 * background slot — foreground and background generations must never
 * overlap). A warm therefore SKIPS entirely when anything is running or
 * queued, and at most one warm is in flight at a time. If the user
 * sends a real turn while a warm is mid-prefill, the engine serializes
 * it behind the warm — near-lossless, because the warm's prefill IS the
 * turn's prefill (same token prefix, so the turn resumes from the
 * warmed KV).
 */
import { createLogger } from '@bendyline/gezel';
import type {
  CacheWarmMessage,
  EngineCacheAdapter,
  EngineCacheUsage,
} from '../../cache/adapter.js';

const log = createLogger('ds4-cache');

export interface Ds4CacheAdapterOptions {
  /** Live base URL of the ds4-server process, or null when not running. */
  resolveBaseUrl: () => Promise<string | null> | string | null;
  /**
   * True when the engine has anything running or queued. Warms are
   * strictly lower priority than real work on the single ds4 lane and
   * skip rather than contend.
   */
  isBusy: () => boolean;
  /**
   * Run a prefill-only request through the session's own request
   * assembly (ChatManager: `ensureState` → `session.prefillOnly()`).
   * Returns false when the session doesn't exist or its provider
   * session can't prefill; throws on engine errors.
   */
  prefillSession: (sessionId: string) => Promise<boolean>;
}

export class Ds4CacheAdapter implements EngineCacheAdapter {
  readonly providerName = 'ds4';
  /**
   * The warm renders the full prompt from live session state — an
   * empty transcript still warms the (dominant, ~35k-token on a
   * meester) `[system][tools]` block. `prewarmSession` reads this to
   * skip its empty-transcript early-return.
   */
  readonly warmsFromSessionState = true;
  private readonly opts: Ds4CacheAdapterOptions;
  /** Session id of the warm currently in flight, if any. */
  private warmInFlight: string | null = null;

  constructor(opts: Ds4CacheAdapterOptions) {
    this.opts = opts;
  }

  /** ds4-server keys KV by token text internally — nothing to attach. */
  buildRequestExtras(_sessionId: string): Record<string, unknown> {
    return {};
  }

  /** No per-session eviction API; the engine LRUs its own disk budget. */
  async evict(_sessionIds: readonly string[]): Promise<void> {}

  /** No inspection API — the controller treats ds4 cache as opaque. */
  async reportUsage(): Promise<readonly EngineCacheUsage[]> {
    return [];
  }

  /** `_messages` is unused: the prompt is rendered from live session
   * state (see {@link warmsFromSessionState}); a raw transcript can
   * never reproduce the real turn's token prefix. */
  async warm(sessionId: string, _messages: readonly CacheWarmMessage[]): Promise<void> {
    if (this.warmInFlight) {
      log.debug(`warm skipped for ${sessionId.slice(0, 8)} — warm already in flight`);
      return;
    }
    if (this.opts.isBusy()) {
      log.debug(`warm skipped for ${sessionId.slice(0, 8)} — engine busy`);
      return;
    }
    // Claim the in-flight guard SYNCHRONOUSLY — before any await — so two
    // near-simultaneous warms can't both slip past the check above.
    this.warmInFlight = sessionId;
    const t0 = Date.now();
    try {
      const baseUrl = await this.opts.resolveBaseUrl();
      if (!baseUrl) {
        // Engine not resident. Deliberately do NOT spawn it here — focusing
        // a session must never trigger a multi-minute 284B model load (the
        // user may just be browsing). Warm only accelerates an engine that
        // is already up.
        log.debug(`warm skipped for ${sessionId.slice(0, 8)} — engine not running`);
        return;
      }
      const ran = await this.opts.prefillSession(sessionId);
      if (!ran) {
        log.debug(`warm skipped for ${sessionId.slice(0, 8)} — session cannot prefill`);
        return;
      }
      log.info(`warmed session ${sessionId.slice(0, 8)} in ${Date.now() - t0}ms`);
    } catch (err) {
      log.warn(
        `warm for ${sessionId.slice(0, 8)} failed after ${Date.now() - t0}ms:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.warmInFlight = null;
    }
  }
}
