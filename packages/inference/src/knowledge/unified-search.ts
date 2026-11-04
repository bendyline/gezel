/**
 * Explicit knowledge search across mounted catalogs: each catalog searched in
 * its own embedding space, the lexical and vector arms fused by reciprocal
 * rank. Platform-neutral — the daemon's KnowledgeManager and the on-device
 * Capacitor host both run it over their own KnowledgeCatalogHost.
 */
import {
  type KnowledgeCatalogRef,
  type KnowledgeEmbeddingProfile,
  type KnowledgeRadius,
  type KnowledgeSemanticSearchMode,
  type UnifiedSearchResult,
  formatKnowledgeUri,
  scoreResult,
} from '@bendyline/gezel';
import type {
  GlobalSearchHit,
  GlobalSearchResponse,
  KnowledgeCatalogHost,
} from './catalog-host.js';
import { spatialDocumentIdentity } from './spatial-query.js';

type GlobalSearchDocumentHit = GlobalSearchResponse['documents'][number];

/** What fusion and result shaping read about a mounted catalog. */
export interface UnifiedSearchCatalog {
  ref: KnowledgeCatalogRef;
  key: string;
  name: string;
  semanticSearch: KnowledgeSemanticSearchMode;
  embedding: KnowledgeEmbeddingProfile;
  /** topic id → display name, from the shipped TOC. */
  topicNames: Map<string, string>;
}

export interface UnifiedSearchDeps {
  catalog(key: string): UnifiedSearchCatalog | undefined;
  host: Pick<KnowledgeCatalogHost, 'search' | 'getDocument'>;
  /** The profile's query vector, or undefined to search that group by keyword. */
  embedForProfile(
    query: string,
    profile: KnowledgeEmbeddingProfile,
    budgetMs?: number,
    localFilesOnly?: boolean,
  ): Promise<Float32Array | undefined>;
  /** A catalog's measured vector floor, or null when its hits are keyword-only. */
  vectorFloorFor(catalogKey: string, modality?: 'image' | 'video' | 'audio'): number | null;
  warn(message: string): void;
}

export type UnifiedSearchOptions = {
  vector: number[] | null;
  maxResults: number;
  projectId?: string;
  spatial?: KnowledgeRadius;
  catalogs?: readonly string[];
  /** Search a profile group keyword-only when its query model is not ready by then. */
  queryEmbedBudgetMs?: number;
  /** Query cached profile models only, falling back to keywords when absent. */
  localModelsOnly?: boolean;
  /**
   * Include media rows (images, audio and video windows) as results of
   * their own. Explicit search asks; proactive injection does not.
   */
  media?: boolean;
  /**
   * Also return up to this many of a document's other passages that the
   * search found, after its best one. Fusion otherwise keeps one passage
   * per document, chosen by vector similarity alone, so an article's name-
   * dense infobox can stand in for the section a reranker would choose.
   */
  chunksPerDocument?: number;
};

/** Explicit-search shard budget (S) across every active catalog (§3.4). */
const ROUTE_BUDGET_EXPLICIT = 6;
/**
 * Shards added beyond that budget for pages the query names by title (the
 * catalog host's title-assisted routing): the centroids alone left the ABBA
 * article unscanned for "Who were the members of ABBA?". Two, not one per
 * catalog, so twenty mounted catalogs cannot add twenty scans.
 */
const TITLE_ROUTE_EXPLICIT = 2;
const FINAL_K = 24;

/**
 * Explicit search fuses three arms per catalog by reciprocal rank (k = 60):
 * the vector chunks (best chunk per document, by rerank cosine), the
 * doc-title FTS hits, and the chunk-body FTS hits. Rank fusion instead of
 * score comparison because the arms' scores are not commensurable — e5
 * cosines sit in a narrow 0.7–0.9 band for everything, so a cosine-first
 * ordering buried an exact title match under any vaguely related passage
 * ("Who painted the Mona Lisa?" listed three other Mona Lisa copies above
 * the article whose title the question names). Two lexical arms agreeing
 * on a document now outrank one vector arm; a document every arm names
 * comes first.
 */
const RRF_K = 60;
const ARM_WEIGHTS = { vector: 1, docFts: 1, chunkFts: 0.5 } as const;
/**
 * Media rows fuse per row, not per document: a document's own text chunk
 * (cosine ≈ 0.9) would otherwise always stand in for its image (≈ 0.7). Each
 * modality is ranked on its own scale, past its own measured floor.
 */
const MEDIA_ARM_WEIGHTS = { vector: 0.5, chunkFts: 0.25 } as const;
/** Media rows asked of each catalog, per modality, on an explicit search. */
const MEDIA_K = 2;
/** Media results one search returns at most, and per document. */
const MEDIA_RESULT_CAP = 4;
const MEDIA_PER_DOCUMENT = 1;
/**
 * Fused documents per catalog when several are in scope: keeps one catalog
 * from monopolizing the merged list. A search scoped to one catalog has
 * nothing to share the list with, and the cap cut the Knowledge browser's
 * search for "blob" in an Azure-docs catalog — 348 matching titles — to six.
 */
const PER_CATALOG_CAP = 6;
/** Lexical candidates fetched per arm before fusion, at the least. */
const DOC_FTS_MIN = 6;
const CHUNK_FTS_MIN = 8;

/** Rank-anchored relevance for a fused knowledge result: the best hit is a strong 1.0, decaying RRF-style. */
function fusedRankRelevance(rank: number): number {
  return 11 / (11 + rank);
}

/**
 * The first prose paragraph of a document body, for a hit that no chunk
 * carries (a title-only match): the model gets something to read, not just
 * a summary line. Skips the title heading and a key-facts list.
 */
function leadExcerpt(markdown: string, max = 600): string {
  const body = markdown.replace(/^#\s[^\n]*\n+/, '');
  const paragraph =
    body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !part.startsWith('#') && !part.startsWith('- ')) ??
    body.trim();
  return paragraph.length > max ? `${paragraph.slice(0, max - 1)}…` : paragraph;
}

/** Which arm vouches for a fused knowledge hit — see the vector arm in `searchUnified`. */
export type KnowledgeEvidence = { arm: 'vector'; similarity: number } | { arm: 'fts' };

export async function searchUnifiedCatalogs(
  deps: UnifiedSearchDeps,
  active: readonly string[],
  query: string,
  opts: UnifiedSearchOptions,
): Promise<UnifiedSearchResult[]> {
  if (active.length === 0) return [];

  const groups: Array<{ keys: string[]; vector?: Float32Array }> = [];
  const shared: string[] = [];
  const keyword: string[] = [];
  const byProfile = new Map<string, { profile: KnowledgeEmbeddingProfile; keys: string[] }>();
  for (const key of active) {
    const info = deps.catalog(key);
    if (!info) continue;
    if (info.semanticSearch === 'shared' && !opts.localModelsOnly) shared.push(key);
    else if (info.semanticSearch === 'profile' || info.semanticSearch === 'shared') {
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
    const vector = await deps.embedForProfile(
      query,
      group.profile,
      opts.queryEmbedBudgetMs,
      opts.localModelsOnly,
    );
    groups.push({ keys: group.keys, ...(vector ? { vector } : {}) });
  }
  if (keyword.length > 0) groups.push({ keys: keyword });

  const response = {
    chunks: [] as GlobalSearchHit[],
    documents: [] as GlobalSearchDocumentHit[],
  };
  for (const group of groups) {
    const request = {
      query,
      shardBudget: ROUTE_BUDGET_EXPLICIT,
      titleRouteShards: TITLE_ROUTE_EXPLICIT,
      finalK: FINAL_K,
      includeChunkFts: true,
      catalogKeys: group.keys,
      // A pool no deeper than the page asked for: six title hits could
      // never fill a twenty-result browse search.
      docFtsLimit: Math.max(DOC_FTS_MIN, opts.maxResults),
      chunkFtsLimit: Math.max(CHUNK_FTS_MIN, opts.maxResults),
      spatial: opts.spatial,
    };
    let part: Awaited<ReturnType<KnowledgeCatalogHost['search']>>;
    try {
      part = await deps.host.search(
        group.vector
          ? { ...request, vector: group.vector, ...(opts.media ? { mediaK: MEDIA_K } : {}) }
          : request,
      );
    } catch (error) {
      // A catalog that refuses the query vector (a width the catalog does
      // not store, say) is an embedding failure, not a search failure: the
      // worker forwards only the message, so any vector-arm error falls
      // back to the keyword arms for this group.
      if (!group.vector) throw error;
      deps.warn(
        `[knowledge] semantic search failed for ${group.keys.join(', ')}; keyword-only: ${error instanceof Error ? error.message : String(error)}`,
      );
      part = await deps.host.search(request);
    }
    response.chunks.push(...part.chunks);
    response.documents.push(...part.documents);
  }

  // ── fuse the arms per document ──────────────────────────────────────
  const fused = new Map<
    string,
    {
      catalogKey: string;
      documentId: string;
      score: number;
      chunk?: GlobalSearchHit;
      /** Best vector cosine that cleared a MEASURED floor — what labels the hit `vector`. */
      similarity?: number;
    }
  >();
  const bump = (
    catalogKey: string,
    documentId: string,
    weight: number,
    rank: number,
    chunk?: GlobalSearchHit,
  ): void => {
    const key = `${catalogKey}\u0000${documentId}`;
    const entry = fused.get(key) ?? { catalogKey, documentId, score: 0 };
    entry.score += weight / (RRF_K + rank);
    // The document's representative chunk: its best vector chunk, else
    // whichever chunk-FTS row named it.
    if (chunk && (!entry.chunk || (chunk.cosine ?? -1) > (entry.chunk.cosine ?? -1))) {
      entry.chunk = chunk;
    }
    fused.set(key, entry);
  };

  // Every text passage the arms found, per document, best vector match first,
  // for `chunksPerDocument`. Fusion still ranks documents, not passages.
  const passagesByDocument = new Map<string, GlobalSearchHit[]>();
  if ((opts.chunksPerDocument ?? 1) > 1) {
    for (const hit of response.chunks
      .filter((h) => !h.media)
      .sort((a, b) => (b.cosine ?? -1) - (a.cosine ?? -1))) {
      const key = `${hit.catalogKey}\u0000${hit.documentId}`;
      const passages = passagesByDocument.get(key) ?? [];
      if (!passages.some((known) => known.chunkUid === hit.chunkUid)) passages.push(hit);
      passagesByDocument.set(key, passages);
    }
  }

  // Vector arm: one rank per document, in rerank-cosine order. A hit under
  // its profile's floor is not evidence at all — KNN always returns its
  // nearest rows, and a rank-0 row fuses to relevance 1.0 however far away
  // it is (see vector-floors.ts).
  const textChunks = response.chunks.filter((h) => !h.media);
  const mediaChunks = response.chunks.filter((h) => h.media);
  const seenVector = new Set<string>();
  let vectorRank = 0;
  for (const hit of textChunks
    .filter((h) => h.cosine !== undefined)
    .sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0))) {
    const key = `${hit.catalogKey}\u0000${hit.documentId}`;
    if (seenVector.has(key)) continue;
    const cosine = hit.cosine ?? 0;
    const floor = deps.vectorFloorFor(hit.catalogKey);
    if (floor !== null && cosine < floor) continue;
    seenVector.add(key);
    bump(hit.catalogKey, hit.documentId, ARM_WEIGHTS.vector, vectorRank++, hit);
    const entry = fused.get(key);
    if (entry && floor !== null && cosine > (entry.similarity ?? Number.NEGATIVE_INFINITY)) {
      entry.similarity = cosine;
    }
  }
  // Chunk-body FTS arm: BM25 order as the shards returned it, ranked per catalog.
  const chunkFtsRank = new Map<string, number>();
  const seenChunkFts = new Set<string>();
  for (const hit of textChunks.filter((h) => h.cosine === undefined)) {
    const key = `${hit.catalogKey}\u0000${hit.documentId}`;
    if (seenChunkFts.has(key)) continue;
    seenChunkFts.add(key);
    const rank = chunkFtsRank.get(hit.catalogKey) ?? 0;
    chunkFtsRank.set(hit.catalogKey, rank + 1);
    bump(hit.catalogKey, hit.documentId, ARM_WEIGHTS.chunkFts, rank, hit);
  }
  // Doc-title FTS arm: exact-name evidence, ranked per catalog by the host.
  for (const doc of response.documents) {
    bump(doc.catalogKey, doc.documentId, ARM_WEIGHTS.docFts, doc.rank);
  }

  // Media rows: their own vector arm per modality (a modality with no
  // measured floor gives no vector evidence — nearest-neighbour search
  // always returns some image, and a media row has no query words to be
  // grounded in) and a caption FTS arm.
  const mediaFused: typeof fused = new Map();
  const bumpMedia = (hit: GlobalSearchHit, weight: number, rank: number): void => {
    const key = `${hit.catalogKey}\u0000${hit.chunkUid}`;
    const entry = mediaFused.get(key) ?? {
      catalogKey: hit.catalogKey,
      documentId: hit.documentId,
      score: 0,
      chunk: hit,
    };
    entry.score += weight / (RRF_K + rank);
    if ((hit.cosine ?? -1) > (entry.chunk?.cosine ?? -1)) entry.chunk = hit;
    mediaFused.set(key, entry);
  };
  const mediaVectorRank = new Map<string, number>();
  for (const hit of mediaChunks
    .filter((h) => h.cosine !== undefined)
    .sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0))) {
    const modality = hit.media?.modality as 'image' | 'video' | 'audio';
    const floor = deps.vectorFloorFor(hit.catalogKey, modality);
    if (floor === null || (hit.cosine ?? 0) < floor) continue;
    const rank = mediaVectorRank.get(modality) ?? 0;
    mediaVectorRank.set(modality, rank + 1);
    bumpMedia(hit, MEDIA_ARM_WEIGHTS.vector, rank);
    const entry = mediaFused.get(`${hit.catalogKey}\u0000${hit.chunkUid}`);
    if (entry) entry.similarity = Math.max(entry.similarity ?? -1, hit.cosine ?? 0);
  }
  let mediaFtsRank = 0;
  for (const hit of mediaChunks.filter((h) => h.cosine === undefined)) {
    bumpMedia(hit, MEDIA_ARM_WEIGHTS.chunkFts, mediaFtsRank++);
  }

  const ordered = [...fused.values(), ...mediaFused.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (b.chunk?.cosine ?? -1) - (a.chunk?.cosine ?? -1) ||
      a.documentId.localeCompare(b.documentId),
  );
  const matches = new Map(
    [...response.documents, ...response.chunks]
      .filter((hit) => hit.matchedLocation)
      .map((hit) => [
        `${hit.catalogKey}\u0000${hit.documentId}`,
        { distanceMeters: hit.distanceMeters!, matchedLocation: hit.matchedLocation! },
      ]),
  );
  const seenSpatial = new Set<string>();
  const out: UnifiedSearchResult[] = [];
  const perCatalogCount = new Map<string, number>();
  const capPerCatalog = !opts.spatial && active.length > 1;
  const mediaPerDocument = new Map<string, number>();
  let mediaResults = 0;
  for (const entry of ordered) {
    const info = deps.catalog(entry.catalogKey);
    if (!info) continue;
    if (entry.chunk?.media) {
      const docKey = `${entry.catalogKey}\u0000${entry.documentId}`;
      const forDocument = mediaPerDocument.get(docKey) ?? 0;
      if (mediaResults >= MEDIA_RESULT_CAP || forDocument >= MEDIA_PER_DOCUMENT) continue;
      const evidence: KnowledgeEvidence =
        entry.similarity !== undefined
          ? { arm: 'vector', similarity: entry.similarity }
          : { arm: 'fts' };
      mediaPerDocument.set(docKey, forDocument + 1);
      mediaResults++;
      out.push(knowledgeChunkResult(info, entry.chunk, fusedRankRelevance(out.length), evidence));
      if (out.length >= Math.max(10, opts.maxResults)) break;
      continue;
    }
    const count = perCatalogCount.get(entry.catalogKey) ?? 0;
    if (capPerCatalog && count >= PER_CATALOG_CAP) continue;
    const spatialIdentity = spatialDocumentIdentity(
      info.ref.publisherId,
      info.ref.catalogId,
      entry.documentId,
    );
    if (opts.spatial && seenSpatial.has(spatialIdentity)) continue;
    const relevance = fusedRankRelevance(out.length);
    // `vector` only when the hit cleared a measured floor; everything else
    // is lexical evidence, which proactive injection asks to be grounded.
    const evidence: KnowledgeEvidence =
      entry.similarity !== undefined
        ? { arm: 'vector', similarity: entry.similarity }
        : { arm: 'fts' };
    const result = entry.chunk
      ? knowledgeChunkResult(info, entry.chunk, relevance, evidence)
      : await knowledgeDocumentResult(deps.host, info, entry.documentId, relevance, evidence);
    if (!result) continue;
    perCatalogCount.set(entry.catalogKey, count + 1);
    seenSpatial.add(spatialIdentity);
    const docKey = `${entry.catalogKey}\u0000${entry.documentId}`;
    out.push({ ...result, ...matches.get(docKey) });
    if (out.length >= Math.max(10, opts.maxResults)) break;
    // The document's other passages, each labelled by its own evidence: a
    // sibling is vector evidence only if it clears the floor by itself.
    const siblings = (passagesByDocument.get(docKey) ?? [])
      .filter((hit) => hit.chunkUid !== entry.chunk?.chunkUid)
      .slice(0, Math.max(0, (opts.chunksPerDocument ?? 1) - 1));
    const floor = deps.vectorFloorFor(entry.catalogKey);
    for (const sibling of siblings) {
      const own: KnowledgeEvidence =
        floor !== null && sibling.cosine !== undefined && sibling.cosine >= floor
          ? { arm: 'vector', similarity: sibling.cosine }
          : { arm: 'fts' };
      out.push(knowledgeChunkResult(info, sibling, fusedRankRelevance(out.length), own));
      if (out.length >= Math.max(10, opts.maxResults)) break;
    }
    if (out.length >= Math.max(10, opts.maxResults)) break;
  }
  return out;
}

/** A document the lexical arms named but no chunk carries: cite it with its lead paragraph. */
export async function knowledgeDocumentResult(
  host: Pick<KnowledgeCatalogHost, 'getDocument'>,
  info: UnifiedSearchCatalog,
  documentId: string,
  relevance: number,
  evidence: KnowledgeEvidence,
): Promise<UnifiedSearchResult | null> {
  const doc = await host.getDocument(info.key, documentId).catch(() => null);
  if (!doc) return null;
  const snippet = leadExcerpt(doc.markdown) || doc.summary || '';
  return {
    kind: 'knowledge',
    id: `knowledge:${info.ref.catalogId}:doc:${documentId}`,
    title: doc.title,
    subtitle: `${info.name} · ${info.topicNames.get(doc.topicId) ?? doc.topicId}`,
    ...(snippet ? { snippet } : {}),
    retrievalSource: 'knowledge',
    catalogId: info.ref.catalogId,
    catalogVersion: info.ref.version,
    documentId,
    topicPath: [info.topicNames.get(doc.topicId) ?? doc.topicId],
    uri: formatKnowledgeUri({
      publisherId: info.ref.publisherId,
      catalogId: info.ref.catalogId,
      documentId,
    }),
    ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}),
    ...evidence,
    ...scoreResult('knowledge', relevance),
  };
}

export function knowledgeChunkResult(
  info: UnifiedSearchCatalog,
  hit: GlobalSearchHit,
  relevance: number,
  evidence: KnowledgeEvidence,
): UnifiedSearchResult {
  return {
    kind: 'knowledge',
    id: `knowledge:${info.ref.catalogId}:${hit.chunkUid}`,
    title: hit.headingPath.length > 0 ? `${hit.title} › ${hit.headingPath.join(' › ')}` : hit.title,
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
    ...(hit.media ? { media: hit.media } : {}),
    ...evidence,
    ...scoreResult('knowledge', relevance),
  };
}
