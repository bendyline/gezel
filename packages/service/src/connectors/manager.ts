/**
 * The connector sync engine — the scope→changes→fetch→write loop, extracted
 * verbatim from `MailManager.syncAccount`. Per scope: list changes since the
 * cursor, take the newest `backfillLimit` (older overflow is counted skipped),
 * fetch + normalize + write each, and **advance that scope's cursor ONLY when
 * the whole batch landed with zero errors** — on any failure the prior cursor is
 * kept so the batch retries next sync (the writer is idempotent, so already-
 * written records dedupe rather than the failed one being skipped forever).
 *
 * `syncWithAdapter` is pure over a `ConnectorAdapter` + a fake writer seam, so it
 * is unit-testable without a real source (see `manager.test.ts`). The project-
 * level `ConnectorManager` (binding fan-out, persistence) lands in Phase 2.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ConnectorTypeManifest,
  LiveBindingStatus,
  ProjectConnectorBinding,
  ProjectDetail,
} from '@bendyline/gezel';
import {
  HttpStatusError,
  KeyedLock,
  backoffDelayMs,
  createLogger,
  isRateLimitStatus,
  retryTransient,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import {
  listPartitionFiles,
  listPartitions,
  listTables,
  partitionValueFromDir,
  readTableManifest,
  readTableState,
} from '../observations/layout.js';
import { type ObservationWriteSummary, ObservationWriter } from '../observations/writer.js';
import { normalizeHttpsOrigin } from '../secrets/origins.js';
import { validateConnectorConfig } from './config-validate.js';
import { McpConnectorAdapter } from './drivers/mcp.js';
import { ScriptConnectorAdapter } from './drivers/script.js';
import { SpectralConnectorAdapter } from './drivers/spectral.js';
import { ReconnectRequiredError } from './natives/oauth-session.js';
import {
  type LongLivedExchange,
  type OAuthEndpoints,
  buildAuthorizeUrl,
  createPkce,
  exchangeAuthCode,
  exchangeLongLivedToken,
  parseLongLivedExchange,
  randomState,
  resolveOAuthClient,
  validateOAuthEndpoints,
} from './oauth.js';
import { NATIVE_ADAPTERS, connectorCredentialName, connectorSecretKey } from './registry.js';
import { connectorCorpusStorage } from './storage.js';
import {
  type AdapterDeps,
  type ConnectorAdapter,
  type ConnectorBindingRef,
  type ConnectorRecord,
  type NormalizedRecord,
  RecordGoneError,
  isObservationRecord,
} from './types.js';
import {
  type PruneInput,
  type PruneResult,
  type SweepInput,
  type WriteRecordResult,
  writeRecord as defaultWriteRecord,
  pruneRecords,
  sha8,
  slug,
  sweepRecords,
} from './writer.js';

const log = createLogger('connectors');

const DEFAULT_BACKFILL_LIMIT = 500;

/**
 * Resolve a connector type's declared `allowedOrigins` against a binding's
 * config. Entries are literal HTTPS origins or `$config.<dot.path>`
 * placeholders (GitHub Enterprise's `apiBaseUrl` is the motivating case).
 * Invalid or unresolvable entries are dropped with a warning — an authored
 * typo must degrade to "that origin isn't allowed", never to a write of a
 * non-origin into the project's allowlist (the project schema would reject
 * the whole patch).
 */
export function resolveDeclaredOrigins(
  manifest: Pick<ConnectorTypeManifest, 'allowedOrigins' | 'id'>,
  config: Record<string, unknown> | undefined,
): string[] {
  const out: string[] = [];
  for (const entry of manifest.allowedOrigins ?? []) {
    let raw = entry;
    if (entry.startsWith('$config.')) {
      let value: unknown = config ?? {};
      for (const part of entry.slice('$config.'.length).split('.')) {
        value =
          value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
      }
      if (typeof value !== 'string' || !value) continue; // unset optional config — not an error
      raw = value;
    }
    const origin = normalizeHttpsOrigin(raw);
    if (origin) {
      if (!out.includes(origin)) out.push(origin);
    } else {
      log.warn(`connector ${manifest.id}: dropped invalid allowedOrigins entry '${entry}'`);
    }
  }
  return out;
}

/**
 * Corpus root for a binding: `data/<slug(displayName || type)>`, suffixed
 * `-2`/`-3`… on collision with another binding's persisted root. Resolved once
 * (at bind time, or lazily for pre-corpusDir bindings) and persisted — never
 * recomputed, so renames don't strand corpora.
 */
export function resolveCorpusDir(
  existing: Pick<ProjectConnectorBinding, 'corpusDir'>[],
  type: string,
  displayName?: string,
): string {
  const taken = new Set(existing.map((b) => b.corpusDir).filter(Boolean));
  const base = `data/${displayName?.trim() ? slug(displayName) : slug(type)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The corpus root to use for a binding right now: the persisted `corpusDir`,
 * or the deterministic resolution a future sync will persist. Shared with the
 * action manager so drafts and records always land in the same corpus.
 */
export function corpusDirFor(
  bindings: ProjectConnectorBinding[],
  binding: ProjectConnectorBinding,
): string {
  if (binding.corpusDir) return binding.corpusDir;
  return resolveCorpusDir(
    bindings.filter((b) => b.id !== binding.id),
    binding.type,
    binding.displayName,
  );
}

export interface SyncBindingOptions<Cur = unknown, Rec = NormalizedRecord> {
  /** Project artifacts root where this connector's corpus lands. */
  storageDir: string;
  /** Resolved workspace root used only for quarantined raw bodies. */
  quarantineDir: string;
  /** Top dir under artifacts where this connector's corpus lands. */
  corpusDir: string;
  /**
   * When true (the default), the engine owns the scope directory level: each
   * scope's records land under `<corpusDir>/<slug(scope)>/` (omitted for the
   * single empty scope). Adapters must not re-derive the scope in
   * `dirSegments`.
   */
  scopeAsDir?: boolean;
  /**
   * When true (the default), the persisted cursor is a per-scope envelope
   * (`{v: 2, scopes: {...}}`) and each scope only ever sees the cursor it last
   * returned. The opt-out exists for tests that assert flat-cursor threading.
   */
  scopedCursors?: boolean;
  /**
   * Permit pruning records the source no longer returns. Set only for
   * mirror-completeness types; the engine additionally requires a clean,
   * single-batch, full-enumeration pass (`enumeratedAll`, no overflow, zero
   * errors) before it prunes a scope.
   */
  allowPrune?: boolean;
  /**
   * Restrict this pass to specific scopes instead of everything
   * `listScopes()` returns. A requested scope the adapter didn't list is
   * still synced — the caller is naming something it knows about (a task
   * launching against PR #123 the window has already scrolled past), and
   * silently syncing nothing would leave the caller waiting on a corpus
   * that never appears. Absent = every listed scope, the ambient pass.
   */
  scopes?: readonly string[];
  /** Newest-N cap per scope on each round. */
  backfillLimit: number;
  /** Starting cursor (opaque, adapter-shaped). */
  cursor: Cur | undefined;
  /**
   * Injectable writer — defaults to the real `writeRecord` (tests pass a fake).
   * Generic in the record type so an observation corpus can supply a writer
   * that appends rows instead of writing one markdown file per record; every
   * other concern in the pass (scopes, cursors, paging, retry, rate limits)
   * is shape-independent and reused verbatim.
   */
  write?: (input: {
    storageDir: string;
    quarantineDir: string;
    corpusDir: string;
    record: Rec;
  }) => Promise<WriteRecordResult>;
  /** Injectable pruner — defaults to the real `pruneRecords`. */
  prune?: (input: PruneInput) => Promise<PruneResult>;
  /**
   * Injectable record sweeper for source tombstones (`ChangeBatch.removed`)
   * and moved-record cleanup — defaults to the real `sweepRecords`.
   */
  sweep?: (input: SweepInput) => Promise<{ removed: number }>;
}

export interface BindingSyncResult<Cur = unknown> {
  written: number;
  quarantined: number;
  skipped: number;
  /** Records removed from the corpus: a mirror prune or a source tombstone. */
  pruned: number;
  errors: number;
  /**
   * Records given up on this pass: each failed in {@link POISON_RECORD_PASSES}
   * separate passes while the rest of its batch landed, so the scope's
   * cursor moved past it rather than retrying the whole batch forever.
   */
  abandoned?: { scope: string; id: string }[];
  /** Scopes whose listing failed this pass; the others still synced. */
  failedScopes?: { scope: string; message: string }[];
  /** Advanced cursor to persist. */
  cursor: Cur | undefined;
  /** Scopes the pass covered (feeds the corpus `_meta.json`). */
  scopes?: string[];
  /**
   * The source rate-limited the pass: what it returned was written and the
   * cursor persisted, but remaining scopes were left for later. The manager
   * backs the binding off before its next autonomous sync.
   */
  rateLimited?: boolean;
  /** Hard failure (auth / list) message, when the whole pass aborted. */
  error?: string;
}

/** Persisted shape of a per-scope cursor envelope. */
export interface ScopedCursor {
  v: 2;
  scopes: Record<string, unknown>;
  /**
   * Per scope, how many separate passes each still-failing record ref has
   * failed in while the rest of its batch landed. Cleared when the scope's
   * cursor advances. Absent when nothing is failing.
   */
  failures?: Record<string, Record<string, number>>;
}

function asFailureCounts(raw: unknown): ScopedCursor['failures'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const out: NonNullable<ScopedCursor['failures']> = {};
  for (const [scope, counts] of Object.entries(raw as Record<string, unknown>)) {
    if (counts === null || typeof counts !== 'object') continue;
    const kept: Record<string, number> = {};
    for (const [id, n] of Object.entries(counts as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) kept[id] = n;
    }
    if (Object.keys(kept).length > 0) out[scope] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read a persisted cursor as a per-scope envelope. Anything that isn't a v2
 * envelope (including pre-envelope flat cursors) is discarded — the writer's
 * idempotency makes the resulting re-backfill safe, just a wasted re-fetch.
 */
export function asScopedCursor(raw: unknown): ScopedCursor {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    (raw as ScopedCursor).v === 2 &&
    typeof (raw as ScopedCursor).scopes === 'object' &&
    (raw as ScopedCursor).scopes !== null
  ) {
    const failures = asFailureCounts((raw as ScopedCursor).failures);
    return {
      v: 2,
      scopes: { ...(raw as ScopedCursor).scopes },
      ...(failures ? { failures } : {}),
    };
  }
  return { v: 2, scopes: {} };
}

/** Max same-scope continuation rounds per pass when an adapter pages via `partial`. */
const MAX_PARTIAL_ROUNDS = 4;

/**
 * Passes a single record may fail in — while others in its batch land —
 * before the engine stops holding the scope's cursor for it. Without this
 * limit one message mailparser cannot read, or one event the source always
 * 500s on, holds the cursor forever and re-fetches the whole batch every
 * pass. A batch where nothing landed never counts: that is an outage, not
 * a bad record.
 */
export const POISON_RECORD_PASSES = 3;

const normRel = (p: string): string => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

const SCOPE_DIR_MAX = 48;

/**
 * The directory a scope's records land in. A scope whose slug fits keeps it
 * verbatim (existing corpora never move); a longer one is cut and suffixed
 * with a hash of the full scope, because long scopes tend to share their
 * first 48 characters — Graph calendar and folder ids carry a per-mailbox
 * prefix, and every YouTube channel feed URL starts the same way — and plain
 * truncation filed them all into one folder.
 */
export function scopeDirName(scope: string): string {
  const full = slug(scope, 400);
  if (full.length <= SCOPE_DIR_MAX) return full;
  return `${full.slice(0, SCOPE_DIR_MAX - 9).replace(/-+$/, '')}-${sha8(scope)}`;
}

/**
 * Run one sync pass for a single binding through its adapter. Always calls
 * `adapter.close()`. Never throws — hard failures land in `result.error` with
 * the cursor left unadvanced.
 *
 * Cursor discipline: each scope only ever sees the cursor it last returned
 * (per-scope envelope), and a scope's cursor advances only when its whole
 * batch fetched + wrote with zero errors — on failure the prior cursor is kept
 * so the batch retries next pass (the writer is idempotent, so already-written
 * records dedupe rather than the failed one being skipped forever).
 */
export async function syncWithAdapter<Cur = unknown, Rec = NormalizedRecord>(
  adapter: ConnectorAdapter<Rec, Cur>,
  opts: SyncBindingOptions<Cur, Rec>,
): Promise<BindingSyncResult<Cur>> {
  // The default writer is the markdown-per-record one, reachable only when
  // `Rec` is `NormalizedRecord` — i.e. every document adapter. Observation
  // callers always inject a row-appending writer, so the cast is narrowing a
  // default that their code path never reaches.
  const write =
    opts.write ??
    (defaultWriteRecord as unknown as NonNullable<SyncBindingOptions<Cur, Rec>['write']>);
  const prune = opts.prune ?? pruneRecords;
  const sweep = opts.sweep ?? sweepRecords;
  const scoped = opts.scopedCursors ?? true;
  const envelope = scoped ? asScopedCursor(opts.cursor) : null;
  const result: BindingSyncResult<Cur> = {
    written: 0,
    quarantined: 0,
    skipped: 0,
    pruned: 0,
    errors: 0,
    cursor: scoped ? (envelope as unknown as Cur) : opts.cursor,
  };
  // Legacy (non-scoped) mode threads one flat cursor through the pass.
  let flatCursor: Cur | undefined = opts.cursor;

  try {
    await adapter.ensureAuth();
    const listed = await adapter.listScopes();
    const requested = opts.scopes;
    const scopes = requested
      ? [...new Set([...listed.filter((s) => requested.includes(s)), ...requested])]
      : listed;
    result.scopes = scopes;
    const failedScopes: { scope: string; message: string }[] = [];
    outer: for (const scope of scopes) {
      const scopeCorpusDir =
        (opts.scopeAsDir ?? true) && scope !== ''
          ? `${opts.corpusDir}/${scopeDirName(scope)}`
          : opts.corpusDir;
      for (let round = 0; round < MAX_PARTIAL_ROUNDS; round++) {
        const before = scoped ? (envelope!.scopes[scope] as Cur | undefined) : flatCursor;
        let changes: Awaited<ReturnType<typeof adapter.listChangesSince>>;
        try {
          changes = await adapter.listChangesSince(scope, before, {
            limit: opts.backfillLimit,
          });
        } catch (err) {
          // A throttle is backpressure for the whole binding, and a dead grant
          // fails every scope alike — both end the pass, not just this scope.
          if (err instanceof HttpStatusError && isRateLimitStatus(err.status)) throw err;
          if (err instanceof ReconnectRequiredError) throw err;
          // One broken feed, calendar, or folder must not stop the others:
          // this scope keeps its cursor and the rest of the pass continues.
          const message = err instanceof Error ? err.message : String(err);
          failedScopes.push({ scope, message });
          result.errors++;
          log.warn(`${adapter.typeId} ${scope || '(default)'}: listing failed: ${message}`);
          continue outer;
        }
        // Newest-first, bounded by the backfill cap. Overflow past the cap is
        // deliberate windowing (the mail backfill-cap model) but never silent:
        // it is counted skipped and logged.
        const ordered = [...changes.records].sort(
          (a, b) => (b.ordinalKey ?? 0) - (a.ordinalKey ?? 0),
        );
        const take = ordered.slice(0, opts.backfillLimit);
        const overflow = ordered.length - take.length;
        if (overflow > 0) {
          result.skipped += overflow;
          log.warn(
            `${adapter.typeId} ${scope || '(default)'}: ${overflow} record(s) past the ` +
              `${opts.backfillLimit}-record cap were skipped this pass (adapter returned ` +
              `${ordered.length}; page with 'partial' to backfill completely)`,
          );
        }
        let scopeErrors = 0;
        let landed = 0;
        const failedRefs: string[] = [];
        const seenHashes = new Set<string>();
        /** hash8 → relPath of records written fresh at a (possibly new) path. */
        const newlyPlaced = new Map<string, string>();
        const failureCounts = scoped ? envelope!.failures?.[scope] : undefined;
        for (const ref of take) {
          try {
            // Transient faults (5xx/408/429, socket drops) get three attempts
            // with jittered backoff; real errors rethrow immediately.
            const record = await retryTransient(() => adapter.fetchRecord(scope, ref), {
              attempts: 3,
              label: `${adapter.typeId} record ${ref.id}`,
            });
            // Prune identity is a document-corpus concept: `pruneRecords`
            // matches on the markdown filename grammar, and observation
            // corpora never set `allowPrune`. A record without a `recordId`
            // therefore contributes nothing to keep — skip it rather than
            // hashing `undefined`.
            const recordId = (record as Partial<NormalizedRecord>).recordId;
            if (typeof recordId === 'string') seenHashes.add(sha8(recordId));
            const w = await write({
              storageDir: opts.storageDir,
              quarantineDir: opts.quarantineDir,
              corpusDir: scopeCorpusDir,
              record,
            });
            if (w.status === 'written' || w.status === 'refreshed') result.written++;
            else if (w.status === 'quarantined') result.quarantined++;
            else result.skipped++;
            if (
              adapter.recordsMayMove &&
              typeof recordId === 'string' &&
              w.relPath &&
              w.status !== 'exists'
            ) {
              newlyPlaced.set(sha8(recordId), normRel(w.relPath));
            }
            landed++;
            if (failureCounts) delete failureCounts[ref.id];
          } catch (err) {
            if (err instanceof RecordGoneError) {
              result.skipped++;
              landed++;
              log.info(
                `${adapter.typeId} ${scope || '(default)'}: ${ref.id} is gone upstream; skipped`,
              );
              continue;
            }
            scopeErrors++;
            result.errors++;
            failedRefs.push(ref.id);
            log.warn(`fetch/write failed (${adapter.typeId} ${scope} id ${ref.id}): ${err}`);
          }
        }
        // Poison records: a ref that keeps failing while its neighbors land
        // stops holding the cursor after POISON_RECORD_PASSES passes.
        if (scoped && failedRefs.length > 0 && landed > 0) {
          const failures = envelope!.failures ?? {};
          envelope!.failures = failures;
          const counts = failures[scope] ?? {};
          failures[scope] = counts;
          for (const id of failedRefs) {
            const n = (counts[id] ?? 0) + 1;
            counts[id] = n;
            if (n >= POISON_RECORD_PASSES) {
              scopeErrors--;
              result.skipped++;
              result.abandoned = [...(result.abandoned ?? []), { scope, id }];
              log.warn(
                `${adapter.typeId} ${scope || '(default)'}: giving up on record ${id} after ` +
                  `${n} failed passes; the cursor moves past it`,
              );
            }
          }
        }
        // Tombstones and moved records, in one walk of the scope. A record the
        // batch both removed and re-fetched is kept.
        const removedHashes = new Set(
          (changes.removed ?? []).map((id) => sha8(id)).filter((h) => !seenHashes.has(h)),
        );
        if (removedHashes.size > 0 || newlyPlaced.size > 0) {
          let tombstoned = 0;
          try {
            await sweep({
              storageDir: opts.storageDir,
              corpusDir: scopeCorpusDir,
              remove: (hash8, relPath) => {
                if (removedHashes.has(hash8)) {
                  tombstoned++;
                  return true;
                }
                const kept = newlyPlaced.get(hash8);
                return kept !== undefined && kept !== normRel(relPath);
              },
            });
            result.pruned += tombstoned;
          } catch (err) {
            scopeErrors++;
            result.errors++;
            log.warn(`record sweep failed (${adapter.typeId} ${scope}): ${err}`);
          }
        }
        // Advance only on a clean batch; otherwise keep the prior cursor so
        // the batch retries next pass.
        if (scopeErrors === 0) {
          if (scoped) {
            envelope!.scopes[scope] = changes.cursor;
            if (envelope!.failures) {
              delete envelope!.failures[scope];
              if (Object.keys(envelope!.failures).length === 0) delete envelope!.failures;
            }
          } else flatCursor = changes.cursor;
        }
        // Mirror prune: only after a clean, single-batch, full enumeration of
        // the scope — anything less and absence from the batch proves nothing.
        if (
          opts.allowPrune &&
          changes.enumeratedAll &&
          !changes.partial &&
          round === 0 &&
          scopeErrors === 0 &&
          overflow === 0
        ) {
          const p = await prune({
            storageDir: opts.storageDir,
            corpusDir: scopeCorpusDir,
            keepHashes: seenHashes,
          });
          result.pruned += p.pruned;
        }
        // Rate limited: what the source returned is written and its cursor
        // persisted; stop the whole pass and let the manager back off.
        if (changes.rateLimited) {
          result.rateLimited = true;
          break outer;
        }
        // Continue the same scope only when the adapter paged cleanly and
        // declared more; leftover pages resume on the next tick.
        if (scopeErrors !== 0 || !changes.partial) break;
      }
    }
    if (failedScopes.length > 0) {
      result.failedScopes = failedScopes;
      // Every scope failing is a failed pass; some failing is a partial one
      // (`partialFailureNote` names them while the others count as synced).
      if (failedScopes.length === scopes.length) {
        const messages = [...new Set(failedScopes.map((f) => f.message))];
        result.error =
          scopes.length === 1 || messages.length === 1
            ? messages[0]!
            : failedScopes
                .map((f) => `${f.scope}: ${f.message}`)
                .join('; ')
                .slice(0, 600);
      }
    }
    result.cursor = scoped ? (envelope as unknown as Cur) : flatCursor;
  } catch (err) {
    // A throttle outside the list call (refreshing auth, listing scopes —
    // which has no `rateLimited` channel) is still backpressure: the same
    // back-off, not a pass error a person has to read.
    if (err instanceof HttpStatusError && isRateLimitStatus(err.status)) {
      result.rateLimited = true;
      log.info(
        `${adapter.typeId}: throttled outside a list call (HTTP ${err.status}); backing off`,
      );
    } else {
      result.error = err instanceof Error ? err.message : String(err);
      result.errors++;
    }
    result.cursor = scoped ? (envelope as unknown as Cur) : flatCursor;
  } finally {
    await adapter.close().catch(() => {});
  }
  return result;
}

/**
 * The `lastError` text for a pass that completed but did not land every
 * record. Undefined for a clean pass.
 */
export function partialFailureNote(r: BindingSyncResult): string | undefined {
  const abandoned = r.abandoned?.length ?? 0;
  const scopeFailures = r.failedScopes?.length ?? 0;
  const retrying = r.errors - abandoned - scopeFailures;
  const parts: string[] = [];
  for (const f of r.failedScopes ?? []) {
    parts.push(`${f.scope || 'the source'} could not be synced: ${f.message.slice(0, 200)}`);
  }
  if (retrying > 0) {
    parts.push(`${retrying} record(s) could not be synced and will be retried`);
  }
  if (abandoned > 0) {
    parts.push(
      `${abandoned} record(s) failed ${POISON_RECORD_PASSES} passes in a row and were skipped`,
    );
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : undefined;
}

/**
 * Resolve a `ConnectorAdapter` for a binding by driver. `native` dispatches
 * through the `NATIVE_ADAPTERS` registry (`source.adapterId`); the generic
 * drivers land in Phase 4/5.
 */
export async function createConnectorAdapter(
  type: ConnectorTypeManifest,
  binding: ConnectorBindingRef,
  deps: AdapterDeps,
): Promise<ConnectorAdapter<NormalizedRecord | ConnectorRecord, unknown>> {
  switch (type.driver) {
    case 'native': {
      const adapterId = String((type.source as { adapterId?: string }).adapterId ?? '');
      const factory = NATIVE_ADAPTERS.get(adapterId);
      if (!factory) throw new Error(`no native connector adapter registered: '${adapterId}'`);
      return factory(binding, deps);
    }
    case 'mcp':
      return new McpConnectorAdapter(type, binding, deps);
    case 'script':
      return new ScriptConnectorAdapter(type, binding, deps);
    case 'spectral':
      return new SpectralConnectorAdapter(type, binding, deps);
    default:
      throw new Error(`unknown connector driver: ${String(type.driver)}`);
  }
}

export interface ConnectorManagerOptions {
  store: Store;
  secrets: SecretStore;
  catalog: CatalogService;
  contentIndex?: ContentIndex;
  /** For `script`-driver connectors + script-normalize. */
  scriptRunner?: import('../scripts/runner.js').ScriptRunner;
  /** Shared with the action manager so commits can't race syncs. */
  locks?: KeyedLock;
  /**
   * HTTP transport handed to native adapters and the OAuth code exchange.
   * Production leaves it unset; tests inject the provider simulator.
   */
  fetch?: typeof fetch;
  /**
   * Called after a binding is added, edited, paused, or removed — the live
   * host reconciles its running devices against disk.
   */
  onBindingsChanged?: (projectId: string) => void;
  /** Live status of a project's device bindings (cameras), merged into `status()`. */
  liveStatus?: (projectId: string) => LiveBindingStatus[];
}

export interface PatchConnectorInput {
  displayName?: string;
  config?: Record<string, unknown>;
  /** Pause (true) or resume (false). Resuming clears an emergency stop. */
  disabled?: boolean;
}

export interface BindConnectorInput {
  type: string;
  displayName?: string;
  config?: Record<string, unknown>;
  /** Credential blob to store in the SecretStore (JSON string). */
  credential?: string;
  /** Internal stable id used to make OAuth completion retries idempotent. */
  bindingId?: string;
  /** Internal provenance pin used by OAuth completion and migrations. */
  sourceId?: string;
  version?: string;
}

export interface ConnectorStatus {
  configured: boolean;
  bindings: {
    id: string;
    type: string;
    displayName?: string;
    completeness?: string;
    lastSyncedAt?: string;
    lastError?: string;
    disabled?: boolean;
    disabledReason?: 'user' | 'emergency-stop';
    /** `device` for bindings the live host runs (cameras). */
    driver?: string;
    config?: Record<string, unknown>;
    /** Live status of a device binding. */
    live?: LiveBindingStatus;
    /** Rate-limit backoff expiry (ISO); autonomous sync skips until then. */
    backoffUntil?: string;
    /**
     * Present only for an observation corpus — a binding whose data is
     * columnar tables rather than readable records. Its absence is what the
     * UI reads as "this is a document corpus", so it is never an empty array.
     */
    tables?: {
      table: string;
      rows: number;
      partitions: number;
      earliestPartition?: string;
      latestPartition?: string;
      schemaInferred: boolean;
      /** Sealed parts still awaiting the night shift's compaction. */
      pendingParts: number;
      lastCompactionAt?: string;
      retentionDays?: number;
    }[];
  }[];
}

/**
 * Project-level connector lifecycle: bind (store credential + record binding),
 * list/status, sync (resolve adapter → run the engine → persist cursor), and
 * unbind. Mirrors `MailManager` for the generic `project.connectors` path.
 */
interface PendingConnectorOAuth {
  projectId: string;
  type: string;
  sourceId: string;
  version: string;
  config: Record<string, unknown>;
  displayName?: string;
  clientId: string;
  clientSecret?: string;
  endpoints: OAuthEndpoints;
  /** Meta-style post-exchange trade for providers that issue no refresh token. */
  longLivedExchange?: LongLivedExchange;
  /** LinkedIn-style: no refresh token AND no exchange — the access token
   *  itself is simply long-lived, so a missing refresh token is not a
   *  failure. */
  longLived?: boolean;
  redirectUri: string;
  verifier: string;
  createdAt: number;
  completion?: { bindingId: string; credential: string };
}

/** Rate-limit backoff ladder: 1m → 5m → 15m → 30m (jittered). */
const RATE_LIMIT_BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000] as const;

/**
 * Hard-failure ladder: 5m → 15m → 30m → 1h (jittered). A revoked grant or a
 * deleted feed fails identically on every tick, so retrying every 90s only
 * spends requests (and, for X, money) to rewrite the same lastError. A manual
 * sync — what a person clicks after re-linking — ignores it.
 */
const FAILURE_BACKOFF_MS = [300_000, 900_000, 1_800_000, 3_600_000] as const;

export class ConnectorManager {
  private readonly locks: KeyedLock;
  /** In-flight OAuth link sessions keyed by `state` (10-min TTL). */
  private readonly pendingOAuth = new Map<string, PendingConnectorOAuth>();
  /**
   * In-memory rate-limit backoff per binding. Deliberately not persisted:
   * a restart resetting backoff costs at most one extra request, and keeping
   * it here avoids project.json churn on every rate-limit event.
   */
  private readonly backoff = new Map<string, { consecutive: number; nextEligibleAt: number }>();

  constructor(private readonly opts: ConnectorManagerOptions) {
    this.locks = opts.locks ?? new KeyedLock();
  }

  /** When the binding's rate-limit backoff expires (undefined = eligible now). */
  backoffUntil(bindingId: string): number | undefined {
    const entry = this.backoff.get(bindingId);
    return entry && entry.nextEligibleAt > Date.now() ? entry.nextEligibleAt : undefined;
  }

  private noteRateLimit(bindingId: string): void {
    const consecutive = (this.backoff.get(bindingId)?.consecutive ?? 0) + 1;
    const delay = backoffDelayMs(consecutive - 1, RATE_LIMIT_BACKOFF_MS);
    this.backoff.set(bindingId, { consecutive, nextEligibleAt: Date.now() + delay });
    log.info(`rate limited (${bindingId}); backing off ${Math.round(delay / 1000)}s`);
  }

  private noteFailure(bindingId: string): void {
    const consecutive = (this.backoff.get(bindingId)?.consecutive ?? 0) + 1;
    const delay = backoffDelayMs(consecutive - 1, FAILURE_BACKOFF_MS);
    this.backoff.set(bindingId, { consecutive, nextEligibleAt: Date.now() + delay });
    log.info(`sync failed (${bindingId}); next autonomous attempt in ${Math.round(delay / 1000)}s`);
  }

  private withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(projectId, fn);
  }

  private async loadType(
    typeId: string,
    version?: string,
    sourceId?: string,
  ): Promise<{ manifest: ConnectorTypeManifest; sourceId: string }> {
    const detail = await this.opts.catalog.get('connector-type', typeId, sourceId, version);
    if (!detail || detail.manifest.kind !== 'connector-type') {
      throw new Error(`connector type not found: ${typeId}`);
    }
    if (!detail.sourceId) throw new Error(`connector type has no catalog provenance: ${typeId}`);
    return { manifest: detail.manifest, sourceId: detail.sourceId };
  }

  /** Bind a new connector: validate the type + config, store the credential, record it. */
  async bind(project: ProjectDetail, input: BindConnectorInput): Promise<ProjectConnectorBinding> {
    const resolved = await this.loadType(input.type, input.version, input.sourceId);
    const type = resolved.manifest;
    const configErrors = validateConnectorConfig(type.configSchema, input.config ?? {});
    if (configErrors.length) {
      throw new Error(`invalid ${input.type} configuration: ${configErrors.join('; ')}`);
    }
    const id = input.bindingId ?? `${input.type}:${randomUUID().slice(0, 8)}`;
    return this.withLock(project.id, async () => {
      if (input.credential !== undefined) {
        await this.opts.secrets.set(connectorSecretKey(input.type, id), input.credential);
      }
      const current = await this.reread(project);
      const existing = current.connectors ?? [];
      const binding: ProjectConnectorBinding = {
        id,
        type: input.type,
        sourceId: resolved.sourceId,
        version: type.version,
        corpusDir: resolveCorpusDir(existing, input.type, input.displayName),
        config: input.config ?? {},
        driver: type.driver,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      };
      // A `script` connector's fetch script reaches its credential parent-side
      // via `gezel.http.authed` — grant the named credential on the project so
      // the plaintext never enters the sandbox, and pin the manifest's
      // declared destination origins for that credential name (without an
      // entry, the dispatcher's origin allowlist denies every authed fetch).
      let grantPatch: {
        grantedCredentials?: string[];
        credentialAllowedOrigins?: Record<string, string[]>;
      } = {};
      if (type.driver === 'script') {
        const grant = connectorCredentialName(input.type, id);
        const grants = current.grantedCredentials ?? [];
        if (!grants.includes(grant)) grantPatch = { grantedCredentials: [...grants, grant] };
        const origins = resolveDeclaredOrigins(type, binding.config);
        if (origins.length > 0) {
          grantPatch.credentialAllowedOrigins = {
            ...(current.credentialAllowedOrigins ?? {}),
            [grant]: origins,
          };
        }
      }
      await this.opts.store.updateProject(project.id, {
        connectors: [...existing, binding],
        ...grantPatch,
      });
      await this.opts.store.historyManager
        ?.log({
          kind: 'project.connector.bound',
          projectId: project.id,
          summary: `Connector bound: ${input.displayName ?? input.type}`,
        })
        .catch(() => {});
      this.opts.onBindingsChanged?.(project.id);
      return binding;
    });
  }

  /**
   * Rename, reconfigure, pause, or resume a binding. The config is validated
   * against the type's schema like a new binding's. Resuming always clears
   * the pause reason, including an emergency stop's: the person pressing
   * Resume is the consent that stop asked for.
   */
  async patchBinding(
    project: ProjectDetail,
    bindingId: string,
    patch: PatchConnectorInput,
  ): Promise<ProjectConnectorBinding> {
    const before = (await this.reread(project)).connectors?.find((b) => b.id === bindingId);
    if (!before) throw new Error(`no connector binding ${bindingId}`);
    if (patch.config) {
      const resolved = await this.loadType(
        before.type,
        before.version,
        before.sourceId ?? 'bundled',
      );
      const errors = validateConnectorConfig(resolved.manifest.configSchema, patch.config);
      if (errors.length)
        throw new Error(`invalid ${before.type} configuration: ${errors.join('; ')}`);
    }
    const next = await this.withLock(project.id, async () => {
      const current = await this.reread(project);
      const binding = (current.connectors ?? []).find((b) => b.id === bindingId);
      if (!binding) throw new Error(`no connector binding ${bindingId}`);
      const updated: ProjectConnectorBinding = { ...binding };
      if (patch.displayName !== undefined) {
        const name = patch.displayName.trim();
        if (name) updated.displayName = name;
        else delete updated.displayName;
      }
      if (patch.config) updated.config = patch.config;
      if (patch.disabled === true) {
        updated.disabled = true;
        updated.disabledReason = 'user';
      } else if (patch.disabled === false) {
        delete updated.disabled;
        delete updated.disabledReason;
      }
      await this.opts.store.updateProject(project.id, {
        connectors: (current.connectors ?? []).map((b) => (b.id === bindingId ? updated : b)),
      });
      if (patch.disabled !== undefined && patch.disabled !== Boolean(binding.disabled)) {
        await this.opts.store.historyManager
          ?.log({
            kind: patch.disabled ? 'project.connector.paused' : 'project.connector.resumed',
            projectId: project.id,
            summary: `Connector ${patch.disabled ? 'paused' : 'resumed'}: ${binding.displayName ?? binding.type}`,
          })
          .catch(() => {});
      }
      return updated;
    });
    this.opts.onBindingsChanged?.(project.id);
    return next;
  }

  /**
   * The live host's write: a device binding's error line and pause state.
   * `lastError: null` clears it. Never touches config.
   */
  async setDeviceState(
    projectId: string,
    bindingId: string,
    patch: {
      lastError?: string | null;
      disabled?: boolean;
      disabledReason?: 'user' | 'emergency-stop';
    },
  ): Promise<void> {
    await this.withLock(projectId, async () => {
      const project = await this.opts.store.getProject(projectId);
      if (!project?.connectors?.some((b) => b.id === bindingId)) return;
      const connectors = project.connectors.map((b) => {
        if (b.id !== bindingId) return b;
        const next: ProjectConnectorBinding = { ...b };
        if (patch.lastError === null) delete next.lastError;
        else if (patch.lastError !== undefined) next.lastError = patch.lastError;
        if (patch.disabled === true) {
          next.disabled = true;
          next.disabledReason = patch.disabledReason ?? 'user';
        } else if (patch.disabled === false) {
          delete next.disabled;
          delete next.disabledReason;
        }
        return next;
      });
      await this.opts.store.updateProject(projectId, { connectors });
    });
  }

  /**
   * Begin an OAuth link for an OAuth-shaped connector type. The type's
   * `secretShape` supplies the authorize/token endpoints, scopes, and the env
   * vars naming the install's OAuth client. Returns the URL the shell opens +
   * a `state` to round-trip.
   */
  async startOAuth(
    project: ProjectDetail,
    input: {
      type: string;
      redirectUri: string;
      config?: Record<string, unknown>;
      displayName?: string;
      /** Pre-fill the provider's account picker (mail: the address being linked). */
      loginHint?: string;
    },
  ): Promise<{ authUrl: string; state: string }> {
    const resolved = await this.loadType(input.type);
    const type = resolved.manifest;
    // OAuth manifests can choose where authorization codes, client secrets,
    // and refresh tokens are sent. Only the reviewed, bundled catalog is
    // trusted to make that choice; installed/local manifests must use a
    // future explicit-consent flow instead of silently receiving secrets.
    if (resolved.sourceId !== 'bundled') {
      throw new Error(
        `OAuth connector '${input.type}' is from untrusted catalog source '${resolved.sourceId}'`,
      );
    }
    const shape = (type.secretShape ?? {}) as {
      kind?: string;
      authorizeUrl?: string;
      tokenUrl?: string;
      scopes?: string;
      clientIdEnv?: string;
      clientSecretEnv?: string;
      authParams?: Record<string, string>;
      longLivedExchange?: unknown;
      longLived?: unknown;
    };
    if (shape.kind !== 'oauth2' || !shape.authorizeUrl || !shape.tokenUrl) {
      throw new Error(`connector type '${input.type}' is not an OAuth type`);
    }
    // Env vars are the operator/dev override; the Settings-registered
    // bring-your-own app (config.oauthClients + SecretStore secret) is the
    // desktop path, read lazily only on an env miss. The resolved client
    // rides the pending entry, is persisted into the credential blob at
    // completion, and is never re-resolved at refresh time.
    const { clientId, clientSecret } = await resolveOAuthClient({
      ...(shape.clientIdEnv ? { clientIdEnv: shape.clientIdEnv } : {}),
      ...(shape.clientSecretEnv ? { clientSecretEnv: shape.clientSecretEnv } : {}),
      getConfiguredClients: async () => (await this.opts.store.readConfig()).oauthClients,
      getSecret: (key) => this.opts.secrets.get(key),
    });
    const endpoints: OAuthEndpoints = validateOAuthEndpoints({
      authEndpoint: shape.authorizeUrl,
      tokenEndpoint: shape.tokenUrl,
      scopes: (shape.scopes ?? '').split(' ').filter(Boolean),
    });
    // Validated up front so a malformed manifest fails at link start, before
    // the user has consented in the browser.
    const longLivedExchange = parseLongLivedExchange(shape.longLivedExchange);
    const { verifier, challenge } = createPkce();
    const state = randomState();
    this.gcPendingOAuth();
    this.pendingOAuth.set(state, {
      projectId: project.id,
      type: input.type,
      sourceId: resolved.sourceId,
      version: type.version,
      config: input.config ?? {},
      ...(input.displayName ? { displayName: input.displayName } : {}),
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      endpoints,
      ...(longLivedExchange ? { longLivedExchange } : {}),
      ...(shape.longLived === true ? { longLived: true } : {}),
      redirectUri: input.redirectUri,
      verifier,
      createdAt: Date.now(),
    });
    const authUrl = buildAuthorizeUrl({
      endpoints,
      clientId,
      redirectUri: input.redirectUri,
      state,
      challenge,
      ...(shape.authParams ? { extraParams: shape.authParams } : {}),
      ...(input.loginHint ? { loginHint: input.loginHint } : {}),
    });
    return { authUrl, state };
  }

  /** Finish an OAuth link: exchange the code, store the credential, bind. */
  async completeOAuth(
    project: ProjectDetail,
    args: { state: string; code: string },
  ): Promise<ProjectConnectorBinding> {
    this.gcPendingOAuth();
    const pending = this.pendingOAuth.get(args.state);
    if (!pending) throw new Error('oauth state not found or expired; restart the link flow');
    if (pending.projectId !== project.id) {
      throw new Error('oauth state belongs to a different project; restart the link flow');
    }
    if (!pending.completion) {
      const tokens = await exchangeAuthCode({
        endpoints: pending.endpoints,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        code: args.code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
        ...(this.opts.fetch ? { fetchImpl: this.opts.fetch } : {}),
      });
      let credential: string;
      if (pending.longLivedExchange) {
        // Meta issues no refresh token: trade the short-lived token for the
        // ~60-day one and store the refresh URL so the adapter can renew it
        // in place (`ig_refresh_token`) instead of using a refresh token.
        const longLived = await exchangeLongLivedToken({
          exchangeUrl: pending.longLivedExchange.exchangeUrl,
          accessToken: tokens.accessToken,
          ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
          ...(this.opts.fetch ? { fetchImpl: this.opts.fetch } : {}),
        });
        credential = JSON.stringify({
          accessToken: longLived.accessToken,
          expiresAt: longLived.expiresAt,
          refreshMode: 'long-lived-exchange',
          refreshUrl: pending.longLivedExchange.refreshUrl,
        });
      } else if (pending.longLived && !tokens.refreshToken) {
        // LinkedIn-style providers issue refresh tokens only to approved
        // partners; an ordinary app's code exchange yields just a long-lived
        // (~60 day) access token, with no renewal endpoint either. That is
        // not a failure: persist the token with refreshMode 'none' and let
        // the adapter surface an actionable reconnect error once it expires.
        // When such a provider DOES return a refresh token, the standard
        // path below persists it and refresh works as usual.
        credential = JSON.stringify({
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          refreshMode: 'none',
        });
      } else {
        if (!tokens.refreshToken) {
          throw new Error(
            'OAuth succeeded but no refresh token was returned (need offline access).',
          );
        }
        const cred = {
          provider: pending.config.provider,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          clientId: pending.clientId,
          ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
          ...(pending.config.tenant ? { tenant: pending.config.tenant } : {}),
          // The endpoint that issued the grant is the one that can refresh
          // it; adapters prefer it over a type default (Microsoft tenants).
          tokenUrl: pending.endpoints.tokenEndpoint,
        };
        credential = JSON.stringify(cred);
      }
      pending.completion = {
        bindingId: `${pending.type}:${randomUUID().slice(0, 8)}`,
        credential,
      };
    }
    const binding = await this.bind(project, {
      type: pending.type,
      sourceId: pending.sourceId,
      version: pending.version,
      ...(pending.displayName ? { displayName: pending.displayName } : {}),
      config: pending.config,
      credential: pending.completion.credential,
      bindingId: pending.completion.bindingId,
    });
    this.pendingOAuth.delete(args.state);
    return binding;
  }

  private gcPendingOAuth(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.pendingOAuth) {
      if (v.createdAt < cutoff) this.pendingOAuth.delete(k);
    }
  }

  /** Remove a binding + its stored credential (and its origin allowlist entry). */
  async unbind(project: ProjectDetail, bindingId: string): Promise<void> {
    return this.withLock(project.id, async () => {
      const current = await this.reread(project);
      const existing = current.connectors ?? [];
      const binding = existing.find((b) => b.id === bindingId);
      if (binding) {
        await this.opts.secrets
          .delete(connectorSecretKey(binding.type, binding.id))
          .catch(() => {});
      }
      let originsPatch: { credentialAllowedOrigins?: Record<string, string[]> } = {};
      if (binding && current.credentialAllowedOrigins) {
        const credName = connectorCredentialName(binding.type, binding.id);
        if (credName in current.credentialAllowedOrigins) {
          const { [credName]: _removed, ...rest } = current.credentialAllowedOrigins;
          originsPatch = { credentialAllowedOrigins: rest };
        }
      }
      await this.opts.store.updateProject(project.id, {
        connectors: existing.filter((b) => b.id !== bindingId),
        ...originsPatch,
      });
      await this.opts.store.historyManager
        ?.log({
          kind: 'project.connector.unbound',
          projectId: project.id,
          summary: `Connector unbound: ${binding?.displayName ?? bindingId}`,
        })
        .catch(() => {});
      this.opts.onBindingsChanged?.(project.id);
    });
  }

  async status(project: ProjectDetail): Promise<ConnectorStatus> {
    const bindings = project.connectors ?? [];
    const completenessByType = new Map<string, string | undefined>();
    for (const b of bindings) {
      if (completenessByType.has(b.type)) continue;
      const manifest = await this.loadType(b.type, b.version, b.sourceId ?? 'bundled')
        .then((r) => r.manifest)
        .catch(() => null);
      completenessByType.set(b.type, manifest?.completeness);
    }
    // Table stats are read from the corpus on disk rather than recomputed, so
    // this stays a stat() walk even for a binding holding hundreds of
    // millions of rows.
    const storageDir = this.opts.store.projectArtifactsDir(project.id);
    const tablesByBinding = new Map<
      string,
      NonNullable<ConnectorStatus['bindings'][number]['tables']>
    >();
    for (const b of bindings) {
      const corpusDir = corpusDirFor(bindings, b);
      const stats: NonNullable<ConnectorStatus['bindings'][number]['tables']> = [];
      for (const table of await listTables(storageDir, corpusDir).catch(() => [])) {
        const [manifest, state, partitionDirs] = await Promise.all([
          readTableManifest(storageDir, corpusDir, table).catch(() => null),
          readTableState(storageDir, corpusDir, table).catch(() => null),
          listPartitions(storageDir, corpusDir, table).catch(() => []),
        ]);
        let pendingParts = 0;
        for (const partition of partitionDirs) {
          const files = await listPartitionFiles(storageDir, corpusDir, table, partition).catch(
            () => ({ parquet: [], sealed: [], open: [] }),
          );
          pendingParts += files.sealed.length + files.open.length;
        }
        const values = partitionDirs
          .map((d) => partitionValueFromDir(d)?.value)
          .filter((v): v is string => Boolean(v));
        stats.push({
          table,
          rows: state?.totalRows ?? 0,
          partitions: partitionDirs.length,
          ...(values.length > 0
            ? {
                earliestPartition: values[values.length - 1] as string,
                latestPartition: values[0] as string,
              }
            : {}),
          schemaInferred: manifest?.inferred === true,
          pendingParts,
          ...(state?.lastCompactionAt ? { lastCompactionAt: state.lastCompactionAt } : {}),
          ...(manifest?.retention?.rawDays ? { retentionDays: manifest.retention.rawDays } : {}),
        });
      }
      if (stats.length > 0) tablesByBinding.set(b.id, stats);
    }

    const live = new Map((this.opts.liveStatus?.(project.id) ?? []).map((s) => [s.bindingId, s]));
    return {
      configured: bindings.length > 0,
      bindings: bindings.map((b) => {
        const backoffAt = this.backoffUntil(b.id);
        const completeness = completenessByType.get(b.type);
        const tables = tablesByBinding.get(b.id);
        const liveStatus = live.get(b.id);
        return {
          id: b.id,
          type: b.type,
          ...(b.displayName ? { displayName: b.displayName } : {}),
          ...(completeness ? { completeness } : {}),
          ...(b.lastSyncedAt ? { lastSyncedAt: b.lastSyncedAt } : {}),
          ...(b.lastError ? { lastError: b.lastError } : {}),
          ...(b.disabled ? { disabled: b.disabled } : {}),
          ...(b.disabledReason ? { disabledReason: b.disabledReason } : {}),
          // A device binding's settings are what its card edits; synced
          // types keep their config out of the status payload.
          ...(b.driver === 'device' ? { driver: 'device', config: b.config } : {}),
          ...(liveStatus ? { live: liveStatus } : {}),
          ...(backoffAt ? { backoffUntil: new Date(backoffAt).toISOString() } : {}),
          ...(tables ? { tables } : {}),
        };
      }),
    };
  }

  /**
   * Sync one binding (user-initiated, from the loop, or from a task
   * launch). `scopes` narrows the pass to what the caller needs on disk
   * now — a craftbook launching against one pull request should not wait
   * for the whole window to mirror.
   */
  async syncBinding(
    project: ProjectDetail,
    bindingId: string,
    opts?: { scopes?: readonly string[]; backfillLimit?: number },
  ): Promise<BindingSyncResult> {
    return this.withLock(project.id, async () => {
      const current = await this.reread(project);
      const binding = (current.connectors ?? []).find((b) => b.id === bindingId);
      if (!binding) throw new Error(`no connector binding ${bindingId}`);
      if (binding.driver === 'device') {
        throw new Error('This connection watches a device continuously; there is nothing to sync.');
      }
      return this.syncBindingInner(current, binding, opts);
    });
  }

  /** Sync every enabled binding on a project (drives the sync manager). */
  async syncProject(project: ProjectDetail): Promise<BindingSyncResult[]> {
    return this.withLock(project.id, async () => {
      let current = await this.reread(project);
      const results: BindingSyncResult[] = [];
      for (const binding of current.connectors ?? []) {
        if (binding.disabled) continue;
        // Device bindings are kept running by the live host, never synced.
        if (binding.driver === 'device') continue;
        // Rate-limit backoff applies to the autonomous loop; a user-initiated
        // syncBinding deliberately bypasses it.
        if (this.backoffUntil(binding.id)) continue;
        results.push(await this.syncBindingInner(current, binding));
        current = await this.reread(project);
      }
      return results;
    });
  }

  /**
   * Idempotent sync-time heal for the origin allowlist: bindings created
   * before their type declared `allowedOrigins` (or before this write path
   * existed) get the entry on their next sync, with no migration step.
   * Called under the project lock.
   */
  private async ensureDeclaredOrigins(
    project: ProjectDetail,
    binding: ProjectConnectorBinding,
    manifest: ConnectorTypeManifest,
  ): Promise<void> {
    if (manifest.driver !== 'script' || !manifest.allowedOrigins?.length) return;
    const expected = resolveDeclaredOrigins(manifest, binding.config);
    if (expected.length === 0) return;
    const credName = connectorCredentialName(binding.type, binding.id);
    const existing = project.credentialAllowedOrigins?.[credName];
    if (existing && JSON.stringify([...existing].sort()) === JSON.stringify([...expected].sort())) {
      return;
    }
    await this.opts.store
      .updateProject(project.id, {
        credentialAllowedOrigins: {
          ...(project.credentialAllowedOrigins ?? {}),
          [credName]: expected,
        },
      })
      .catch((err) => log.warn(`origin heal failed for ${binding.id}:`, err));
  }

  /** The per-binding sync body — always called under the project lock. */
  private async syncBindingInner(
    project: ProjectDetail,
    binding: ProjectConnectorBinding,
    opts?: { scopes?: readonly string[]; backfillLimit?: number },
  ): Promise<BindingSyncResult> {
    try {
      // Legacy bindings predate provenance pins and could otherwise be
      // shadowed by a newly installed local manifest with the same id. Their
      // historical source was the bundled catalog, so resolve them there.
      const resolved = await this.loadType(
        binding.type,
        binding.version,
        binding.sourceId ?? 'bundled',
      );
      await this.ensureDeclaredOrigins(project, binding, resolved.manifest);
      const adapter = await createConnectorAdapter(resolved.manifest, binding, {
        secrets: this.opts.secrets,
        store: this.opts.store,
        ...(this.opts.scriptRunner ? { scriptRunner: this.opts.scriptRunner } : {}),
        projectId: project.id,
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      });
      const corpusDir = await this.ensureCorpusDir(project, binding);
      const { storageDir, quarantineDir, migrated } = await connectorCorpusStorage(
        this.opts.store,
        project.id,
        corpusDir,
      );
      // Which corpus shape this type writes. Everything about the pass is
      // identical either way — scopes, the per-scope cursor envelope, paging,
      // retry, rate-limit back-off — and only the terminal write differs,
      // which is exactly what `syncWithAdapter`'s injectable writer is for.
      const observation =
        resolved.manifest.normalize.kind === 'observations'
          ? new ObservationWriter({
              storageDir,
              corpusDir,
              ...(resolved.manifest.normalize.tables
                ? {
                    manifests: new Map(resolved.manifest.normalize.tables.map((t) => [t.table, t])),
                  }
                : {}),
            })
          : null;

      const r = await syncWithAdapter<unknown, NormalizedRecord | ConnectorRecord>(adapter, {
        storageDir,
        quarantineDir,
        corpusDir,
        // Prune deletes records the source no longer returns, keyed off the
        // markdown filename grammar. An append-only observation corpus has
        // no such notion, and a manifest that wrongly claims `mirror` must
        // not be able to reach the pruner.
        allowPrune: !observation && resolved.manifest.completeness === 'mirror',
        backfillLimit: Math.max(1, Math.min(opts?.backfillLimit ?? DEFAULT_BACKFILL_LIMIT, 5_000)),
        cursor: binding.cursor,
        ...(opts?.scopes ? { scopes: opts.scopes } : {}),
        ...(observation
          ? {
              write: async (input) => {
                const record = input.record;
                if (!isObservationRecord(record)) {
                  // A type declared as `observations` whose adapter emits
                  // documents is a manifest/adapter mismatch, not a record
                  // to salvage: writing it into the corpus root would leave
                  // markdown the query layer can never see.
                  throw new Error(
                    `connector type '${resolved.manifest.id}' declares the observation shape but its adapter returned a document record`,
                  );
                }
                let rows = 0;
                for (const batch of record.batches) {
                  rows += (await observation.writeBatch(batch)).rows;
                }
                return { status: rows > 0 ? 'written' : 'exists' };
              },
            }
          : {}),
      });

      // Seal open parts before anything reads the corpus. Compaction to
      // Parquet is deliberately NOT done here: it is minutes of CPU on a
      // large pass, the NDJSON is already queryable, and the night shift is
      // where that work belongs.
      let observationSummary: ObservationWriteSummary | null = null;
      if (observation) {
        observationSummary = await observation.finish();
        log.info(
          `${binding.type}: wrote ${observationSummary.rowsWritten} row(s) across ${observationSummary.tables.length} table(s)`,
        );
      }
      if (r.rateLimited) this.noteRateLimit(binding.id);
      else if (r.error) this.noteFailure(binding.id);
      else this.backoff.delete(binding.id);
      const lastSyncedAt = new Date().toISOString();
      if (r.error) {
        await this.persistBinding(project.id, binding.id, {
          cursor: r.cursor,
          lastError: r.error,
        }).catch(() => {});
      } else {
        // A pass that landed most of its records is still a sync, but the
        // failures must not vanish behind "Last synced": record failures hold
        // the scope's cursor, so the person needs to know why it isn't moving.
        const partialNote = partialFailureNote(r);
        await this.persistBinding(project.id, binding.id, {
          cursor: r.cursor,
          lastSyncedAt,
          ...(partialNote ? { lastError: partialNote } : {}),
        });
      }
      await this.writeCorpusMeta(storageDir, corpusDir, binding, resolved.manifest, {
        scopes: r.scopes ?? [],
        ...(r.abandoned?.length ? { abandoned: r.abandoned } : {}),
        ...(r.error ? {} : { lastSyncedAt }),
        ...(observationSummary ? { observations: observationSummary } : {}),
      }).catch(() => {});
      // Corpus records live under artifacts, outside the workspace indexer's
      // walk — the dedicated artifacts index is what makes them searchable.
      // Fire-and-forget; the façade debounces per project.
      if ((r.written + r.pruned > 0 || migrated) && !observation && this.opts.contentIndex) {
        this.opts.contentIndex.refreshArtifacts(project.id).catch(() => {});
      }
      // The content index scans the workspace, not artifacts. A one-time
      // refresh after migration removes the corpus's old workspace rows;
      // ordinary artifact-only syncs do not trigger a needless code re-index.
      if (migrated && this.opts.contentIndex) {
        await this.opts.contentIndex.refresh(project.id).catch(() => {});
      }
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`connector sync failed (${binding.id}): ${message}`);
      this.noteFailure(binding.id);
      await this.persistBinding(project.id, binding.id, {
        cursor: binding.cursor,
        lastError: message,
      }).catch(() => {});
      return {
        written: 0,
        quarantined: 0,
        skipped: 0,
        pruned: 0,
        errors: 1,
        cursor: binding.cursor,
        error: message,
      };
    }
  }

  /**
   * The binding's persisted corpus root, lazily resolved + persisted for
   * bindings created before `corpusDir` existed.
   */
  private async ensureCorpusDir(
    project: ProjectDetail,
    binding: ProjectConnectorBinding,
  ): Promise<string> {
    if (binding.corpusDir) return binding.corpusDir;
    const corpusDir = corpusDirFor(project.connectors ?? [], binding);
    binding.corpusDir = corpusDir;
    await this.persistBinding(project.id, binding.id, { corpusDir }).catch(() => {});
    return corpusDir;
  }

  /** `_meta.json` at the corpus root — what this directory is, for humans + gezels. */
  private async writeCorpusMeta(
    storageDir: string,
    corpusDir: string,
    binding: ProjectConnectorBinding,
    manifest: ConnectorTypeManifest,
    pass: {
      scopes: string[];
      lastSyncedAt?: string;
      observations?: ObservationWriteSummary;
      abandoned?: { scope: string; id: string }[];
    },
  ): Promise<void> {
    const abs = await resolveInside(storageDir, `${corpusDir}/_meta.json`);
    await mkdir(dirname(abs), { recursive: true });
    // Records given up on accumulate across passes: a gezel reading the corpus
    // should know the mirror has a known hole, not just that last pass had one.
    let skippedRecords: { scope: string; id: string }[] = [];
    try {
      const prior = JSON.parse(await readFile(abs, 'utf8')) as { skippedRecords?: unknown };
      if (Array.isArray(prior.skippedRecords)) {
        skippedRecords = prior.skippedRecords.filter(
          (e): e is { scope: string; id: string } =>
            !!e &&
            typeof (e as { scope?: unknown }).scope === 'string' &&
            typeof (e as { id?: unknown }).id === 'string',
        );
      }
    } catch {
      /* first pass, or unreadable: start fresh */
    }
    for (const entry of pass.abandoned ?? []) {
      if (!skippedRecords.some((e) => e.scope === entry.scope && e.id === entry.id)) {
        skippedRecords.push(entry);
      }
    }
    skippedRecords = skippedRecords.slice(-200);
    const meta = {
      binding: binding.id,
      type: binding.type,
      version: binding.version ?? manifest.version,
      ...(binding.displayName ? { displayName: binding.displayName } : {}),
      // `_meta.json` answers "what is this directory?" for anyone already
      // reading the files. For an observation corpus the honest answer is
      // "not files you should read" — the data is columnar and belongs to the
      // query tools — so say the shape plainly and name the tables.
      shape: pass.observations ? ('observations' as const) : ('documents' as const),
      scopes: pass.scopes,
      completeness: manifest.completeness ?? 'mirror',
      ...(pass.observations
        ? {
            tables: pass.observations.tables.map((t) => ({
              table: t.table,
              partitions: t.partitions,
              schemaInferred: t.manifestInferred,
            })),
            rowsLastPass: pass.observations.rowsWritten,
          }
        : {}),
      ...(skippedRecords.length > 0 ? { skippedRecords } : {}),
      ...(pass.lastSyncedAt ? { lastSyncedAt: pass.lastSyncedAt } : {}),
    };
    await writeFileAtomic(abs, `${JSON.stringify(meta, null, 2)}\n`);
  }

  private async persistBinding(
    projectId: string,
    bindingId: string,
    patch: { cursor?: unknown; lastSyncedAt?: string; lastError?: string; corpusDir?: string },
  ): Promise<void> {
    const project = await this.opts.store.getProject(projectId);
    if (!project?.connectors) return;
    const connectors = project.connectors.map((b) =>
      b.id === bindingId
        ? {
            ...b,
            ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
            ...(patch.corpusDir ? { corpusDir: patch.corpusDir } : {}),
            ...(patch.lastSyncedAt
              ? { lastSyncedAt: patch.lastSyncedAt, lastError: undefined }
              : {}),
            ...(patch.lastError ? { lastError: patch.lastError } : {}),
          }
        : b,
    );
    await this.opts.store.updateProject(projectId, { connectors });
  }

  private async reread(project: ProjectDetail): Promise<ProjectDetail> {
    return (await this.opts.store.getProject(project.id)) ?? project;
  }
}
