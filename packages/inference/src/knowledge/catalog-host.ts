/**
 * The catalog host boundary: everything that touches catalog SQLite goes
 * through this interface. Two implementations — the in-process host below
 * (tests, and the fallback when the worker cannot boot) and the worker
 * host (worker-host.ts), which confines node:sqlite's synchronous scans to
 * a dedicated thread so a 100 ms shard scan never stalls the daemon loop
 * (docs/gezk-format.md). The in-process implementation is test/CLI-only;
 * production fails closed if its worker becomes unavailable.
 */

import type {
  CatalogAssetFile,
  CatalogAssetInfo,
  CatalogAssetRead,
  CatalogChunkHit,
  CatalogDocumentMeta,
  CatalogHandle,
  CatalogTopic,
  CatalogValidationReport,
} from '@bendyline/gezel-knowledge';

import type { KnowledgeRadius } from '@bendyline/gezel';
import type { SpatialMatch } from '@bendyline/gezel-knowledge';

type OpenHandle = CatalogHandle & { catalogId: string };

export interface MountSpec {
  /** `publisherId/catalogId` — stable across versions. */
  key: string;
  rootDir: string;
  catalogId: string;
  version: string;
}

export interface GlobalSearchHit extends CatalogChunkHit, Partial<SpatialMatch> {
  catalogKey: string;
  catalogId: string;
}

/** A passage read by its citation id, without search scoring. */
export type KnowledgeChunk = Omit<CatalogChunkHit, 'cosine' | 'source'>;

export interface GlobalSearchRequest {
  /** Unit query vector, or absent for FTS-only search. */
  vector?: Float32Array;
  query: string;
  /** Global shard budget across every mounted catalog (S). */
  shardBudget: number;
  /**
   * Extra shards, beyond S and across every catalog, holding a page the
   * query names by title (`CatalogHandle.titleRouteShards`), most specific
   * name first. Default 0.
   */
  titleRouteShards?: number;
  finalK: number;
  /** Chunk-body FTS over routed shards (explicit search only). */
  includeChunkFts: boolean;
  /** Restrict to these catalog keys (default: all mounted). */
  catalogKeys?: string[];
  docFtsLimit?: number;
  /** Chunk-body FTS hits per shard (default 8). */
  chunkFtsLimit?: number;
  spatial?: KnowledgeRadius;
  /**
   * Media rows to return per modality per catalog from the exact media lane
   * (`CatalogHandle.searchMedia`). Needs `vector`; default 0, so proactive
   * retrieval stays text-only unless it asks.
   */
  mediaK?: number;
}

export interface GlobalSearchResponse {
  chunks: GlobalSearchHit[];
  documents: Array<
    {
      catalogKey: string;
      catalogId: string;
      documentId: string;
      rank: number;
    } & Partial<SpatialMatch>
  >;
}

export interface KnowledgeCatalogHost {
  mount(spec: MountSpec): Promise<void>;
  unmount(key: string): Promise<void>;
  mounted(): Promise<string[]>;
  /** Load a mounted catalog's vector bits ahead of its first search; resolves to the shards loaded. */
  prewarm(key: string): Promise<number>;
  /** Deep or shallow validation of an extracted catalog dir (quarantine gate). */
  validate(rootDir: string, deep: boolean): Promise<CatalogValidationReport>;
  topics(key: string): Promise<CatalogTopic[]>;
  documentsPage(
    key: string,
    opts: { topicId?: string; offset?: number; limit?: number; descendants?: boolean },
  ): Promise<{ documents: CatalogDocumentMeta[]; total: number }>;
  nearbyDocuments(
    key: string,
    radius: KnowledgeRadius,
    opts: { offset?: number; limit?: number },
  ): Promise<{
    documents: Array<CatalogDocumentMeta & SpatialMatch>;
    total: number;
  }>;
  getDocument(
    key: string,
    documentId: string,
  ): Promise<(CatalogDocumentMeta & { markdown: string }) | null>;
  /** One passage by its citation id; null when the catalog does not hold it. */
  getChunk(key: string, documentId: string, chunkUid: string): Promise<KnowledgeChunk | null>;
  /** The catalog's declared `assets/` files. */
  assets(key: string): Promise<CatalogAssetInfo[]>;
  /** One declared asset's bytes, or null when the catalog ships no such asset. */
  readAsset(key: string, path: string): Promise<CatalogAssetRead | null>;
  /** A declared asset's verified file on disk, for range-streaming large media. */
  assetFile(key: string, path: string): Promise<CatalogAssetFile | null>;
  search(request: GlobalSearchRequest): Promise<GlobalSearchResponse>;
  dispose(): Promise<void>;
}

/** Direct CatalogHandle host — used by tests and as the no-worker fallback. */
export async function createInProcessCatalogHost(): Promise<KnowledgeCatalogHost> {
  const { CatalogHandle: Handle, validateExtractedCatalog } = await import(
    '@bendyline/gezel-knowledge'
  );
  const handles = new Map<string, OpenHandle>();

  const searchImpl = (request: GlobalSearchRequest): GlobalSearchResponse => {
    const keys = request.catalogKeys ?? [...handles.keys()];
    const active = keys
      .map((key) => ({ key, handle: handles.get(key) }))
      .filter((e): e is { key: string; handle: OpenHandle } => Boolean(e.handle));

    const spatial = new Map(
      active.map(({ key, handle }) => [
        key,
        request.spatial ? handle.spatialMatches(request.spatial) : undefined,
      ]),
    );
    const allowed = (key: string) => {
      const matches = spatial.get(key);
      return matches ? new Set(matches.keys()) : undefined;
    };
    const documents: GlobalSearchResponse['documents'] = [];
    for (const { key, handle } of active) {
      for (const hit of handle.searchDocumentsFts(
        request.query,
        request.docFtsLimit ?? 8,
        allowed(key),
      )) {
        documents.push({
          catalogKey: key,
          catalogId: handle.catalogId,
          documentId: hit.documentId,
          rank: hit.rank,
          ...spatial.get(key)?.get(hit.documentId),
        });
      }
    }

    const chunks: GlobalSearchHit[] = [];
    /** Global routing: score shards across all catalogs, spend S once. */
    const routed = new Map<string, number[]>();
    if (request.spatial) {
      for (const { key, handle } of active)
        routed.set(key, handle.shardsForDocuments(allowed(key)!));
    }
    if (request.vector) {
      const scored: Array<{ key: string; shardId: number; score: number }> = [];
      for (const { key, handle } of active) {
        if (request.spatial) continue;
        for (const s of handle.scoreShards(request.vector)) {
          scored.push({ key, shardId: s.shardId, score: s.score });
        }
      }
      for (const pick of scored.sort((a, b) => b.score - a.score).slice(0, request.shardBudget)) {
        const list = routed.get(pick.key) ?? [];
        list.push(pick.shardId);
        routed.set(pick.key, list);
      }
      // Title-assisted routing: centroid scores alone can leave out the
      // shard holding the very page the question names, so scan it too.
      const extra = request.spatial ? 0 : (request.titleRouteShards ?? 0);
      if (extra > 0) {
        const named: Array<{ key: string; shardId: number; score: number }> = [];
        for (const { key, handle } of active) {
          for (const s of handle.titleRouteShards(request.query, extra)) named.push({ key, ...s });
        }
        // Exact-title matches score Infinity, so compare rather than subtract.
        named.sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? 1 : -1));
        let added = 0;
        for (const pick of named) {
          if (added >= extra) break;
          const list = routed.get(pick.key) ?? [];
          if (list.includes(pick.shardId)) continue;
          list.push(pick.shardId);
          routed.set(pick.key, list);
          added++;
        }
      }
      for (const { key, handle } of active) {
        const shardIds = routed.get(key);
        if (!shardIds || shardIds.length === 0) continue;
        for (const hit of handle.searchShards(
          request.vector,
          shardIds,
          request.finalK,
          allowed(key),
        )) {
          chunks.push({
            ...hit,
            catalogKey: key,
            catalogId: handle.catalogId,
            ...spatial.get(key)?.get(hit.documentId),
          });
        }
      }
    }
    if (request.vector && (request.mediaK ?? 0) > 0) {
      for (const { key, handle } of active) {
        for (const hit of handle.searchMedia(request.vector, {
          perModality: request.mediaK,
          ...(request.spatial ? { allowedDocumentIds: allowed(key) } : {}),
        })) {
          chunks.push({
            ...hit,
            catalogKey: key,
            catalogId: handle.catalogId,
            ...spatial.get(key)?.get(hit.documentId),
          });
        }
      }
    }
    if (request.includeChunkFts) {
      for (const { key, handle } of active) {
        const shardIds = routed.get(key) ?? handle.shards.map((s) => s.id);
        for (const hit of handle.searchChunksFts(
          request.query,
          shardIds,
          request.chunkFtsLimit ?? 8,
          allowed(key),
        )) {
          chunks.push({
            ...hit,
            catalogKey: key,
            catalogId: handle.catalogId,
            ...spatial.get(key)?.get(hit.documentId),
          });
        }
      }
    }
    return { chunks, documents };
  };

  return {
    mount: async (spec) => {
      if (handles.has(spec.key)) return;
      const handle = Handle.open(spec.rootDir) as OpenHandle;
      handle.catalogId = spec.catalogId;
      const metaCatalog = handle.meta.catalog_id;
      if (metaCatalog !== spec.catalogId) {
        handle.close();
        throw new Error(`catalog identity mismatch: router says '${metaCatalog}'`);
      }
      handles.set(spec.key, handle);
    },
    unmount: async (key) => {
      handles.get(key)?.close();
      handles.delete(key);
    },
    mounted: async () => [...handles.keys()],
    prewarm: async (key) => {
      const handle = mustGet(handles, key);
      let loaded = 0;
      // Stop if the catalog is unmounted mid-warm: a closed handle would
      // reopen its shard connections to load the next one.
      while (handles.get(key) === handle && handle.prewarmNextShard()) {
        loaded++;
        // Yield between shards so searches queued behind a large catalog's
        // warm-up are answered instead of waiting for all of it.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return loaded;
    },
    validate: async (rootDir, deep) => validateExtractedCatalog(rootDir, { deep }),
    topics: async (key) => mustGet(handles, key).topics(),
    documentsPage: async (key, opts) => mustGet(handles, key).documentsPage(opts),
    nearbyDocuments: async (key, radius, opts) =>
      mustGet(handles, key).nearbyDocuments(radius, opts),
    getDocument: async (key, documentId) => mustGet(handles, key).getDocument(documentId),
    getChunk: async (key, documentId, chunkUid) =>
      mustGet(handles, key).getChunk(documentId, chunkUid),
    assets: async (key) => mustGet(handles, key).assets(),
    readAsset: async (key, path) => mustGet(handles, key).readAsset(path),
    assetFile: async (key, path) => mustGet(handles, key).assetFile(path),
    search: async (request) => searchImpl(request),
    dispose: async () => {
      for (const handle of handles.values()) handle.close();
      handles.clear();
    },
  };
}

function mustGet<V>(map: Map<string, V>, key: string): V {
  const value = map.get(key);
  if (!value) throw new Error(`catalog not mounted: ${key}`);
  return value;
}
