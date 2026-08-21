/**
 * KnowledgeManager — the daemon-side owner of installed `.gezk` catalogs:
 * registry + mount lifecycle (verify-before-mount → quarantine-with-reason),
 * install jobs, browse APIs for the routes, and the SearchService knowledge
 * arm. Every SQLite touch goes through the KnowledgeCatalogHost (worker
 * thread in production); this class never opens a catalog database itself.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  KnowledgeCatalogRef,
  ProjectKnowledgeCatalogs,
  UnifiedSearchResult,
} from '@bendyline/gezel';
import { createLogger, formatKnowledgeUri } from '@bendyline/gezel';
import { knowledgeCatalogVersionDir, knowledgeCatalogsDir } from '@bendyline/gezel/paths';
import {
  sharedKnowledgeRoot,
  sharedKnowledgeVersionDir,
} from '../machine-engine/knowledge-assets.js';
import { embedModelId } from '../memory/embed-core.js';
import { ftsRankRelevance, scoreResult } from '../search/search-service.js';
import type { GlobalSearchHit, KnowledgeCatalogHost } from './catalog-host.js';
import {
  type KnowledgeInstallEvent,
  type KnowledgeInstallSource,
  installKnowledgeCatalog,
} from './install.js';
import { KnowledgeRegistry, type KnowledgeRegistryEntry } from './registry.js';

const log = createLogger('knowledge');

/** Explicit-search shard budget (S) across every active catalog (§3.4). */
const ROUTE_BUDGET_EXPLICIT = 6;
const FINAL_K = 24;
const JOB_TTL_MS = 10 * 60_000;
const RECENT_EVENT_CAP = 64;

/** Provisional cosine → calibrated relevance (tuned by Phase-4 evals). */
function cosineRelevance(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine - 0.3) / 0.5));
}

export interface KnowledgeCatalogStatus {
  ref: KnowledgeCatalogRef;
  enabled: boolean;
  addedAt: string;
  disabledReason?: string;
  mounted: boolean;
  name?: string;
  description?: string;
  language?: string;
  license?: string;
  documents?: number;
  chunks?: number;
  sizeBytes?: number;
  /** False when the catalog's embedding profile differs from the daemon's
   * embedder — semantic search degrades to FTS for this catalog. */
  vectorCompatible?: boolean;
}

export interface KnowledgeInstallJob {
  id: string;
  startedAt: string;
  finished: boolean;
  error?: string;
  events: KnowledgeInstallEvent[];
}

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
  /** topic id → display name, from the shipped TOC. */
  topicNames: Map<string, string>;
  sourceUrlByDoc: Map<string, string>;
}

interface JobEntry {
  job: KnowledgeInstallJob;
  listeners: Set<(event: KnowledgeInstallEvent) => void>;
  abort: AbortController;
}

export interface KnowledgeManagerOptions {
  home: string;
  host: KnowledgeCatalogHost;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Project policy lookup (Store.getProject wrapper); null = no policy. */
  projectPolicy?: (projectId: string) => Promise<ProjectKnowledgeCatalogs | null>;
}

export class KnowledgeManager {
  readonly registry: KnowledgeRegistry;
  private readonly mountedByKey = new Map<string, MountedInfo>();
  private readonly jobs = new Map<string, JobEntry>();
  private jobCounter = 0;

  constructor(private readonly opts: KnowledgeManagerOptions) {
    this.registry = new KnowledgeRegistry(opts.home);
  }

  get host(): KnowledgeCatalogHost {
    return this.opts.host;
  }

  private keyFor(ref: KnowledgeCatalogRef): string {
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
        const reason = err instanceof Error ? err.message : String(err);
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

    // Verify before first mount: shallow validation covers manifest, per-file
    // hashes, read-only opens, and count reconciliation. A failure is a
    // quarantine, not an exception surface — the caller records the reason.
    const report = await this.opts.host.validate(rootDir, false);
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

    // The daemon embeds queries with ONE pipeline; a catalog on a different
    // profile degrades to FTS rather than searching a foreign vector space.
    const vectorCompatible = manifest.embedding.model.repo === embedModelId();

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
      topicNames: new Map(topics.map((t) => [t.id, t.name])),
      sourceUrlByDoc: new Map(),
    });
    log.info(
      `mounted ${ref.catalogId}@${ref.version} (${manifest.counts.documents} documents${vectorCompatible ? '' : ', FTS-only: foreign embedding profile'})`,
    );
  }

  async stop(): Promise<void> {
    for (const entry of this.jobs.values()) entry.abort.abort();
    await this.opts.host.dispose();
    this.mountedByKey.clear();
  }

  // ── listing ───────────────────────────────────────────────────────────────

  async list(): Promise<KnowledgeCatalogStatus[]> {
    return this.registry.read().catalogs.map((entry) => {
      const mounted = this.mountedByKey.get(this.keyFor(entry.ref));
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
            }
          : {}),
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

  startInstall(source: KnowledgeInstallSource): { jobId: string } {
    const jobId = `knowledge-install-${++this.jobCounter}-${Date.now().toString(36)}`;
    const abort = new AbortController();
    const entry: JobEntry = {
      job: { id: jobId, startedAt: new Date().toISOString(), finished: false, events: [] },
      listeners: new Set(),
      abort,
    };
    this.jobs.set(jobId, entry);
    void this.runInstall(entry, source);
    return { jobId };
  }

  private async runInstall(entry: JobEntry, source: KnowledgeInstallSource): Promise<void> {
    const emit = (event: KnowledgeInstallEvent): void => {
      entry.job.events.push(event);
      if (entry.job.events.length > RECENT_EVENT_CAP) entry.job.events.shift();
      for (const listener of entry.listeners) listener(event);
    };
    let sawTerminal = false;
    try {
      const run = installKnowledgeCatalog({
        home: this.opts.home,
        source,
        registry: this.registry,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        signal: entry.abort.signal,
      });
      for await (const event of run) {
        if (event.type === 'done') {
          sawTerminal = true;
          // Remount the fresh version (replacing any older mount).
          const key = this.keyFor(event.ref);
          await this.opts.host.unmount(key).catch(() => {});
          this.mountedByKey.delete(key);
          const registryEntry = this.registry.find(event.ref.publisherId, event.ref.catalogId);
          if (registryEntry) {
            await this.mountEntry(registryEntry).catch((err) => {
              const reason = err instanceof Error ? err.message : String(err);
              this.registry.quarantine(event.ref.publisherId, event.ref.catalogId, reason);
              emit({ type: 'error', error: `installed but failed to mount: ${reason}` });
            });
          }
          emit(event);
        } else {
          if (event.type === 'error') sawTerminal = true;
          emit(event);
        }
      }
      if (!sawTerminal) {
        emit({
          type: 'error',
          error: entry.abort.signal.aborted ? 'install cancelled' : 'install ended unexpectedly',
        });
      }
    } catch (err) {
      emit({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      entry.job.finished = true;
      const lastError = [...entry.job.events].reverse().find((e) => e.type === 'error');
      if (lastError && lastError.type === 'error') entry.job.error = lastError.error;
      const timer = setTimeout(() => this.jobs.delete(entry.job.id), JOB_TTL_MS);
      timer.unref?.();
    }
  }

  getJob(jobId: string): KnowledgeInstallJob | null {
    return this.jobs.get(jobId)?.job ?? null;
  }

  subscribeJob(
    jobId: string,
    listener: (event: KnowledgeInstallEvent) => void,
  ): (() => void) | null {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    for (const event of entry.job.events) listener(event);
    if (entry.job.finished) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  cancelJob(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry || entry.job.finished) return false;
    entry.abort.abort();
    return true;
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
          const reason = err instanceof Error ? err.message : String(err);
          this.registry.quarantine(entry.ref.publisherId, catalogId, reason);
        });
      }
    } else {
      await this.opts.host.unmount(key).catch(() => {});
      this.mountedByKey.delete(key);
    }
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
    this.registry.upsert(ref, { enabled: true });
    const entry = this.registry.find(ref.publisherId, ref.catalogId);
    if (!entry) return false;
    try {
      const key = this.keyFor(ref);
      await this.opts.host.unmount(key).catch(() => {});
      this.mountedByKey.delete(key);
      await this.mountEntry(entry);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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
   * Explicit search across active catalogs. The vector is reused only for
   * catalogs on the daemon's own embedding profile; others search FTS.
   * Results come back FINISHED — provenance, topic names, scoring.
   */
  async searchUnified(
    query: string,
    opts: { vector: number[] | null; maxResults: number; projectId?: string },
  ): Promise<UnifiedSearchResult[]> {
    const active = await this.activeCatalogKeys(opts.projectId);
    if (active.length === 0) return [];

    const vectorKeys = active.filter((k) => this.mountedByKey.get(k)?.vectorCompatible);
    const vector =
      opts.vector && vectorKeys.length > 0 ? Float32Array.from(opts.vector) : undefined;

    const response = await this.opts.host.search({
      query,
      ...(vector ? { vector } : {}),
      shardBudget: ROUTE_BUDGET_EXPLICIT,
      finalK: FINAL_K,
      includeChunkFts: true,
      catalogKeys: active,
      docFtsLimit: 6,
    });

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
        uri: formatKnowledgeUri({ catalogId: info.ref.catalogId, documentId: doc.documentId }),
        ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        ...scoreResult('knowledge', ftsRankRelevance(docRank)),
      });
    }
    return out;
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
