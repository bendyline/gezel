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
  CatalogAssetInfo,
  CatalogAssetRead,
  CatalogChunkHit,
  CatalogDocumentMeta,
  CatalogHandle,
  CatalogTopic,
  CatalogValidationReport,
} from '@bendyline/gezel-knowledge';

type OpenHandle = CatalogHandle & { catalogId: string };

export interface MountSpec {
  /** `publisherId/catalogId` — stable across versions. */
  key: string;
  rootDir: string;
  catalogId: string;
  version: string;
}

export interface GlobalSearchHit extends CatalogChunkHit {
  catalogKey: string;
  catalogId: string;
}

export interface GlobalSearchRequest {
  /** Unit query vector, or absent for FTS-only search. */
  vector?: Float32Array;
  query: string;
  /** Global shard budget across every mounted catalog (S). */
  shardBudget: number;
  finalK: number;
  /** Chunk-body FTS over routed shards (explicit search only). */
  includeChunkFts: boolean;
  /** Restrict to these catalog keys (default: all mounted). */
  catalogKeys?: string[];
  docFtsLimit?: number;
}

export interface GlobalSearchResponse {
  chunks: GlobalSearchHit[];
  documents: Array<{ catalogKey: string; catalogId: string; documentId: string; rank: number }>;
}

export interface KnowledgeCatalogHost {
  mount(spec: MountSpec): Promise<void>;
  unmount(key: string): Promise<void>;
  mounted(): Promise<string[]>;
  /** Deep or shallow validation of an extracted catalog dir (quarantine gate). */
  validate(rootDir: string, deep: boolean): Promise<CatalogValidationReport>;
  topics(key: string): Promise<CatalogTopic[]>;
  documentsPage(
    key: string,
    opts: { topicId?: string; offset?: number; limit?: number; descendants?: boolean },
  ): Promise<{ documents: CatalogDocumentMeta[]; total: number }>;
  getDocument(
    key: string,
    documentId: string,
  ): Promise<(CatalogDocumentMeta & { markdown: string }) | null>;
  /** The catalog's declared `assets/` files. */
  assets(key: string): Promise<CatalogAssetInfo[]>;
  /** One declared asset's bytes, or null when the catalog ships no such asset. */
  readAsset(key: string, path: string): Promise<CatalogAssetRead | null>;
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

    const documents: GlobalSearchResponse['documents'] = [];
    for (const { key, handle } of active) {
      for (const hit of handle.searchDocumentsFts(request.query, request.docFtsLimit ?? 8)) {
        documents.push({
          catalogKey: key,
          catalogId: handle.catalogId,
          documentId: hit.documentId,
          rank: hit.rank,
        });
      }
    }

    const chunks: GlobalSearchHit[] = [];
    /** Global routing: score shards across all catalogs, spend S once. */
    const routed = new Map<string, number[]>();
    if (request.vector) {
      const scored: Array<{ key: string; shardId: number; score: number }> = [];
      for (const { key, handle } of active) {
        for (const s of handle.scoreShards(request.vector)) {
          scored.push({ key, shardId: s.shardId, score: s.score });
        }
      }
      for (const pick of scored.sort((a, b) => b.score - a.score).slice(0, request.shardBudget)) {
        const list = routed.get(pick.key) ?? [];
        list.push(pick.shardId);
        routed.set(pick.key, list);
      }
      for (const { key, handle } of active) {
        const shardIds = routed.get(key);
        if (!shardIds || shardIds.length === 0) continue;
        for (const hit of handle.searchShards(request.vector, shardIds, request.finalK)) {
          chunks.push({ ...hit, catalogKey: key, catalogId: handle.catalogId });
        }
      }
    }
    if (request.includeChunkFts) {
      for (const { key, handle } of active) {
        const shardIds = routed.get(key) ?? handle.shards.map((s) => s.id);
        for (const hit of handle.searchChunksFts(request.query, shardIds, 8)) {
          chunks.push({ ...hit, catalogKey: key, catalogId: handle.catalogId });
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
    validate: async (rootDir, deep) => validateExtractedCatalog(rootDir, { deep }),
    topics: async (key) => mustGet(handles, key).topics(),
    documentsPage: async (key, opts) => mustGet(handles, key).documentsPage(opts),
    getDocument: async (key, documentId) => mustGet(handles, key).getDocument(documentId),
    assets: async (key) => mustGet(handles, key).assets(),
    readAsset: async (key, path) => mustGet(handles, key).readAsset(path),
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
