/**
 * KnowledgeManager — the daemon-side owner of installed `.gezk` catalogs:
 * registry + mount lifecycle (verify-before-mount → quarantine-with-reason),
 * background install jobs (a client disconnect never abandons a download),
 * the gilde join (what is available, what has a newer version), browse APIs
 * for the routes, and the SearchService knowledge arm. Every SQLite touch
 * goes through the KnowledgeCatalogHost (worker thread in production); this
 * class never opens a catalog database itself.
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GezelConfig,
  IncompleteKnowledgeDownload,
  KnowledgeActiveInstall,
  KnowledgeAvailableCatalog,
  KnowledgeCatalogItemManifest,
  KnowledgeCatalogRef,
  KnowledgeCatalogStatus,
  KnowledgeEmbeddingProfile,
  KnowledgeHistoryKind,
  KnowledgeInstallEvent,
  KnowledgeInstallJob,
  KnowledgeInstallRequest,
  KnowledgeInstallSourceKind,
  KnowledgeSemanticSearchMode,
  KnowledgeUpdateCandidate,
  ProjectKnowledgeCatalogs,
  TrustedKnowledgeCoordinate,
  UnifiedSearchResult,
} from '@bendyline/gezel';
import {
  KnowledgeMachineInventorySchema,
  createLogger,
  formatKnowledgeUri,
  resolveSecurityPolicy,
  sameVectorSpace,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { compareCatalogVersions, knowledgeEmbeddingProfile } from '@bendyline/gezel-knowledge';
import {
  knowledgeCatalogVersionDir,
  knowledgeCatalogsDir,
  knowledgeDownloadsDir,
} from '@bendyline/gezel/paths';
import type { HistoryManager } from '../history/manager.js';
import {
  sharedKnowledgeRoot,
  sharedKnowledgeVersionDir,
} from '../machine-engine/knowledge-assets.js';
import { embedKnowledgeQuery, sharesDaemonEmbedder } from '../memory/embeddings.js';
import { ChatModelInstallRegistry } from '../models/install-registry.js';
import { ftsRankRelevance, scoreResult } from '../search/search-service.js';
import type {
  GlobalSearchHit,
  GlobalSearchResponse,
  KnowledgeCatalogHost,
} from './catalog-host.js';
import { resolveKnowledgeCatalogSource } from './catalog-source.js';
import {
  KNOWLEDGE_DOWNLOAD_KEY_PATTERN,
  type KnowledgeExpectedIdentity,
  type KnowledgeInstallSource,
  installKnowledgeCatalog,
  knowledgeDownloadKey,
  pruneOtherKnowledgeCatalogVersions,
} from './install.js';
import { KnowledgeRegistry, type KnowledgeRegistryEntry } from './registry.js';
import type { SharedEnsureResult, SharedKnowledgeInstaller } from './shared-install.js';

type GlobalSearchDocumentHit = GlobalSearchResponse['documents'][number];

export type { KnowledgeCatalogStatus, KnowledgeInstallJob, KnowledgeSemanticSearchMode };

const log = createLogger('knowledge');

/** Explicit-search shard budget (S) across every active catalog (§3.4). */
const ROUTE_BUDGET_EXPLICIT = 6;
const FINAL_K = 24;
/** Finished jobs stay pollable for a minute: the CLI and older cards poll `/jobs/:id`. */
const JOB_TTL_MS = 60_000;
const AUTO_UPDATE_STARTUP_DELAY_MS = 10 * 60_000;
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * A catalog's semantic mode. `shared` reuses the daemon's own query vectors,
 * `profile` loads the registered profile's pinned model on demand, and a
 * profile that matches neither — including a registered id whose pinned
 * files or precision differ — is searched by keyword only rather than with
 * vectors from another space.
 */
function semanticSearchModeFor(profile: KnowledgeEmbeddingProfile): KnowledgeSemanticSearchMode {
  if (sharesDaemonEmbedder(profile)) return 'shared';
  const registered = knowledgeEmbeddingProfile(profile.id);
  if (registered && sameVectorSpace(registered, profile)) return 'profile';
  return 'keyword-only';
}

/** Provisional cosine → calibrated relevance (tuned by Phase-4 evals). */
function cosineRelevance(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine - 0.3) / 0.5));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type KnowledgeInstallRequestSource = KnowledgeInstallRequest['source'];

interface MountedInfo {
  ref: KnowledgeCatalogRef;
  key: string;
  rootDir: string;
  name: string;
  description?: string;
  language: string;
  license: string;
  documents: number;
  chunks: number;
  sizeBytes: number;
  vectorCompatible: boolean;
  semanticSearch: KnowledgeSemanticSearchMode;
  embedding: KnowledgeEmbeddingProfile;
  /** topic id → display name, from the shipped TOC. */
  topicNames: Map<string, string>;
  sourceUrlByDoc: Map<string, string>;
}

interface InstallStart {
  request: KnowledgeInstallRequestSource;
}

interface InstallPlan {
  source: KnowledgeInstallSource;
  origin: KnowledgeInstallSourceKind;
  archiveBytes?: number;
  expectedIdentity?: KnowledgeExpectedIdentity;
  /** Set for catalog installs: what the machine broker may be asked to share. */
  coordinate?: TrustedKnowledgeCoordinate;
  /** `auto` tries the machine-shared store first; `user` keeps the bytes private. */
  placement: 'auto' | 'user';
}

type DoneEvent = Extract<KnowledgeInstallEvent, { type: 'done' }>;

export interface KnowledgeManagerOptions {
  home: string;
  host: KnowledgeCatalogHost;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The gilde loader: `knowledge-catalog` entries are the download source and the update oracle. */
  catalog?: CatalogService;
  history?: HistoryManager;
  /** The security policy (app network) and the auto-update default. */
  readConfig?: () => Promise<GezelConfig | null>;
  /** The machine broker's shared store, when a machine engine is adopted. */
  sharedInstaller?: SharedKnowledgeInstaller;
  /** Project policy lookup (Store.getProject wrapper); null = no policy. */
  projectPolicy?: (projectId: string) => Promise<ProjectKnowledgeCatalogs | null>;
  /** Test seam: embed a query in a catalog profile's space (default: the embed worker). */
  embedQueryForProfile?: (text: string, profile: KnowledgeEmbeddingProfile) => Promise<number[]>;
}

export class KnowledgeManager {
  readonly registry: KnowledgeRegistry;
  private readonly mountedByKey = new Map<string, MountedInfo>();
  private readonly installs: ChatModelInstallRegistry<KnowledgeInstallEvent, InstallStart>;
  /** What each running job was asked to install, for the active-install listing. */
  private readonly jobRequests = new Map<string, KnowledgeInstallRequestSource>();
  /** Download temp keys of running jobs, so the incomplete listing skips live transfers. */
  private readonly jobDownloadKeys = new Map<string, string>();
  private readonly autoUpdateTimers: NodeJS.Timeout[] = [];
  private jobCounter = 0;

  constructor(private readonly opts: KnowledgeManagerOptions) {
    this.registry = new KnowledgeRegistry(opts.home);
    this.installs = new ChatModelInstallRegistry<KnowledgeInstallEvent, InstallStart>({
      engine: 'knowledge',
      run: (jobId, start) => this.runInstall(jobId, start.request),
      finishedTtlMs: JOB_TTL_MS,
    });
  }

  get host(): KnowledgeCatalogHost {
    return this.opts.host;
  }

  /** The job registry, for the SSE subscriber shared with the model install routes. */
  get installRegistry(): ChatModelInstallRegistry<KnowledgeInstallEvent, InstallStart> {
    return this.installs;
  }

  private keyFor(ref: { publisherId: string; catalogId: string }): string {
    return `${ref.publisherId}/${ref.catalogId}`;
  }

  private dirFor(ref: KnowledgeCatalogRef): string {
    if (ref.storageScope === 'machine-shared') {
      const root = sharedKnowledgeRoot(this.opts.env);
      if (!root) {
        throw new Error(
          'catalog is stored in the machine-shared asset store, which is not configured on this device',
        );
      }
      // Mounted read-only from the shared store; verify-before-mount runs
      // the same per-file hash reconciliation as the private tier.
      return sharedKnowledgeVersionDir(root, {
        publisherId: ref.publisherId,
        catalogId: ref.catalogId,
        version: ref.version,
        expectedDigest: ref.contentDigest,
      });
    }
    return knowledgeCatalogVersionDir(
      this.opts.home,
      ref.publisherId,
      ref.catalogId,
      ref.version,
      ref.contentDigest,
    );
  }

  /** Mount every enabled registry entry. Failures quarantine, never throw. */
  async start(): Promise<void> {
    for (const entry of this.registry.read().catalogs) {
      if (!entry.enabled) continue;
      await this.mountEntry(entry).catch((err) => {
        const reason = errorMessage(err);
        log.warn(`catalog ${entry.ref.catalogId} failed to mount: ${reason}`);
        this.registry.quarantine(entry.ref.publisherId, entry.ref.catalogId, reason);
      });
    }
  }

  private async mountEntry(entry: KnowledgeRegistryEntry): Promise<void> {
    const ref = entry.ref;
    const key = this.keyFor(ref);
    if (this.mountedByKey.has(key)) return;
    const rootDir = this.dirFor(ref);

    // Full verify before mount, including SQLite quick_check, vector-table
    // alignment, self-KNN, and publisher smoke queries. This runs in the
    // dedicated knowledge worker in production.
    const report = await this.opts.host.validate(rootDir, true);
    if (!report.ok || !report.manifest) {
      const failed = report.checks.filter((c) => !c.ok);
      throw new Error(
        failed.length > 0
          ? `verification failed: ${failed[0]?.name}${failed[0]?.detail ? ` (${failed[0]?.detail})` : ''}`
          : 'verification failed',
      );
    }
    const manifest = report.manifest;
    if (manifest.id !== ref.catalogId || manifest.version !== ref.version) {
      throw new Error(
        `on-disk catalog is ${manifest.id}@${manifest.version}, registry expects ${ref.catalogId}@${ref.version}`,
      );
    }

    await this.opts.host.mount({ key, rootDir, catalogId: ref.catalogId, version: ref.version });
    const topics = await this.opts.host.topics(key);

    // Queries must be embedded in the catalog's own space. A profile the
    // daemon's model already implements shares its vectors; a registered
    // profile gets its own model loaded on demand; anything else is keyword-only.
    const semanticSearch = semanticSearchModeFor(manifest.embedding);
    const vectorCompatible = semanticSearch !== 'keyword-only';

    this.mountedByKey.set(key, {
      ref,
      key,
      rootDir,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      language: manifest.language,
      license: manifest.license.name,
      documents: manifest.counts.documents,
      chunks: manifest.counts.chunks,
      sizeBytes: manifest.files.reduce((sum, f) => sum + f.sizeBytes, 0),
      vectorCompatible,
      semanticSearch,
      embedding: manifest.embedding,
      topicNames: new Map(topics.map((t) => [t.id, t.name])),
      sourceUrlByDoc: new Map(),
    });
    log.info(
      `mounted ${ref.catalogId}@${ref.version} (${manifest.counts.documents} documents, semantic search: ${semanticSearch})`,
    );
  }

  async stop(): Promise<void> {
    for (const timer of this.autoUpdateTimers.splice(0)) clearTimeout(timer);
    this.installs.clear();
    await this.opts.host.dispose();
    this.mountedByKey.clear();
  }

  // ── the gilde join ────────────────────────────────────────────────────────

  /** Every gilde `knowledge-catalog` entry (newest version), keyed by publisher/id. */
  private async gildeItems(): Promise<Map<string, KnowledgeCatalogItemManifest>> {
    const out = new Map<string, KnowledgeCatalogItemManifest>();
    if (!this.opts.catalog) return out;
    try {
      for (const item of await this.opts.catalog.list('knowledge-catalog')) {
        if (item.manifest.kind !== 'knowledge-catalog') continue;
        out.set(
          this.keyFor({ publisherId: item.manifest.publisherId, catalogId: item.manifest.id }),
          item.manifest,
        );
      }
    } catch (err) {
      log.debug(`knowledge catalog listing unavailable: ${errorMessage(err)}`);
    }
    return out;
  }

  /** Coordinates present in the machine-shared asset store (public inventory, read-only). */
  private async sharedInventoryKeys(): Promise<Set<string>> {
    const root = sharedKnowledgeRoot(this.opts.env);
    if (!root) return new Set();
    try {
      const inventory = KnowledgeMachineInventorySchema.parse(
        JSON.parse(await readFile(join(root, 'inventory.json'), 'utf8')),
      );
      return new Set(
        inventory.catalogs.map(
          (c) => `${c.publisherId}/${c.catalogId}/${c.version}/${c.contentDigest}`,
        ),
      );
    } catch {
      return new Set();
    }
  }

  // ── listing ───────────────────────────────────────────────────────────────

  async list(): Promise<KnowledgeCatalogStatus[]> {
    const gilde = await this.gildeItems();
    return this.registry.read().catalogs.map((entry) => {
      const key = this.keyFor(entry.ref);
      const mounted = this.mountedByKey.get(key);
      const item = gilde.get(key);
      const availableVersion =
        item && compareCatalogVersions(item.version, entry.ref.version) > 0
          ? item.version
          : undefined;
      return {
        ref: entry.ref,
        enabled: entry.enabled,
        addedAt: entry.addedAt,
        ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
        mounted: Boolean(mounted),
        ...(mounted
          ? {
              name: mounted.name,
              ...(mounted.description ? { description: mounted.description } : {}),
              language: mounted.language,
              license: mounted.license,
              documents: mounted.documents,
              chunks: mounted.chunks,
              sizeBytes: mounted.sizeBytes,
              vectorCompatible: mounted.vectorCompatible,
              semanticSearch: mounted.semanticSearch,
            }
          : {}),
        source: entry.source ?? (item ? 'gilde' : 'file'),
        updateAvailable: availableVersion !== undefined,
        ...(availableVersion ? { availableVersion } : {}),
      };
    });
  }

  /** Installed catalogs for which the shipped gilde content carries a strictly newer version. */
  async updates(): Promise<KnowledgeUpdateCandidate[]> {
    const gilde = await this.gildeItems();
    const out: KnowledgeUpdateCandidate[] = [];
    for (const entry of this.registry.read().catalogs) {
      const item = gilde.get(this.keyFor(entry.ref));
      if (!item || compareCatalogVersions(item.version, entry.ref.version) <= 0) continue;
      out.push({
        publisherId: item.publisherId,
        catalogId: item.id,
        name: item.name,
        installedVersion: entry.ref.version,
        availableVersion: item.version,
        releasedAt: item.releasedAt,
        archiveBytes: item.archiveBytes,
        contentDigest: item.sha256,
        huggingface: item.huggingface,
      });
    }
    return out;
  }

  /**
   * Every gilde `knowledge-catalog` entry joined with this user's registry,
   * the machine-shared inventory, running installs and partial downloads —
   * what the Knowledge screen's browser renders. Offline-safe: gilde is local.
   */
  async available(): Promise<KnowledgeAvailableCatalog[]> {
    const gilde = await this.gildeItems();
    if (gilde.size === 0) return [];
    const registry = this.registry.read().catalogs;
    const shared = await this.sharedInventoryKeys();
    const activeIds = new Set(this.installs.active().map((a) => a.id));
    const partials = await this.partialDownloadKeys();
    return [...gilde.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => {
        const entry = registry.find(
          (c) => c.ref.publisherId === item.publisherId && c.ref.catalogId === item.id,
        );
        return {
          id: item.id,
          publisherId: item.publisherId,
          name: item.name,
          description: item.description,
          tags: item.tags,
          language: item.language,
          ...(item.category ? { category: item.category } : {}),
          ...(item.license ? { license: item.license } : {}),
          ...(item.licenseUrl ? { licenseUrl: item.licenseUrl } : {}),
          version: item.version,
          releasedAt: item.releasedAt,
          formatVersion: item.formatVersion,
          huggingface: item.huggingface,
          ...(item.upstream ? { upstream: item.upstream } : {}),
          ...(item.parquet ? { parquet: item.parquet } : {}),
          sha256: item.sha256,
          archiveBytes: item.archiveBytes,
          uncompressedBytes: item.uncompressedBytes,
          documents: item.documents,
          chunks: item.chunks,
          embeddingProfile: item.embeddingProfile,
          topics: item.topics,
          ...(item.minGezelVersion ? { minGezelVersion: item.minGezelVersion } : {}),
          ...(entry
            ? {
                installed: {
                  version: entry.ref.version,
                  contentDigest: entry.ref.contentDigest,
                  storageScope: entry.ref.storageScope,
                  enabled: entry.enabled,
                  updateAvailable: compareCatalogVersions(item.version, entry.ref.version) > 0,
                },
              }
            : {}),
          sharedOnDevice: shared.has(
            `${item.publisherId}/${item.id}/${item.version}/${item.sha256}`,
          ),
          installing: activeIds.has(item.id),
          incompleteDownload: partials.has(item.sha256.slice(0, 16)),
        };
      });
  }

  /** Resolve a catalogId (URI authority) to its mounted info, or null. */
  mountedCatalog(catalogId: string): MountedInfo | null {
    for (const info of this.mountedByKey.values()) {
      if (info.ref.catalogId === catalogId) return info;
    }
    return null;
  }

  // ── install jobs ──────────────────────────────────────────────────────────

  /**
   * Start an install, or attach to the one already running. A catalog
   * install's job id is the catalog id, so a second click, the auto-updater
   * and a reconnecting client all land on the same job.
   */
  startInstall(request: KnowledgeInstallRequestSource): { jobId: string; alreadyRunning: boolean } {
    const jobId =
      request.kind === 'catalog'
        ? request.id
        : `knowledge-install-${++this.jobCounter}-${Date.now().toString(36)}`;
    const { alreadyRunning } = this.installs.start(jobId, { request });
    if (!alreadyRunning) this.jobRequests.set(jobId, request);
    return { jobId, alreadyRunning };
  }

  private async planInstall(
    request: KnowledgeInstallRequestSource,
  ): Promise<InstallPlan | { error: string }> {
    if (request.kind !== 'catalog') {
      return { source: request, origin: request.kind, placement: 'user' };
    }
    if (!this.opts.catalog) return { error: 'the catalog is not available in this daemon' };
    const resolved = await resolveKnowledgeCatalogSource(
      this.opts.catalog,
      request.id,
      request.version,
    );
    if (!resolved) {
      return {
        error: `no knowledge catalog '${request.id}'${request.version ? `@${request.version}` : ''} in the catalog`,
      };
    }
    return {
      source: { kind: 'url', url: resolved.url, expectedSha256: resolved.sha256 },
      origin: 'gilde',
      archiveBytes: resolved.archiveBytes,
      expectedIdentity: {
        publisherId: resolved.coordinate.publisherId,
        catalogId: resolved.coordinate.catalogId,
        version: resolved.coordinate.version,
      },
      coordinate: resolved.coordinate,
      placement: request.placement ?? 'auto',
    };
  }

  /**
   * Ask the machine broker to ensure the coordinate in the shared store,
   * relaying its progress. Cancelling this job cancels the broker's too:
   * this daemon asked for the download, so its cancel is the honest signal.
   */
  private async *installShared(
    coordinate: TrustedKnowledgeCoordinate,
    installer: SharedKnowledgeInstaller,
    signal: AbortSignal,
  ): AsyncGenerator<KnowledgeInstallEvent, SharedEnsureResult> {
    const queue: KnowledgeInstallEvent[] = [];
    let result: SharedEnsureResult | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const run = installer
      .ensure(
        coordinate,
        (event) => {
          queue.push(event);
          notify();
        },
        signal,
      )
      .then(
        (outcome) => {
          result = outcome;
        },
        (err) => {
          result = { status: 'unavailable', reason: errorMessage(err) };
        },
      )
      .finally(notify);
    try {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (result) break;
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
        });
      }
    } finally {
      if (signal.aborted) void installer.cancel(coordinate);
    }
    await run;
    return result ?? { status: 'unavailable', reason: 'the shared installer returned nothing' };
  }

  /** Bytes a private install of this catalog left behind, once a shared copy replaces it. */
  private async deletePrivateBytes(ref: KnowledgeCatalogRef): Promise<void> {
    const catalogDir = join(knowledgeCatalogsDir(this.opts.home), ref.publisherId, ref.catalogId);
    await rm(catalogDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch((err) => {
      log.warn(`could not delete ${catalogDir}: ${err}`);
    });
  }

  private async *runInstall(
    jobId: string,
    request: KnowledgeInstallRequestSource,
  ): AsyncGenerator<KnowledgeInstallEvent> {
    // The registry cancels by unwinding this generator; the inner download
    // only stops when its signal fires, so abort in `finally` rather than
    // relying on the unwind alone.
    const abort = new AbortController();
    const installedBefore = new Map(
      this.registry.read().catalogs.map((c) => [this.keyFor(c.ref), c.ref.version]),
    );
    const catalogId = request.kind === 'catalog' ? request.id : undefined;
    try {
      const plan = await this.planInstall(request);
      if ('error' in plan) {
        await this.recordInstallFailure(jobId, catalogId, plan.error);
        yield { type: 'error', error: plan.error };
        return;
      }
      const installer = this.opts.sharedInstaller;
      if (plan.coordinate && plan.placement === 'auto' && installer?.available()) {
        const shared = yield* this.installShared(plan.coordinate, installer, abort.signal);
        if (shared.status === 'ready') {
          const ref: KnowledgeCatalogRef = {
            publisherId: plan.coordinate.publisherId,
            catalogId: plan.coordinate.catalogId,
            version: plan.coordinate.version,
            contentDigest: plan.coordinate.expectedDigest,
            storageScope: 'machine-shared',
          };
          const previous = this.registry.find(ref.publisherId, ref.catalogId);
          this.registry.upsert(ref, { enabled: true, source: plan.origin });
          yield* this.finishInstall(
            { type: 'done', ref, rootDir: this.dirFor(ref), storageScope: 'machine-shared' },
            installedBefore,
            plan.origin,
            previous?.ref.storageScope === 'user',
          );
          return;
        }
        if (shared.status === 'failed') {
          await this.recordInstallFailure(jobId, catalogId, shared.error);
          yield { type: 'error', error: shared.error, mismatch: shared.mismatch };
          return;
        }
        if (abort.signal.aborted) return;
        log.info(
          `shared placement unavailable for ${plan.coordinate.catalogId}@${plan.coordinate.version} (${shared.reason}); installing privately`,
        );
      }
      if (plan.source.kind === 'url') {
        this.jobDownloadKeys.set(jobId, knowledgeDownloadKey(plan.source));
      }
      const run = installKnowledgeCatalog({
        home: this.opts.home,
        source: plan.source,
        origin: plan.origin,
        ...(plan.archiveBytes !== undefined ? { archiveBytes: plan.archiveBytes } : {}),
        ...(plan.expectedIdentity ? { expectedIdentity: plan.expectedIdentity } : {}),
        registry: this.registry,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        signal: abort.signal,
        validateCatalog: (rootDir, deep) => this.opts.host.validate(rootDir, deep),
      });
      for await (const event of run) {
        if (event.type === 'done') {
          yield* this.finishInstall(event, installedBefore, plan.origin);
          return;
        }
        if (event.type === 'error') await this.recordInstallFailure(jobId, catalogId, event.error);
        yield event;
      }
    } finally {
      abort.abort();
      this.jobDownloadKeys.delete(jobId);
      this.jobRequests.delete(jobId);
    }
  }

  /** Mount the fresh version, record it, and warm the query embedder before `done`. */
  private async *finishInstall(
    event: DoneEvent,
    installedBefore: Map<string, string>,
    origin: KnowledgeInstallSourceKind,
    deletePrivateBytes = false,
  ): AsyncGenerator<KnowledgeInstallEvent> {
    const key = this.keyFor(event.ref);
    await this.opts.host.unmount(key).catch(() => {});
    this.mountedByKey.delete(key);
    if (deletePrivateBytes) {
      await this.deletePrivateBytes(event.ref);
    } else if (event.ref.storageScope === 'user') {
      await pruneOtherKnowledgeCatalogVersions(this.opts.home, event.ref);
    }
    const entry = this.registry.find(event.ref.publisherId, event.ref.catalogId);
    if (entry) {
      try {
        await this.mountEntry(entry);
      } catch (err) {
        const reason = errorMessage(err);
        this.registry.quarantine(event.ref.publisherId, event.ref.catalogId, reason);
        await this.logHistory(
          'knowledge.catalog.install_failed',
          `Knowledge catalog ${event.ref.catalogId}@${event.ref.version} installed but failed to mount`,
          {
            publisherId: event.ref.publisherId,
            catalogId: event.ref.catalogId,
            version: event.ref.version,
            source: origin,
            storageScope: event.ref.storageScope,
            error: reason,
          },
        );
        yield { type: 'error', error: `installed but failed to mount: ${reason}` };
        return;
      }
    }

    const previousVersion = installedBefore.get(key);
    const updated = previousVersion !== undefined && previousVersion !== event.ref.version;
    await this.logHistory(
      updated ? 'knowledge.catalog.updated' : 'knowledge.catalog.installed',
      updated
        ? `Knowledge catalog ${event.ref.catalogId} updated ${previousVersion} → ${event.ref.version}`
        : `Knowledge catalog ${event.ref.catalogId}@${event.ref.version} installed`,
      {
        publisherId: event.ref.publisherId,
        catalogId: event.ref.catalogId,
        version: event.ref.version,
        source: origin,
        storageScope: event.ref.storageScope,
        ...(updated ? { previousVersion } : {}),
      },
    );

    let warning: string | undefined;
    const mounted = this.mountedByKey.get(key);
    if (mounted?.semanticSearch === 'profile') {
      yield { type: 'progress', phase: 'embedder', bytesDone: 0, bytesTotal: 0 };
      warning = await this.prewarmProfile(mounted.embedding);
    }
    yield { ...event, ...(warning ? { warning } : {}) };
  }

  /**
   * Pull the catalog's query model now, while the user is watching the
   * install, instead of on the first search. Never an install failure: the
   * catalog is on disk and keyword search works without the model.
   */
  private async prewarmProfile(profile: KnowledgeEmbeddingProfile): Promise<string | undefined> {
    if (!(await this.networkAllowed())) {
      return `semantic search starts once the embedding model ${profile.model.repo} can be downloaded (app network access is off)`;
    }
    try {
      await (this.opts.embedQueryForProfile ?? embedKnowledgeQuery)(
        'knowledge catalog warm-up',
        profile,
      );
      return undefined;
    } catch (err) {
      return `semantic search starts once the embedding model ${profile.model.repo} is available: ${errorMessage(err)}`;
    }
  }

  private async recordInstallFailure(
    jobId: string,
    catalogId: string | undefined,
    error: string,
  ): Promise<void> {
    await this.logHistory(
      'knowledge.catalog.install_failed',
      `Knowledge catalog install ${catalogId ?? jobId} failed`,
      { jobId, ...(catalogId ? { catalogId } : {}), error },
    );
  }

  getJob(jobId: string): KnowledgeInstallJob | null {
    const described = this.installs.describe(jobId);
    if (!described) return null;
    const events = [described.lastEvent, described.terminalEvent].filter(
      (event): event is KnowledgeInstallEvent => event !== null,
    );
    return {
      id: described.id,
      startedAt: described.startedAt,
      finished: described.finished,
      ...(described.error ? { error: described.error } : {}),
      events,
    };
  }

  /** Live events for a job; replays the latest progress (and the terminal event) first. */
  subscribeJob(
    jobId: string,
    listener: (event: KnowledgeInstallEvent) => void,
  ): (() => void) | null {
    return this.installs.subscribe(jobId, listener);
  }

  cancelJob(jobId: string): boolean {
    return this.installs.cancel(jobId);
  }

  /** Every running install with its latest progress (the polled twin of the SSE). */
  activeInstalls(): KnowledgeActiveInstall[] {
    return this.installs.active().map(({ id, startedAt, lastEvent }) => {
      const request = this.jobRequests.get(id);
      const phase =
        lastEvent?.type === 'progress'
          ? lastEvent.phase
          : lastEvent?.type === 'verifying'
            ? 'verifying'
            : lastEvent?.type === 'retrying'
              ? 'retrying'
              : 'download';
      return {
        jobId: id,
        ...(request?.kind === 'catalog' ? { catalogId: request.id } : {}),
        startedAt,
        phase,
        bytesDone: lastEvent?.type === 'progress' ? lastEvent.bytesDone : 0,
        bytesTotal: lastEvent?.type === 'progress' ? lastEvent.bytesTotal : 0,
      };
    });
  }

  // ── incomplete downloads ──────────────────────────────────────────────────

  private async partialDownloadKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    let names: string[];
    try {
      names = await readdir(knowledgeDownloadsDir(this.opts.home));
    } catch {
      return keys;
    }
    const live = new Set(this.jobDownloadKeys.values());
    for (const name of names) {
      if (!name.endsWith('.gezk.partial')) continue;
      const key = name.slice(0, -'.gezk.partial'.length);
      if (KNOWLEDGE_DOWNLOAD_KEY_PATTERN.test(key) && !live.has(key)) keys.add(key);
    }
    return keys;
  }

  /**
   * Partial archives no job is writing. A key that still matches a gilde
   * pin resumes on the next install of that catalog; anything else can only
   * be deleted. Largest first: the most disk to reclaim.
   */
  async listIncompleteDownloads(): Promise<IncompleteKnowledgeDownload[]> {
    const keys = await this.partialDownloadKeys();
    if (keys.size === 0) return [];
    const downloads = knowledgeDownloadsDir(this.opts.home);
    const byDigestPrefix = new Map<string, KnowledgeCatalogItemManifest>();
    for (const item of (await this.gildeItems()).values()) {
      byDigestPrefix.set(item.sha256.slice(0, 16), item);
    }
    const out: IncompleteKnowledgeDownload[] = [];
    for (const key of keys) {
      const info = await stat(join(downloads, `${key}.gezk.partial`)).catch(() => null);
      if (!info) continue;
      const item = byDigestPrefix.get(key);
      out.push({
        key,
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        resumable: Boolean(item),
        ...(item ? { catalogId: item.id, name: item.name, archiveBytes: item.archiveBytes } : {}),
      });
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  }

  /** Delete a partial download by key. Refuses a key a running job is writing. */
  async deleteIncompleteDownload(key: string): Promise<boolean> {
    if (!KNOWLEDGE_DOWNLOAD_KEY_PATTERN.test(key)) return false;
    if (new Set(this.jobDownloadKeys.values()).has(key)) return false;
    const downloads = knowledgeDownloadsDir(this.opts.home);
    let removed = false;
    for (const name of [`${key}.gezk.partial`, `${key}.gezk`]) {
      const path = join(downloads, name);
      if (!(await stat(path).catch(() => null))) continue;
      await rm(path, { force: true });
      removed = true;
    }
    return removed;
  }

  // ── auto-update ───────────────────────────────────────────────────────────

  /**
   * Start installs for catalogs whose registry entry (or the install-wide
   * `config.knowledge.autoUpdate` default) opted into automatic updates.
   * Returns the `catalog@version` pairs it started.
   */
  async checkAutoUpdates(): Promise<string[]> {
    if (!(await this.networkAllowed())) return [];
    const config = await this.readConfig();
    const defaultAutoUpdate = config?.knowledge?.autoUpdate ?? false;
    const started: string[] = [];
    for (const update of await this.updates()) {
      const entry = this.registry.find(update.publisherId, update.catalogId);
      if (!(entry?.autoUpdate ?? defaultAutoUpdate)) continue;
      const { alreadyRunning } = this.startInstall({
        kind: 'catalog',
        id: update.catalogId,
        version: update.availableVersion,
      });
      if (!alreadyRunning) started.push(`${update.catalogId}@${update.availableVersion}`);
    }
    if (started.length > 0) log.info(`auto-updating knowledge catalogs: ${started.join(', ')}`);
    return started;
  }

  /** Arm the daily auto-update check (a quiet start, then every 24 h); `stop()` disarms. */
  startAutoUpdateTimer(): void {
    const run = () => {
      void this.checkAutoUpdates().catch((err) => {
        log.warn(`knowledge auto-update check failed: ${errorMessage(err)}`);
      });
    };
    const startup = setTimeout(run, AUTO_UPDATE_STARTUP_DELAY_MS);
    startup.unref?.();
    const interval = setInterval(run, AUTO_UPDATE_INTERVAL_MS);
    interval.unref?.();
    this.autoUpdateTimers.push(startup, interval);
  }

  private async readConfig(): Promise<GezelConfig | null> {
    if (!this.opts.readConfig) return null;
    try {
      return await this.opts.readConfig();
    } catch {
      return null;
    }
  }

  private async networkAllowed(): Promise<boolean> {
    const config = await this.readConfig();
    return config ? resolveSecurityPolicy(config).allowAppNetwork : true;
  }

  private async logHistory(
    kind: KnowledgeHistoryKind,
    summary: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.opts.history) return;
    try {
      await this.opts.history.log({ kind, summary, details });
    } catch (err) {
      log.warn(`history write failed for ${kind}: ${errorMessage(err)}`);
    }
  }

  // ── lifecycle mutations ───────────────────────────────────────────────────

  async setEnabled(catalogId: string, enabled: boolean): Promise<boolean> {
    const entry = this.registry.read().catalogs.find((c) => c.ref.catalogId === catalogId);
    if (!entry) return false;
    const changed = this.registry.setEnabled(entry.ref.publisherId, catalogId, enabled);
    if (!changed) return false;
    const key = this.keyFor(entry.ref);
    if (enabled) {
      const fresh = this.registry.find(entry.ref.publisherId, catalogId);
      if (fresh) {
        await this.mountEntry(fresh).catch((err) => {
          const reason = errorMessage(err);
          this.registry.quarantine(entry.ref.publisherId, catalogId, reason);
        });
      }
    } else {
      await this.opts.host.unmount(key).catch(() => {});
      this.mountedByKey.delete(key);
    }
    await this.logHistory(
      enabled ? 'knowledge.catalog.enabled' : 'knowledge.catalog.disabled',
      `Knowledge catalog ${catalogId} ${enabled ? 'enabled' : 'disabled'}`,
      {
        publisherId: entry.ref.publisherId,
        catalogId,
        version: entry.ref.version,
        storageScope: entry.ref.storageScope,
      },
    );
    return true;
  }

  /**
   * Adopt a catalog that already exists in the machine-shared asset store:
   * add this user's ref and mount read-only. The shared bytes belong to the
   * machine installer — adoption and removal never touch them.
   */
  async adoptSharedCatalog(coordinate: {
    publisherId: string;
    catalogId: string;
    version: string;
    expectedDigest: string;
  }): Promise<boolean> {
    const ref: KnowledgeCatalogRef = {
      publisherId: coordinate.publisherId,
      catalogId: coordinate.catalogId,
      version: coordinate.version,
      contentDigest: coordinate.expectedDigest,
      storageScope: 'machine-shared',
    };
    this.registry.upsert(ref, { enabled: true, source: 'gilde' });
    const entry = this.registry.find(ref.publisherId, ref.catalogId);
    if (!entry) return false;
    try {
      const key = this.keyFor(ref);
      await this.opts.host.unmount(key).catch(() => {});
      this.mountedByKey.delete(key);
      await this.mountEntry(entry);
      return true;
    } catch (err) {
      const reason = errorMessage(err);
      this.registry.quarantine(ref.publisherId, ref.catalogId, reason);
      return false;
    }
  }

  /** Remove the ref and (for the private tier) delete the bytes. */
  async remove(catalogId: string): Promise<boolean> {
    const entry = this.registry.read().catalogs.find((c) => c.ref.catalogId === catalogId);
    if (!entry) return false;
    const key = this.keyFor(entry.ref);
    await this.opts.host.unmount(key).catch(() => {});
    this.mountedByKey.delete(key);
    this.registry.remove(entry.ref.publisherId, catalogId);
    if (entry.ref.storageScope === 'user') {
      const catalogDir = join(
        knowledgeCatalogsDir(this.opts.home),
        entry.ref.publisherId,
        entry.ref.catalogId,
      );
      await rm(catalogDir, { recursive: true, force: true }).catch((err) => {
        log.warn(`could not delete ${catalogDir}: ${err}`);
      });
    }
    await this.logHistory(
      'knowledge.catalog.removed',
      `Knowledge catalog ${catalogId}@${entry.ref.version} removed`,
      {
        publisherId: entry.ref.publisherId,
        catalogId,
        version: entry.ref.version,
        storageScope: entry.ref.storageScope,
      },
    );
    return true;
  }

  // ── browsing (routes) ─────────────────────────────────────────────────────

  private requireMounted(catalogId: string): MountedInfo {
    const info = this.mountedCatalog(catalogId);
    if (!info)
      throw new KnowledgeNotFoundError(`catalog not installed or not enabled: ${catalogId}`);
    return info;
  }

  async topics(catalogId: string): ReturnType<KnowledgeCatalogHost['topics']> {
    return this.opts.host.topics(this.requireMounted(catalogId).key);
  }

  async documentsPage(
    catalogId: string,
    opts: { topicId?: string; offset?: number; limit?: number },
  ): ReturnType<KnowledgeCatalogHost['documentsPage']> {
    return this.opts.host.documentsPage(this.requireMounted(catalogId).key, opts);
  }

  async getDocument(
    catalogId: string,
    documentId: string,
  ): ReturnType<KnowledgeCatalogHost['getDocument']> {
    return this.opts.host.getDocument(this.requireMounted(catalogId).key, documentId);
  }

  // ── the SearchService knowledge arm ───────────────────────────────────────

  /**
   * Explicit search across active catalogs. Catalogs are grouped by how their
   * queries are embedded — the daemon's own vector for profiles it shares,
   * one profile-embedded vector per foreign profile, none for keyword-only —
   * and each group searches with its own vector, so every catalog is
   * searched in the space it was built in. Results come back FINISHED —
   * provenance, topic names, scoring.
   */
  async searchUnified(
    query: string,
    opts: { vector: number[] | null; maxResults: number; projectId?: string },
  ): Promise<UnifiedSearchResult[]> {
    const active = await this.activeCatalogKeys(opts.projectId);
    if (active.length === 0) return [];

    const groups: Array<{ keys: string[]; vector?: Float32Array }> = [];
    const shared: string[] = [];
    const keyword: string[] = [];
    const byProfile = new Map<string, { profile: KnowledgeEmbeddingProfile; keys: string[] }>();
    for (const key of active) {
      const info = this.mountedByKey.get(key);
      if (!info) continue;
      if (info.semanticSearch === 'shared') shared.push(key);
      else if (info.semanticSearch === 'profile') {
        const group = byProfile.get(info.embedding.id) ?? { profile: info.embedding, keys: [] };
        group.keys.push(key);
        byProfile.set(info.embedding.id, group);
      } else keyword.push(key);
    }
    if (shared.length > 0) {
      groups.push({
        keys: shared,
        ...(opts.vector ? { vector: Float32Array.from(opts.vector) } : {}),
      });
    }
    for (const group of byProfile.values()) {
      const vector = await this.embedForProfile(query, group.profile);
      groups.push({ keys: group.keys, ...(vector ? { vector } : {}) });
    }
    if (keyword.length > 0) groups.push({ keys: keyword });

    const response = {
      chunks: [] as GlobalSearchHit[],
      documents: [] as GlobalSearchDocumentHit[],
    };
    for (const group of groups) {
      const part = await this.opts.host.search({
        query,
        ...(group.vector ? { vector: group.vector } : {}),
        shardBudget: ROUTE_BUDGET_EXPLICIT,
        finalK: FINAL_K,
        includeChunkFts: true,
        catalogKeys: group.keys,
        docFtsLimit: 6,
      });
      response.chunks.push(...part.chunks);
      response.documents.push(...part.documents);
    }

    const out: UnifiedSearchResult[] = [];
    const perCatalogCount = new Map<string, number>();
    const sorted = [...response.chunks].sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0));
    let rank = 0;
    for (const hit of sorted) {
      const info = this.mountedByKey.get(hit.catalogKey);
      if (!info) continue;
      const count = perCatalogCount.get(hit.catalogKey) ?? 0;
      if (count >= 3) continue; // diversity cap: ≤3 chunks per catalog
      perCatalogCount.set(hit.catalogKey, count + 1);
      out.push(this.toResult(info, hit, rank++));
      if (out.length >= Math.max(10, opts.maxResults)) break;
    }

    // Doc-title FTS floor: exact-name recall never depends on vector routing.
    for (const [docRank, doc] of response.documents.entries()) {
      const info = this.mountedByKey.get(doc.catalogKey);
      if (!info) continue;
      const meta = await this.opts.host.getDocument(info.key, doc.documentId).catch(() => null);
      if (!meta) continue;
      out.push({
        kind: 'knowledge',
        id: `knowledge:${info.ref.catalogId}:doc:${doc.documentId}`,
        title: meta.title,
        subtitle: `${info.name} · ${info.topicNames.get(meta.topicId) ?? meta.topicId}`,
        ...(meta.summary ? { snippet: meta.summary } : {}),
        retrievalSource: 'knowledge',
        catalogId: info.ref.catalogId,
        catalogVersion: info.ref.version,
        documentId: doc.documentId,
        topicPath: [info.topicNames.get(meta.topicId) ?? meta.topicId],
        uri: formatKnowledgeUri({
          publisherId: info.ref.publisherId,
          catalogId: info.ref.catalogId,
          documentId: doc.documentId,
        }),
        ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        ...scoreResult('knowledge', ftsRankRelevance(docRank)),
      });
    }
    return out;
  }

  /** A profile's query vector, or undefined when its model is unavailable (that group searches FTS). */
  private async embedForProfile(
    query: string,
    profile: KnowledgeEmbeddingProfile,
  ): Promise<Float32Array | undefined> {
    try {
      const vector = await (this.opts.embedQueryForProfile ?? embedKnowledgeQuery)(query, profile);
      return vector.length > 0 ? Float32Array.from(vector) : undefined;
    } catch (err) {
      log.debug(
        `knowledge query embedding unavailable for profile ${profile.id}; searching FTS only: ${errorMessage(err)}`,
      );
      return undefined;
    }
  }

  private toResult(info: MountedInfo, hit: GlobalSearchHit, rank: number): UnifiedSearchResult {
    const relevance =
      hit.cosine !== undefined ? cosineRelevance(hit.cosine) : ftsRankRelevance(rank);
    return {
      kind: 'knowledge',
      id: `knowledge:${info.ref.catalogId}:${hit.chunkUid}`,
      title:
        hit.headingPath.length > 0 ? `${hit.title} › ${hit.headingPath.join(' › ')}` : hit.title,
      subtitle: info.name,
      snippet: hit.text,
      retrievalSource: 'knowledge',
      catalogId: info.ref.catalogId,
      catalogVersion: info.ref.version,
      documentId: hit.documentId,
      uri: formatKnowledgeUri({
        publisherId: info.ref.publisherId,
        catalogId: info.ref.catalogId,
        documentId: hit.documentId,
        fragment: { chunk: hit.chunkUid },
      }),
      line: hit.lineStart,
      lineEnd: hit.lineEnd,
      ...scoreResult('knowledge', relevance),
    };
  }

  /** Enabled+mounted catalogs, intersected with the project policy. */
  private async activeCatalogKeys(projectId?: string): Promise<string[]> {
    const mounted = [...this.mountedByKey.values()];
    if (!projectId || !this.opts.projectPolicy) return mounted.map((m) => m.key);
    const policy = await this.opts.projectPolicy(projectId).catch(() => null);
    if (!policy || policy.mode === 'inherit') return mounted.map((m) => m.key);
    if (policy.mode === 'off') return [];
    const selected = new Set((policy.refs ?? []).map((r) => `${r.publisherId}/${r.catalogId}`));
    return mounted.filter((m) => selected.has(m.key)).map((m) => m.key);
  }
}

export class KnowledgeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeNotFoundError';
  }
}
