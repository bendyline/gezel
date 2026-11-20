/**
 * `@bendyline/gezel-retrieval`: a mutable retrieval index for documents an
 * app owns, sharing the knowledge catalogs' chunking and FTS semantics.
 * Browser-safe: it runs in a Web Worker or a mobile WebView as well as in
 * Node, over whatever synchronous SQLite handle the host supplies.
 */
export {
  type LiveChunking,
  markdownChunksByCharacters,
  markdownChunksByTokens,
} from './chunks.js';
export {
  type LiveDocument,
  type LiveDocumentInput,
  LiveIndex,
  type LiveIndexOptions,
  type LiveIndexReset,
  type LiveIndexStats,
  type LiveManifestEntry,
  type LiveEmbeddingStats,
  type LivePendingEmbedding,
  type LiveSearchHit,
  type LiveSearchOptions,
  type LiveSemanticOptions,
} from './live-index.js';
export { LIVE_CHUNK_FTS_WEIGHTS, LIVE_INDEX_SCHEMA } from './schema.js';
export {
  LIVE_HYBRID_WEIGHTS,
  LIVE_RRF_K,
  type LiveEmbedding,
  liveIndexEmbedding,
} from './vectors.js';
export type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from './sql.js';
/** The registered embedding profiles a live index can store vectors for. */
export {
  BGE_SMALL_EN_V15_1,
  KNOWLEDGE_EMBEDDING_PROFILES,
  MULTILINGUAL_E5_SMALL_2,
} from '@bendyline/gezel-knowledge/browser';
export type { KnowledgeEmbeddingProfile } from '@bendyline/gezk';
