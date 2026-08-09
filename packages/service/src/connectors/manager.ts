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
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ConnectorTypeManifest,
  ProjectConnectorBinding,
  ProjectDetail,
} from '@bendyline/gezel';
import { backoffDelayMs, createLogger, retryTransient } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { SecretStore } from '../secrets/types.js';
import { validateConnectorConfig } from './config-validate.js';
import { McpConnectorAdapter } from './drivers/mcp.js';
import { ScriptConnectorAdapter } from './drivers/script.js';
import { SpectralConnectorAdapter } from './drivers/spectral.js';
import { ProjectLocks } from './lock.js';
import {
  type OAuthEndpoints,
  buildAuthorizeUrl,
  createPkce,
  exchangeAuthCode,
  randomState,
  resolveOAuthClientFromEnv,
  validateOAuthEndpoints,
} from './oauth.js';
import { NATIVE_ADAPTERS, connectorCredentialName, connectorSecretKey } from './registry.js';
import type {
  AdapterDeps,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedRecord,
} from './types.js';
import {
  type PruneInput,
  type PruneResult,
  type WriteRecordResult,
  writeRecord as defaultWriteRecord,
  pruneRecords,
  sha8,
  slug,
} from './writer.js';

const log = createLogger('connectors');

const DEFAULT_BACKFILL_LIMIT = 500;

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

export interface SyncBindingOptions<Cur = unknown> {
  workspaceDir: string;
  /** Top dir under the workspace where this connector's corpus lands. */
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
  /** Newest-N cap per scope on each round. */
  backfillLimit: number;
  /** Starting cursor (opaque, adapter-shaped). */
  cursor: Cur | undefined;
  /** Injectable writer — defaults to the real `writeRecord` (tests pass a fake). */
  write?: (input: {
    workspaceDir: string;
    corpusDir: string;
    record: NormalizedRecord;
  }) => Promise<WriteRecordResult>;
  /** Injectable pruner — defaults to the real `pruneRecords`. */
  prune?: (input: PruneInput) => Promise<PruneResult>;
}

export interface BindingSyncResult<Cur = unknown> {
  written: number;
  quarantined: number;
  skipped: number;
  /** Records the source no longer returns, removed by a mirror prune. */
  pruned: number;
  errors: number;
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
    return { v: 2, scopes: { ...(raw as ScopedCursor).scopes } };
  }
  return { v: 2, scopes: {} };
}

/** Max same-scope continuation rounds per pass when an adapter pages via `partial`. */
const MAX_PARTIAL_ROUNDS = 4;

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
export async function syncWithAdapter<Cur = unknown>(
  adapter: ConnectorAdapter<NormalizedRecord, Cur>,
  opts: SyncBindingOptions<Cur>,
): Promise<BindingSyncResult<Cur>> {
  const write = opts.write ?? defaultWriteRecord;
  const prune = opts.prune ?? pruneRecords;
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
    const scopes = await adapter.listScopes();
    result.scopes = scopes;
    outer: for (const scope of scopes) {
      const scopeCorpusDir =
        (opts.scopeAsDir ?? true) && scope !== ''
          ? `${opts.corpusDir}/${slug(scope)}`
          : opts.corpusDir;
      for (let round = 0; round < MAX_PARTIAL_ROUNDS; round++) {
        const before = scoped ? (envelope!.scopes[scope] as Cur | undefined) : flatCursor;
        const changes = await adapter.listChangesSince(scope, before, {
          limit: opts.backfillLimit,
        });
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
        const seenHashes = new Set<string>();
        for (const ref of take) {
          try {
            // Transient faults (5xx/408/429, socket drops) get three attempts
            // with jittered backoff; real errors rethrow immediately.
            const record = await retryTransient(() => adapter.fetchRecord(scope, ref), {
              attempts: 3,
              label: `${adapter.typeId} record ${ref.id}`,
            });
            seenHashes.add(sha8(record.recordId));
            const w = await write({
              workspaceDir: opts.workspaceDir,
              corpusDir: scopeCorpusDir,
              record,
            });
            if (w.status === 'written' || w.status === 'refreshed') result.written++;
            else if (w.status === 'quarantined') result.quarantined++;
            else result.skipped++;
          } catch (err) {
            scopeErrors++;
            result.errors++;
            log.warn(`fetch/write failed (${adapter.typeId} ${scope} id ${ref.id}): ${err}`);
          }
        }
        // Advance only on a clean batch; otherwise keep the prior cursor so
        // the batch retries next pass.
        if (scopeErrors === 0) {
          if (scoped) envelope!.scopes[scope] = changes.cursor;
          else flatCursor = changes.cursor;
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
            workspaceDir: opts.workspaceDir,
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
    result.cursor = scoped ? (envelope as unknown as Cur) : flatCursor;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.errors++;
    result.cursor = scoped ? (envelope as unknown as Cur) : flatCursor;
  } finally {
    await adapter.close().catch(() => {});
  }
  return result;
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
): Promise<ConnectorAdapter> {
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
  locks?: ProjectLocks;
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
    /** Rate-limit backoff expiry (ISO); autonomous sync skips until then. */
    backoffUntil?: string;
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
  redirectUri: string;
  verifier: string;
  createdAt: number;
  completion?: { bindingId: string; credential: string };
}

/** Rate-limit backoff ladder: 1m → 5m → 15m → 30m (jittered). */
const RATE_LIMIT_BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000] as const;

export class ConnectorManager {
  private readonly locks: ProjectLocks;
  /** In-flight OAuth link sessions keyed by `state` (10-min TTL). */
  private readonly pendingOAuth = new Map<string, PendingConnectorOAuth>();
  /**
   * In-memory rate-limit backoff per binding. Deliberately not persisted:
   * a restart resetting backoff costs at most one extra request, and keeping
   * it here avoids project.json churn on every rate-limit event.
   */
  private readonly backoff = new Map<string, { consecutive: number; nextEligibleAt: number }>();

  constructor(private readonly opts: ConnectorManagerOptions) {
    this.locks = opts.locks ?? new ProjectLocks();
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
        ...(input.displayName ? { displayName: input.displayName } : {}),
      };
      // A `script` connector's fetch script reaches its credential parent-side
      // via `gezel.http.authed` — grant the named credential on the project so
      // the plaintext never enters the sandbox.
      let grantPatch: { grantedCredentials?: string[] } = {};
      if (type.driver === 'script') {
        const grant = connectorCredentialName(input.type, id);
        const grants = current.grantedCredentials ?? [];
        if (!grants.includes(grant)) grantPatch = { grantedCredentials: [...grants, grant] };
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
      return binding;
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
    };
    if (shape.kind !== 'oauth2' || !shape.authorizeUrl || !shape.tokenUrl) {
      throw new Error(`connector type '${input.type}' is not an OAuth type`);
    }
    const { clientId, clientSecret } = resolveOAuthClientFromEnv(
      shape.clientIdEnv ?? '',
      shape.clientSecretEnv,
    );
    const endpoints: OAuthEndpoints = validateOAuthEndpoints({
      authEndpoint: shape.authorizeUrl,
      tokenEndpoint: shape.tokenUrl,
      scopes: (shape.scopes ?? '').split(' ').filter(Boolean),
    });
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
      });
      if (!tokens.refreshToken) {
        throw new Error('OAuth succeeded but no refresh token was returned (need offline access).');
      }
      const cred = {
        provider: pending.config.provider,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId: pending.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        ...(pending.config.tenant ? { tenant: pending.config.tenant } : {}),
      };
      pending.completion = {
        bindingId: `${pending.type}:${randomUUID().slice(0, 8)}`,
        credential: JSON.stringify(cred),
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

  /** Remove a binding + its stored credential. */
  async unbind(project: ProjectDetail, bindingId: string): Promise<void> {
    return this.withLock(project.id, async () => {
      const existing = (await this.reread(project)).connectors ?? [];
      const binding = existing.find((b) => b.id === bindingId);
      if (binding) {
        await this.opts.secrets
          .delete(connectorSecretKey(binding.type, binding.id))
          .catch(() => {});
      }
      await this.opts.store.updateProject(project.id, {
        connectors: existing.filter((b) => b.id !== bindingId),
      });
      await this.opts.store.historyManager
        ?.log({
          kind: 'project.connector.unbound',
          projectId: project.id,
          summary: `Connector unbound: ${binding?.displayName ?? bindingId}`,
        })
        .catch(() => {});
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
    return {
      configured: bindings.length > 0,
      bindings: bindings.map((b) => {
        const backoffAt = this.backoffUntil(b.id);
        const completeness = completenessByType.get(b.type);
        return {
          id: b.id,
          type: b.type,
          ...(b.displayName ? { displayName: b.displayName } : {}),
          ...(completeness ? { completeness } : {}),
          ...(b.lastSyncedAt ? { lastSyncedAt: b.lastSyncedAt } : {}),
          ...(b.lastError ? { lastError: b.lastError } : {}),
          ...(b.disabled ? { disabled: b.disabled } : {}),
          ...(backoffAt ? { backoffUntil: new Date(backoffAt).toISOString() } : {}),
        };
      }),
    };
  }

  /** Sync one binding (user-initiated or from the loop). */
  async syncBinding(project: ProjectDetail, bindingId: string): Promise<BindingSyncResult> {
    return this.withLock(project.id, async () => {
      const current = await this.reread(project);
      const binding = (current.connectors ?? []).find((b) => b.id === bindingId);
      if (!binding) throw new Error(`no connector binding ${bindingId}`);
      const r = await this.syncBindingInner(current, binding);
      if (this.opts.contentIndex && r.written + r.quarantined > 0) {
        await this.opts.contentIndex.refresh(project.id).catch(() => {});
      }
      return r;
    });
  }

  /** Sync every enabled binding on a project (drives the sync manager). */
  async syncProject(project: ProjectDetail): Promise<BindingSyncResult[]> {
    return this.withLock(project.id, async () => {
      let current = await this.reread(project);
      const results: BindingSyncResult[] = [];
      for (const binding of current.connectors ?? []) {
        if (binding.disabled) continue;
        // Rate-limit backoff applies to the autonomous loop; a user-initiated
        // syncBinding deliberately bypasses it.
        if (this.backoffUntil(binding.id)) continue;
        results.push(await this.syncBindingInner(current, binding));
        current = await this.reread(project);
      }
      if (this.opts.contentIndex && results.some((r) => r.written + r.quarantined > 0)) {
        await this.opts.contentIndex.refresh(project.id).catch(() => {});
      }
      return results;
    });
  }

  /** The per-binding sync body — always called under the project lock. */
  private async syncBindingInner(
    project: ProjectDetail,
    binding: ProjectConnectorBinding,
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
      const adapter = await createConnectorAdapter(resolved.manifest, binding, {
        secrets: this.opts.secrets,
        store: this.opts.store,
        ...(this.opts.scriptRunner ? { scriptRunner: this.opts.scriptRunner } : {}),
        projectId: project.id,
      });
      const workspaceDir = await this.opts.store.projectWorkspaceDir(project.id);
      const corpusDir = await this.ensureCorpusDir(project, binding);
      const r = await syncWithAdapter(adapter, {
        workspaceDir,
        corpusDir,
        allowPrune: resolved.manifest.completeness === 'mirror',
        backfillLimit: DEFAULT_BACKFILL_LIMIT,
        cursor: binding.cursor,
      });
      if (r.rateLimited) this.noteRateLimit(binding.id);
      else if (!r.error) this.backoff.delete(binding.id);
      const lastSyncedAt = new Date().toISOString();
      if (r.error) {
        await this.persistBinding(project.id, binding.id, {
          cursor: r.cursor,
          lastError: r.error,
        }).catch(() => {});
      } else {
        await this.persistBinding(project.id, binding.id, {
          cursor: r.cursor,
          lastSyncedAt,
        });
      }
      await this.writeCorpusMeta(workspaceDir, corpusDir, binding, resolved.manifest, {
        scopes: r.scopes ?? [],
        ...(r.error ? {} : { lastSyncedAt }),
      }).catch(() => {});
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`connector sync failed (${binding.id}): ${message}`);
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
    workspaceDir: string,
    corpusDir: string,
    binding: ProjectConnectorBinding,
    manifest: ConnectorTypeManifest,
    pass: { scopes: string[]; lastSyncedAt?: string },
  ): Promise<void> {
    const abs = await resolveInside(workspaceDir, `${corpusDir}/_meta.json`);
    await mkdir(dirname(abs), { recursive: true });
    const meta = {
      binding: binding.id,
      type: binding.type,
      version: binding.version ?? manifest.version,
      ...(binding.displayName ? { displayName: binding.displayName } : {}),
      scopes: pass.scopes,
      completeness: manifest.completeness ?? 'mirror',
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
