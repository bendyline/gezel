import * as gezk from '@bendyline/gezk';
import { describe, expect, it } from 'vitest';
import * as core from './knowledge.js';

/**
 * Names the format package exports that product code is expected to import
 * from @bendyline/gezk directly: toolchain-level pieces (DDL, quantization,
 * canonical JSON, slugs, container constants only a writer needs).
 */
const TOOLCHAIN_ONLY = new Set([
  'ROUTER_DDL',
  'SHARD_DDL',
  'quantizeInt8',
  'quantizeBinary',
  'rerankScore',
  'l2Normalize',
  'canonicalizeJson',
  'documentSlug',
  'BODY_CODEC_MIN_BYTES',
  'MAX_KNOWLEDGE_DOCUMENT_BYTES',
  'MAX_KNOWLEDGE_DOCUMENT_META_BYTES',
  'MAX_KNOWLEDGE_TOPIC_DEPTH',
  'MAX_KNOWLEDGE_ASSET_BYTES',
  'MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES',
  'MAX_KNOWLEDGE_ASSET_COUNT',
  'MAX_KNOWLEDGE_ASSET_PATH_LENGTH',
  'sniffAssetType',
  'svgInertnessProblem',
  'ZIP_FIXED_MTIME',
]);

describe('core forwards the gezk format surface', () => {
  it('re-exports every runtime name of @bendyline/gezk except the toolchain-only ones', () => {
    const missing = Object.keys(gezk).filter(
      (name) => !TOOLCHAIN_ONLY.has(name) && !(name in core),
    );
    expect(missing).toEqual([]);
  });

  it('forwards live bindings, not undefined placeholders', () => {
    expect(typeof core.parseKnowledgeUri).toBe('function');
    expect(typeof core.KnowledgeCatalogManifestSchema.safeParse).toBe('function');
    expect(core.GEZK_FORMAT_VERSION).toBe('0.6');
  });
});
