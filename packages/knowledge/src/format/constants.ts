/** Toolchain knobs. Format-level constants come from @bendyline/gezk. */

export {
  BODY_CODEC_MIN_BYTES,
  GEZK_APPLICATION_ID,
  GEZK_FORMAT_VERSION,
  GEZK_INDEX_SCHEMA_VERSION,
  GEZK_MIME_TYPE,
  LICENSE_NOTICE_PATH,
  MANIFEST_PATH,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  MIMETYPE_PATH,
  README_PATH,
  ROUTER_DB_PATH,
  SOURCE_NOTICES_PATH,
  ZIP_FIXED_MTIME,
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

/** Two-stage retrieval (§2): hamming top-K → int8 rerank. */
export const RERANK_FINAL_K = 24;
export function rerankK(finalK = RERANK_FINAL_K, chunkCount = Number.POSITIVE_INFINITY): number {
  return Math.min(512, Math.max(128, 8 * finalK), chunkCount);
}
