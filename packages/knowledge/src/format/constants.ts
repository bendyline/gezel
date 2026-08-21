/** `.gezk` v1 constants — frozen in docs/gezk-format-v1.md. */

export const GEZK_FORMAT_VERSION = 1;
export const GEZK_INDEX_SCHEMA_VERSION = 1;

/** `PRAGMA application_id` for every database in a catalog: 'GEZK'. */
export const GEZK_APPLICATION_ID = 0x47455a4b;

export const ROUTER_DB_PATH = 'index/router.db';
export const MANIFEST_PATH = 'manifest.json';

/** Compiler shard sizing (§3.1). */
export const SHARD_TARGET_CHUNKS = 200_000;
export const SHARD_MAX_CHUNKS = 250_000;

/** Bodies below this ship uncompressed (`body_codec = 'none'`). */
export const BODY_CODEC_MIN_BYTES = 512;
/** Maximum decompressed Markdown body returned from one catalog document. */
export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 16 * 1024 * 1024;

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

/** Fixed ZIP entry timestamp for deterministic archives (§11). */
export const ZIP_FIXED_MTIME = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
