export {
  IndexStore,
  type FileRecord,
  type SymbolInput,
  type SymbolHit,
  type ChunkInput,
  type DocHit,
  type VectorHit,
  type Modality,
  type CollectionKind,
  type OpenOptions,
} from './index-store.js';
export {
  type SqliteDriver,
  type SqliteStatement,
  openIndexDatabase,
  vectorToBlob,
} from './sqlite-driver.js';
export { applySchema, TEXT_EMBED_DIM } from './schema.js';
export { ensureIndexGitignore } from './gitignore.js';
export { classifyFile, type FileClass, MAX_INDEXABLE_BYTES } from './classify.js';
export { sha256 } from './hash.js';
export {
  extractCodeSymbols,
  extractMarkdownOutline,
  isCodeLangSupported,
} from './symbols.js';
export {
  indexWorkspaceContent,
  runWorkspaceContentIndex,
  type ContentIndexStats,
} from './content-indexer.js';
export { ContentIndex } from './content-index.js';
export { ARCHITECTURE_KEY, runAreaPass, type AreaPassResult } from './area-pass.js';
export {
  GlobalIndex,
  openGlobalCollection,
  type GlobalCollectionId,
  type SessionSearchHit,
  type DocumentSearchHit,
  type GlobalIndexStatus,
} from './global-index.js';
export {
  GlobalIndexManager,
  chunkTranscript,
  type DocumentChangeEvent,
} from './global-index-manager.js';
export { IndexEnrichmentManager } from './enrichment-manager.js';
export { enrichFile, buildSummaryPrompt, type EnrichDeps, type EnrichResult } from './enrich.js';
export {
  convertDocToMarkdown,
  isConvertibleDoc,
  docFilesPaths,
  writeConvertedMarkdown,
  chunkMarkdown,
} from './docs.js';
