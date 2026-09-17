/** Toolchain knobs. Format-level constants come from @bendyline/gezk. */

export {
  BODY_CODEC_MIN_BYTES,
  GEZK_APPLICATION_ID,
  GEZK_FORMAT_GENERATIONS,
  GEZK_FORMAT_VERSION,
  GEZK_INDEX_SCHEMA_VERSION,
  GEZK_MIME_TYPE,
  GEZK_SUPPORTED_FORMAT_VERSIONS,
  GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS,
  type GezkFormatVersion,
  type GezkIndexSchemaVersion,
  LICENSE_NOTICE_PATH,
  MANIFEST_PATH,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  MAX_KNOWLEDGE_DOCUMENT_META_BYTES,
  MAX_KNOWLEDGE_TOPIC_DEPTH,
  MIMETYPE_PATH,
  README_PATH,
  ROUTER_DB_PATH,
  SOURCE_NOTICES_PATH,
  ZIP_FIXED_MTIME,
  isSupportedFormatVersion,
  isSupportedIndexSchemaVersion,
} from '@bendyline/gezk';

/** Compiler shard sizing (§3.1). */
export const SHARD_TARGET_CHUNKS = 200_000;
export const SHARD_MAX_CHUNKS = 250_000;

/** Routing (§3.3–3.4). */
export const CENTROID_CHUNKS_PER = 12_500;
export const CENTROID_MAX_PER_SHARD = 32;
export const CENTROID_KMEANS_MAX_ITER = 25;
export const CENTROID_SAMPLE_MAX = 65_536;
export const ROUTE_SHARDS_PROACTIVE = 3;
export const ROUTE_SHARDS_EXPLICIT = 6;

/**
 * Two-stage retrieval (§2): stage-1 sign-bit scan → int8 rerank of K
 * candidates. K is deliberately generous. Measured on a 43,859-chunk
 * multilingual-e5-small catalog with natural-language questions, recall of
 * the exact top-24 among the stage-1 candidates was 22% at the former
 * K = 192 with raw sign bits, and with centered bits (`centered-sign`
 * profiles) 88% at 192, 97% at 512, 99% at 1,024 and 100% at 2,048 — while
 * reranking 1,024 int8 rows costs about 4 ms of SQLite point reads per
 * shard. A small K is a silent recall cliff; a large one is cheap.
 */
export const RERANK_FINAL_K = 24;
export const RERANK_CANDIDATES_MIN = 1024;
export const RERANK_CANDIDATES_MAX = 4096;
export function rerankK(finalK = RERANK_FINAL_K, chunkCount = Number.POSITIVE_INFINITY): number {
  return Math.min(RERANK_CANDIDATES_MAX, Math.max(RERANK_CANDIDATES_MIN, 32 * finalK), chunkCount);
}
