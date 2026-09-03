/**
 * @bendyline/gezel-knowledge — the `.gezk` knowledge-catalog toolchain:
 * compiler, deterministic archive writer, streaming verified reader/extractor,
 * read-only catalog handle with two-stage retrieval. The format itself lives
 * in @bendyline/gezk; its spec in github.com/bendyline/gezk.
 *
 * This package never imports @bendyline/gezel or @bendyline/gezel-service —
 * the format contract comes from @bendyline/gezk.
 */

export * from './format/constants.js';
export * from './format/ddl.js';
export * from './format/ids.js';
export * from './format/quantize.js';
export * from './chunking/markdown-chunker.js';
export * from './compiler/compile.js';
export * from './archive/write.js';
export * from './archive/read.js';
export * from './reader/open.js';
export * from './reader/catalog-handle.js';
export * from './reader/validate.js';
export * from './reader/bit-scan.js';
export * from './toolchain.js';
export * from './export/duckdb.js';
export * from './export/parquet.js';
export * from './profiles/registry.js';
export * from './embedding/profile-embedder.js';
export * from './embedding/artifact-verify.js';
export * from './markdown-adapter/load.js';
export * from './registry-client/fetch.js';
export * from './signatures/anchors.js';
export * from './signatures/jcs.js';
export * from './signatures/signing.js';

// The wire/disk contract types, re-exported so external consumers (the
// publishing pipeline) get the whole toolchain surface from ONE package
// instead of also depending on @bendyline/gezk for the schemas.
export type {
  CatalogDocument,
  KnowledgeCatalogManifest,
  KnowledgeChunkingProfile,
  KnowledgeEmbeddingProfile,
  KnowledgeRegistryEntry,
  KnowledgeRegistryIndex,
} from '@bendyline/gezk';
