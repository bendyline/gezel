/**
 * llama-server cache adapter.
 *
 * llama-server keeps KV cache per "slot" — a small, fixed pool of
 * inference contexts (configured at server start via `--parallel N`).
 * Each request can name an `id_slot` to bind itself to; without an
 * `id_slot` the server picks a free slot itself and may evict an
 * unrelated session's cache. With `id_slot` we get explicit per-session
 * pinning: turn N+1 reuses turn N's cache iff both went to the same
 * slot.
 *
 * Slot allocation strategy: we maintain a `Map<sessionId, slotId>`. On
 * `buildRequestExtras`, return the existing mapping or allocate a fresh
 * slot id (round-robin within the configured slot count, recycling the
 * least-recently-used when we wrap). Slots are 0-indexed integers; the
 * default `--parallel` is 1, so we conservatively assume 1 slot until
 * the operator configures more.
 *
 * `cache_prompt: true` is always sent — that's the master switch for
 * cache reuse on llama-server. Without it, even slot pinning wouldn't
 * preserve KV state across requests.
 *
 * `reportUsage()` scrapes `/slots` (llama-server's introspection
 * endpoint) for per-slot cached-token counts. Mapping back to
 * sessionIds happens via our own `slotToSession` reverse map — the
 * server doesn't know our session ids.
 *
 * ## Disk persistence (Phase 1.2)
 *
 * llama-server supports per-slot save/restore via `POST
 * /slots/{id}?action=save&filename=…` (and `…?action=restore`) when
 * launched with `--slot-save-path <dir>`. The endpoint writes a small
 * binary file containing the slot's KV state; restore mmap-loads it
 * back into the slot in milliseconds. We wire this in:
 *
 *   - On evict (controller-driven LRU or LRU slot recycle): save the
 *     slot to `sess-<sessionId>.bin` before forgetting the mapping. The
 *     next time that session shows up, allocateSlot tries to restore
 *     from disk before binding the slot fresh.
 *   - On allocateSlot for a session we haven't seen: check disk for
 *     `sess-<sessionId>.bin`; restore into the chosen slot before
 *     binding so the session resumes exactly where it left off.
 *   - On shutdown: `flushAll()` saves every currently-bound slot, so
 *     the next supervisor boot can resume any session whose user comes
 *     back.
 *   - On first session-save for a given gezel: ALSO copy the file under
 *     `prefix-<hash>.bin`. New sessions for the same gezel restore that
 *     when no per-session cache exists; llama-server's `cache_prompt`
 *     prefix-matching reuses up to the system-prompt boundary even
 *     though the file holds a longer conversation. Net effect: cold-
 *     starting a fresh session for an existing gezel skips the
 *     system-prompt prefill entirely.
 */

import { createHash } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@bendyline/gezel';

// This layer is best-effort by design, but silent best-effort is
// unauditable: the 2026-08-03 KV-thrash investigation could not tell from
// any log whether save/restore ever ran, fired-and-failed, or latched
// unsupported — the answer had to be reverse-engineered from llama-server
// binary help and prefill chunk traces. Debug-level so steady-state stays
// quiet; the unsupported latch is a warn because it silently disables the
// whole disk layer for the process lifetime.
const log = createLogger('llama-kv-cache');

import type {
  CacheWarmMessage,
  EngineCacheAdapter,
  EngineCacheUsage,
  SystemPromptLayers,
} from '../../cache/adapter.js';

/**
 * Bytes-per-token estimate for llama.cpp KV cache. Default Q4_K_M-class
 * 7B-13B model weights round to roughly 100 KB / token of context. We
 * use the same conservative figure as the controller's default — the
 * estimate matters for telemetry, not correctness; any per-request
 * `/slots` poll surfaces the engine's view of cache size in tokens
 * which we multiply by this constant to get bytes.
 */
const ESTIMATED_BYTES_PER_TOKEN = 100 * 1024;

/** Filename for a session's saved slot cache. Kept stable so resume
 *  works across supervisor restarts. */
function sessFilename(sessionId: string): string {
  // sessionIds are uuid-shape so this is mostly cosmetic safety.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `sess-${safe}.bin`;
}

/** Filename for a per-gezel prefix slot cache. The hash is the same
 *  shape used by the MLX adapter so logs read consistently. */
function prefixFilename(prefixId: string): string {
  return `${prefixId}.bin`;
}

/**
 * Stable per-gezel prefix identifier. Hashes the verbatim system
 * prompt; drift produces a new id and a new disk file (the old one
 * becomes orphaned and is pruned by the disk-LRU eventually).
 */
export function llamaPrefixId(systemPrompt: string): string {
  const hex = createHash('sha256').update(systemPrompt, 'utf8').digest('hex');
  return `prefix-${hex.slice(0, 16)}`;
}

/**
 * Layered prefix ids (flag `layeredPrefixCache`). Distinct `gp` / `gezel`
 * namespaces so a gezel-layer disk file never collides with a
 * gezel+project-layer file. `gp` is the workhorse (full stable system,
 * shared across sessions of the same model+gezel+project); `gezel` is the
 * identity-only prefix (shared across projects of the same gezel).
 */
export function llamaLayerPrefixIds(layers: SystemPromptLayers): { gp: string; gezel: string } {
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
  return { gp: `prefix-gp-${h(layers.project)}`, gezel: `prefix-gezel-${h(layers.gezel)}` };
}

export interface LlamaCppCacheAdapterOptions {
  /**
   * URL the adapter polls for `/slots`. Resolved at construction time
   * from the same supervisor.resolveBaseUrl that powers the provider.
   * If null when `reportUsage` runs, we assume the engine isn't ready
   * yet and return an empty array (the controller treats it as "no warm
   * sessions" until the engine is up).
   */
  resolveBaseUrl: () => Promise<string | null>;
  /**
   * The token used by the daemon to gate /slots — same bearer the
   * provider uses for /v1/chat/completions.
   */
  resolveAuthToken?: () => string | null;
  /**
   * Number of slots llama-server has been configured with. Drives the
   * round-robin allocator's wrap-around. Defaults to 1 — matches
   * llama-server's default `--parallel 1`. Operators bumping
   * `--parallel` should pass the matching value here so we don't
   * starve.
   */
  slotCount?: number;
  /**
   * Directory passed to llama-server via `--slot-save-path`. When set,
   * the adapter persists slot state across evictions and supervisor
   * restarts. When null (e.g. external baseUrl mode where we don't
   * control the launch), persistence is silently disabled and the
   * adapter behaves like Phase 1.
   */
  slotSavePath?: string;
  /** Replaceable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class LlamaCppCacheAdapter implements EngineCacheAdapter {
  readonly providerName = 'llama-cpp' as const;
  private readonly sessionToSlot = new Map<string, number>();
  private readonly slotToSession = new Map<number, string>();
  /** Slot LRU — the head is the oldest assignment, evicted first on wrap. */
  private readonly slotOrder: number[] = [];
  private nextSlotToTry = 0;
  /**
   * Allocation includes asynchronous disk restore work. Without a small
   * critical section, two callers can both observe the same slot as free
   * before either one reaches {@link bind}, then issue concurrent requests
   * with the same explicit `id_slot`. Keep the allocator itself serial while
   * still allowing the provider to stream on all configured engine slots once
   * each mapping has been established.
   */
  private allocationTail: Promise<void> = Promise.resolve();
  private readonly slotCount: number;
  private readonly resolveBaseUrl: LlamaCppCacheAdapterOptions['resolveBaseUrl'];
  private readonly resolveAuthToken: () => string | null;
  private readonly fetchImpl: typeof fetch;
  /** Directory used by llama-server's --slot-save-path. */
  private readonly slotSavePath?: string;
  /** Per-session prefix mapping for cross-session cache sharing. */
  private readonly sessionPrefix = new Map<string, string>();
  /**
   * Per-session LAYERED prefix ids (flag ON), ordered most-specific-first
   * (`[gp, gezel]`). `tryRestoreForSession` walks them after the
   * per-session file so a new session inherits the warmest matching layer.
   */
  private readonly sessionLayerPrefixes = new Map<string, string[]>();
  /** Tracks which prefix files have been seeded on disk this process. */
  private readonly seededPrefixes = new Set<string>();
  /**
   * Sessions we've successfully restored from disk this process. We
   * track these so the next save also seeds the prefix file (if the
   * session arrived from a supervisor-restart resume, the prefix file
   * may have been pruned in between — re-seeding keeps it warm).
   */
  private readonly restoredSessions = new Set<string>();
  /**
   * Latched off when this llama-server refuses slot save/restore (501
   * "This feature is not supported by multimodal" — fires for mmproj-
   * backed models like nemotron-nano-30b). Without the latch we'd POST
   * to /slots/{id}?action=save+restore on every turn, spamming the
   * server log with the same 501 and adding 5-15ms of useless
   * roundtrip. Wild-caught nemotron-nano tankcombat
   * run: `srv send_error: task id = X, error: This feature is not
   * supported by multimodal` fired on every turn. Once any slot action
   * returns a 501, we stop trying for the rest of the process — the
   * server's capability doesn't change at runtime.
   */
  private slotActionsUnsupported = false;

  constructor(opts: LlamaCppCacheAdapterOptions) {
    this.resolveBaseUrl = opts.resolveBaseUrl;
    this.resolveAuthToken = opts.resolveAuthToken ?? (() => null);
    this.slotCount = Math.max(1, opts.slotCount ?? 1);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.slotSavePath) this.slotSavePath = opts.slotSavePath;
  }

  /**
   * Register the gezel-prefix mapping for a session. Called by the
   * session implementation before each send so the adapter knows where
   * to find the prefix file when (re)allocating a slot for this session.
   */
  setSessionPrefix(sessionId: string, systemPrompt: string): string {
    const prefixId = llamaPrefixId(systemPrompt);
    this.sessionPrefix.set(sessionId, prefixId);
    return prefixId;
  }

  /**
   * Async session prep. Sessions call this once before each send so
   * the adapter can:
   *   1. Register the gezel-prefix mapping (cheap, in-memory).
   *   2. Allocate a slot for this session if not already bound,
   *      recycling the LRU victim (saving its state to disk first).
   *   3. Try to restore the freshly-allocated slot from disk: per-
   *      session file first, then gezel-prefix file. Either fills
   *      the slot's KV state with a useful starting point so
   *      llama-server's `cache_prompt` reuses the matching prefix on
   *      the next request.
   *
   * Idempotent for already-bound sessions — fast in-memory promote
   * with no I/O. Sessions await this; `buildRequestExtras` then reads
   * the resolved slot mapping synchronously.
   */
  async prepareForSend(
    sessionId: string,
    systemPrompt?: string,
    layers?: SystemPromptLayers,
  ): Promise<void> {
    if (layers) {
      const { gp, gezel } = llamaLayerPrefixIds(layers);
      // Most-specific first: a restore tries gp (full stable system) then
      // gezel (identity only).
      this.sessionLayerPrefixes.set(sessionId, [gp, gezel]);
      // The legacy single-prefix path seeds the most-specific (gp) file on
      // save, so set sessionPrefix to gp too.
      this.sessionPrefix.set(sessionId, gp);
    } else if (systemPrompt) {
      this.setSessionPrefix(sessionId, systemPrompt);
    }
    await this.allocateSlot(sessionId);
  }

  buildRequestExtras(sessionId: string): Record<string, unknown> {
    // Sync path: assumes prepareForSend has already run for new
    // sessions. If not (test paths, code that skipped prep), fall back
    // to the in-memory-only allocator that doesn't touch disk.
    const slot = this.allocateSlotInMemory(sessionId);
    return {
      cache_prompt: true,
      // Promote this session in our LRU — recently-used slots are
      // last to recycle.
      id_slot: slot,
    };
  }

  async evict(sessionIds: readonly string[]): Promise<void> {
    // Save before forgetting so the session can resume on next access.
    // Persistence is best-effort; failures are logged and the local
    // mapping is still cleared (controller view stays consistent).
    for (const id of sessionIds) {
      const slot = this.sessionToSlot.get(id);
      if (slot === undefined) continue;
      await this.saveSlotForSession(slot, id);
      this.sessionToSlot.delete(id);
      this.slotToSession.delete(slot);
      const idx = this.slotOrder.indexOf(slot);
      if (idx !== -1) this.slotOrder.splice(idx, 1);
      this.sessionPrefix.delete(id);
      this.sessionLayerPrefixes.delete(id);
      this.restoredSessions.delete(id);
    }
  }

  async reportUsage(): Promise<readonly EngineCacheUsage[]> {
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return [];
    let res: Response;
    try {
      const token = this.resolveAuthToken();
      res = await this.fetchImpl(`${baseUrl}/slots`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
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
    const now = Date.now();
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const slot = (entry as Record<string, unknown>).id;
      const cachedTokens = (entry as Record<string, unknown>).n_cache_tokens;
      if (typeof slot !== 'number' || typeof cachedTokens !== 'number' || cachedTokens <= 0) {
        continue;
      }
      const sessionId = this.slotToSession.get(slot);
      if (!sessionId) continue;
      usage.push({
        sessionId,
        tokenCount: cachedTokens,
        estBytes: cachedTokens * ESTIMATED_BYTES_PER_TOKEN,
        // /slots doesn't report a wall-clock; use our local "last
        // touched" approximation. Good enough for LRU comparisons.
        lastUsedAt: now,
      });
    }
    return usage;
  }

  async warm(_sessionId: string, _messages: readonly CacheWarmMessage[]): Promise<void> {
    // llama-server doesn't expose a dedicated warm endpoint and the
    // n_predict:0 trick on /v1/completions would still need to claim
    // a slot exclusively — risking starvation of real sessions on
    // tight slot budgets. Phase 1.3 instead establishes prefix files
    // as a side effect of the first session save (see saveSlotForSession),
    // which pays no extra HTTP round-trip on hot path. Subsequent
    // session opens for the same gezel restore the prefix file on
    // allocate.
  }

  /**
   * Flush every currently-bound slot to disk. Called by the provider's
   * shutdown path so a clean supervisor stop preserves all live
   * sessions for the next boot.
   */
  async flushAll(): Promise<number> {
    if (!this.slotSavePath) return 0;
    let saved = 0;
    for (const [sessionId, slot] of this.sessionToSlot) {
      if (await this.saveSlotForSession(slot, sessionId)) saved++;
    }
    return saved;
  }

  /**
   * Async path: allocate a slot for `sessionId`, save the LRU victim
   * (if any) to disk, and try to restore the new slot from disk
   * (per-session file or gezel-prefix file). Called from
   * {@link prepareForSend}.
   */
  private async allocateSlot(sessionId: string): Promise<number> {
    const previous = this.allocationTail;
    let release!: () => void;
    this.allocationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await this.allocateSlotUnlocked(sessionId);
    } finally {
      release();
    }
  }

  private async allocateSlotUnlocked(sessionId: string): Promise<number> {
    const existing = this.sessionToSlot.get(sessionId);
    if (existing !== undefined) {
      // Promote in LRU.
      const idx = this.slotOrder.indexOf(existing);
      if (idx !== -1) this.slotOrder.splice(idx, 1);
      this.slotOrder.push(existing);
      return existing;
    }

    // First, claim any unused slot.
    let chosen: number | null = null;
    if (this.sessionToSlot.size < this.slotCount) {
      for (let s = 0; s < this.slotCount; s++) {
        if (!this.slotToSession.has(s)) {
          chosen = s;
          break;
        }
      }
    }

    // All slots taken — recycle the LRU slot. Save victim to disk
    // before recycling so it can resume on next access.
    if (chosen === null) {
      const victimSlot = this.slotOrder.shift();
      if (victimSlot === undefined) {
        // Shouldn't happen — if all slots are bound, slotOrder must be
        // populated. Fall back to round-robin to stay alive.
        chosen = this.nextSlotToTry % this.slotCount;
        this.nextSlotToTry++;
      } else {
        chosen = victimSlot;
      }
      const victimSession = this.slotToSession.get(chosen);
      if (victimSession !== undefined) {
        const saved = await this.saveSlotForSession(chosen, victimSession);
        log.debug(
          `slot ${chosen} recycled: evicting session ${victimSession.slice(0, 8)} for ${sessionId.slice(0, 8)} (disk save: ${saved ? 'ok' : 'MISSED'})`,
        );
        this.sessionToSlot.delete(victimSession);
        this.slotToSession.delete(chosen);
      }
    }

    // We now have a slot id `chosen` that's free of any current binding.
    // Try to restore: per-session file first, then gezel-prefix file.
    // Restore is best-effort; failure leaves the slot empty and the
    // next request just prefills from scratch.
    const restored = await this.tryRestoreForSession(chosen, sessionId);
    if (restored) this.restoredSessions.add(sessionId);
    log.debug(
      `slot ${chosen} bound to session ${sessionId.slice(0, 8)} (disk restore: ${restored ? 'hit' : 'none — next request prefills from scratch'})`,
    );

    this.bind(sessionId, chosen);
    return chosen;
  }

  /**
   * Synchronous fallback. Used by {@link buildRequestExtras} so the
   * existing call sites that don't await `prepareForSend` (unit tests,
   * code paths that don't have a system prompt to share) still get a
   * deterministic slot assignment. No disk I/O — just the in-memory
   * LRU allocator we shipped in Phase 1.
   */
  private allocateSlotInMemory(sessionId: string): number {
    const existing = this.sessionToSlot.get(sessionId);
    if (existing !== undefined) {
      const idx = this.slotOrder.indexOf(existing);
      if (idx !== -1) this.slotOrder.splice(idx, 1);
      this.slotOrder.push(existing);
      return existing;
    }
    if (this.sessionToSlot.size < this.slotCount) {
      for (let s = 0; s < this.slotCount; s++) {
        if (!this.slotToSession.has(s)) {
          this.bind(sessionId, s);
          return s;
        }
      }
    }
    const victimSlot = this.slotOrder.shift();
    if (victimSlot === undefined) {
      const slot = this.nextSlotToTry % this.slotCount;
      this.nextSlotToTry++;
      this.evictSlot(slot);
      this.bind(sessionId, slot);
      return slot;
    }
    this.evictSlot(victimSlot);
    this.bind(sessionId, victimSlot);
    return victimSlot;
  }

  private evictSlot(slot: number): void {
    const prev = this.slotToSession.get(slot);
    if (prev === undefined) return;
    this.sessionToSlot.delete(prev);
    this.slotToSession.delete(slot);
  }

  private bind(sessionId: string, slot: number): void {
    this.sessionToSlot.set(sessionId, slot);
    this.slotToSession.set(slot, sessionId);
    this.slotOrder.push(slot);
  }

  /**
   * POST /slots/{id}?action=save with the session's stable filename.
   * Also seeds the prefix-<hash>.bin file on the FIRST save for a
   * given gezel-prefix this process — subsequent sessions sharing the
   * prefix can then restore that file on allocate. Returns true on
   * success.
   */
  private async saveSlotForSession(slot: number, sessionId: string): Promise<boolean> {
    if (!this.slotSavePath) return false;
    if (this.slotActionsUnsupported) return false;
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return false;
    const filename = sessFilename(sessionId);
    const ok = await this.invokeSlotAction(baseUrl, slot, 'save', filename);
    if (!ok) return false;

    // Seed the gezel prefix file on first save. We use copyFile (not
    // hardlink) so a future session's slot save under sess-<id>.bin
    // can't truncate-overwrite the prefix file via shared inode.
    // Skipped if the prefix file already exists (best-effort stat
    // check) so we only pay the extra copy cost once per gezel-prefix
    // per process.
    const prefixId = this.sessionPrefix.get(sessionId);
    if (prefixId && !this.seededPrefixes.has(prefixId)) {
      const sessPath = join(this.slotSavePath, filename);
      const prefixPath = join(this.slotSavePath, prefixFilename(prefixId));
      try {
        // Skip if a file with this prefix name already exists from a
        // prior process — we don't need to overwrite a sibling save.
        const existing = await stat(prefixPath).catch(() => null);
        if (!existing) {
          await copyFile(sessPath, prefixPath);
        }
        this.seededPrefixes.add(prefixId);
      } catch {
        // Disk-level errors here are silent — the per-session file
        // saved fine, prefix sharing just doesn't kick in this turn.
      }
    }
    return true;
  }

  /** Try restore-by-session, then restore-by-prefix. Returns true if
   *  any restore succeeded. */
  private async tryRestoreForSession(slot: number, sessionId: string): Promise<boolean> {
    if (!this.slotSavePath) return false;
    if (this.slotActionsUnsupported) return false;
    const baseUrl = await this.resolveBaseUrl().catch(() => null);
    if (!baseUrl) return false;

    const sessPath = join(this.slotSavePath, sessFilename(sessionId));
    if (await stat(sessPath).catch(() => null)) {
      const ok = await this.invokeSlotAction(baseUrl, slot, 'restore', sessFilename(sessionId));
      if (ok) return true;
    }
    // Layered cascade (flag ON): try most-specific (gp) then gezel. Once a
    // layer file restores, llama-server's `cache_prompt` LCP-matches it
    // against the actual prompt and reuses the common leading prefix.
    const layered = this.sessionLayerPrefixes.get(sessionId);
    if (layered && layered.length > 0) {
      for (const pid of layered) {
        const path = join(this.slotSavePath, prefixFilename(pid));
        if (!(await stat(path).catch(() => null))) continue;
        if (await this.invokeSlotAction(baseUrl, slot, 'restore', prefixFilename(pid))) return true;
      }
      return false;
    }
    const prefixId = this.sessionPrefix.get(sessionId);
    if (!prefixId) return false;
    const prefixPath = join(this.slotSavePath, prefixFilename(prefixId));
    if (!(await stat(prefixPath).catch(() => null))) return false;
    return this.invokeSlotAction(baseUrl, slot, 'restore', prefixFilename(prefixId));
  }

  /**
   * POST /slots/{id}?action={save|restore} with `{filename}` body.
   * llama-server returns 200 on success or 4xx/5xx with a JSON error
   * payload on failure (e.g. file missing on restore, server lacks
   * --slot-save-path). All failures are best-effort: the caller treats
   * them as "no cache" and proceeds.
   */
  private async invokeSlotAction(
    baseUrl: string,
    slot: number,
    action: 'save' | 'restore',
    filename: string,
  ): Promise<boolean> {
    const token = this.resolveAuthToken();
    try {
      const res = await this.fetchImpl(`${baseUrl}/slots/${slot}?action=${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) {
        // 501 Not Implemented (or 5xx with a multimodal-specific body)
        // means this server permanently refuses slot save/restore — flip
        // the latch so we stop trying for the rest of the process.
        // Reading the body is best-effort; if anything throws we still
        // latch on the bare status because that's the unambiguous
        // server-side capability gate.
        if (res.status === 501) {
          this.slotActionsUnsupported = true;
        } else if (res.status >= 500) {
          try {
            const body = await res.text();
            if (/not supported by multimodal/i.test(body)) {
              this.slotActionsUnsupported = true;
            }
          } catch {
            // ignore — `res.ok` is already false, the action failed
          }
        }
        if (this.slotActionsUnsupported) {
          log.warn(
            `slot ${action} returned ${res.status}: server refuses slot save/restore — disk persistence disabled for this process`,
          );
        } else {
          log.debug(`slot ${action} slot=${slot} file=${filename} failed: HTTP ${res.status}`);
        }
      }
      return res.ok;
    } catch {
      return false;
    }
  }
}
