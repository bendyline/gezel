/**
 * @bendyline/gezel-knowledge — the `.gezk` knowledge-catalog toolchain:
 * compiler, deterministic archive writer, streaming verified reader/extractor,
 * read-only catalog handle with two-stage retrieval, and the frozen format
 * constants. Format spec: docs/gezk-format-v1.md in the gezel repo.
 *
 * This package never imports @bendyline/gezel-service — only core schemas.
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
export * from './profiles/registry.js';
export * from './embedding/profile-embedder.js';
export * from './markdown-adapter/load.js';
export * from './signatures/jcs.js';
export * from './signatures/signing.js';
