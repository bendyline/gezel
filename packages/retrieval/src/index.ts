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
  type LiveSearchHit,
  type LiveSearchOptions,
} from './live-index.js';
export { LIVE_CHUNK_FTS_WEIGHTS, LIVE_INDEX_SCHEMA } from './schema.js';
export type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from './sql.js';
