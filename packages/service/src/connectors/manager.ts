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
import type {
  ConnectorTypeManifest,
  ProjectConnectorBinding,
  ProjectDetail,
} from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { SecretStore } from '../secrets/types.js';
import { McpConnectorAdapter } from './drivers/mcp.js';
import { ScriptConnectorAdapter } from './drivers/script.js';
import { SpectralConnectorAdapter } from './drivers/spectral.js';
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
import { type WriteRecordResult, writeRecord as defaultWriteRecord, slug } from './writer.js';

const log = createLogger('connectors');

const DEFAULT_BACKFILL_LIMIT = 500;

export interface SyncBindingOptions<Cur = unknown> {
  workspaceDir: string;
  /** Top dir under the workspace where this connector's corpus lands. */
  corpusDir: string;
  /** Newest-N cap per scope on each pass. */
  backfillLimit: number;
  /** Starting cursor (opaque, adapter-shaped). */
  cursor: Cur | undefined;
  /** Injectable writer — defaults to the real `writeRecord` (tests pass a fake). */
  write?: (input: {
    workspaceDir: string;
    corpusDir: string;
    record: NormalizedRecord;
  }) => Promise<WriteRecordResult>;
}

export interface BindingSyncResult<Cur = unknown> {
  written: number;
  quarantined: number;
  skipped: number;
  errors: number;
  /** Advanced cursor to persist. */
  cursor: Cur | undefined;
  /** Hard failure (auth / list) message, when the whole pass aborted. */
  error?: string;
}

/**
 * Run one sync pass for a single binding through its adapter. Always calls
 * `adapter.close()`. Never throws — hard failures land in `result.error` with
 * the cursor left unadvanced.
 */
export async function syncWithAdapter<Cur = unknown>(
  adapter: ConnectorAdapter<NormalizedRecord, Cur>,
  opts: SyncBindingOptions<Cur>,
): Promise<BindingSyncResult<Cur>> {
  const write = opts.write ?? defaultWriteRecord;
  const result: BindingSyncResult<Cur> = {
    written: 0,
    quarantined: 0,
    skipped: 0,
    errors: 0,
    cursor: opts.cursor,
  };
  let cursor: Cur | undefined = opts.cursor;

  try {
    await adapter.ensureAuth();
    for (const scope of await adapter.listScopes()) {
      const scopeCursorBefore = cursor;
      const changes = await adapter.listChangesSince(scope, scopeCursorBefore);
      // Newest-first, bounded by the backfill cap; older overflow is skipped
      // (already below the advanced cursor). Sources with no ordinalKey keep
      // the adapter's own order.
      const ordered = [...changes.records].sort(
        (a, b) => (b.ordinalKey ?? 0) - (a.ordinalKey ?? 0),
      );
      const take = ordered.slice(0, opts.backfillLimit);
      result.skipped += ordered.length - take.length;
      let scopeErrors = 0;
      for (const ref of take) {
        try {
          const record = await adapter.fetchRecord(scope, ref);
          const w = await write({
            workspaceDir: opts.workspaceDir,
            corpusDir: opts.corpusDir,
            record,
          });
          if (w.status === 'written') result.written++;
          else if (w.status === 'quarantined') result.quarantined++;
          else result.skipped++;
        } catch (err) {
          scopeErrors++;
          result.errors++;
          log.warn(`fetch/write failed (${adapter.typeId} ${scope} id ${ref.id}): ${err}`);
        }
      }
      // Advance only on a clean batch; otherwise keep the prior cursor to retry.
      cursor = scopeErrors === 0 ? changes.cursor : scopeCursorBefore;
    }
    result.cursor = cursor;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.errors++;
    result.cursor = cursor;
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

export class ConnectorManager {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** In-flight OAuth link sessions keyed by `state` (10-min TTL). */
  private readonly pendingOAuth = new Map<string, PendingConnectorOAuth>();

  constructor(private readonly opts: ConnectorManagerOptions) {}

  private withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
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

  /** Bind a new connector: validate the type, store the credential, record it. */
  async bind(project: ProjectDetail, input: BindConnectorInput): Promise<ProjectConnectorBinding> {
    const resolved = await this.loadType(input.type, input.version, input.sourceId);
    const type = resolved.manifest;
    const id = input.bindingId ?? `${input.type}:${randomUUID().slice(0, 8)}`;
    return this.withLock(project.id, async () => {
      if (input.credential !== undefined) {
        await this.opts.secrets.set(connectorSecretKey(input.type, id), input.credential);
      }
      const binding: ProjectConnectorBinding = {
        id,
        type: input.type,
        sourceId: resolved.sourceId,
        version: type.version,
        config: input.config ?? {},
        ...(input.displayName ? { displayName: input.displayName } : {}),
      };
      const current = await this.reread(project);
      const existing = current.connectors ?? [];
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
    return {
      configured: bindings.length > 0,
      bindings: bindings.map((b) => ({
        id: b.id,
        type: b.type,
        ...(b.displayName ? { displayName: b.displayName } : {}),
        ...(b.lastSyncedAt ? { lastSyncedAt: b.lastSyncedAt } : {}),
        ...(b.lastError ? { lastError: b.lastError } : {}),
        ...(b.disabled ? { disabled: b.disabled } : {}),
      })),
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
      const r = await syncWithAdapter(adapter, {
        workspaceDir,
        corpusDir: `connectors/${slug(binding.id)}`,
        backfillLimit: DEFAULT_BACKFILL_LIMIT,
        cursor: binding.cursor,
      });
      if (r.error) {
        await this.persistBinding(project.id, binding.id, {
          cursor: r.cursor,
          lastError: r.error,
        }).catch(() => {});
      } else {
        await this.persistBinding(project.id, binding.id, {
          cursor: r.cursor,
          lastSyncedAt: new Date().toISOString(),
        });
      }
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
        errors: 1,
        cursor: binding.cursor,
        error: message,
      };
    }
  }

  private async persistBinding(
    projectId: string,
    bindingId: string,
    patch: { cursor?: unknown; lastSyncedAt?: string; lastError?: string },
  ): Promise<void> {
    const project = await this.opts.store.getProject(projectId);
    if (!project?.connectors) return;
    const connectors = project.connectors.map((b) =>
      b.id === bindingId
        ? {
            ...b,
            ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
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
