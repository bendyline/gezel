/**
 * Test-only builder for a tiny real `.gezk` archive: deterministic hash
 * embedder (identical text ⇒ identical vector), whitespace token counter.
 * Imported by knowledge tests in this package — never by runtime code.
 */

import { createHash } from 'node:crypto';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import { compileKnowledgeCatalog } from '@bendyline/gezel-knowledge';

export const TEST_EMBED_PROFILE: KnowledgeEmbeddingProfile = {
  id: 'test-hash-embed@1',
  model: { repo: 'test/hash-embed', revision: 'fixture' },
  tokenizer: { kind: 'whitespace' },
  pooling: 'mean',
  normalized: true,
  dimensions: 384,
  maxTokens: 512,
  queryInstruction: '',
  passageInstruction: '',
  vectorEncoding: 'bit+int8',
  distance: { stage1: 'hamming', stage2: 'cosine' },
  quantization: {
    int8: { method: 'symmetric-linear', scale: 127 },
    binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
  },
};

/** A 1×1 transparent PNG — the asset the rich fixture ships. */
export const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function testHashVector(text: string): number[] {
  const dims = 384;
  const out = new Array<number>(dims);
  let hash = createHash('sha256').update(text, 'utf8').digest();
  let offset = 0;
  for (let i = 0; i < dims; i++) {
    if (offset >= hash.length) {
      hash = createHash('sha256').update(hash).digest();
      offset = 0;
    }
    out[i] = ((hash.readInt8(offset) ?? 0) + 0.5) / 128;
    offset++;
  }
  return out;
}

export async function buildTestCatalog(opts: {
  outputPath: string;
  workDir: string;
  id?: string;
  version?: string;
  publisherId?: string;
  /** Embed with the hash embedder but DECLARE this profile (mode classification tests). */
  embeddingProfile?: KnowledgeEmbeddingProfile;
  /**
   * Also ship the 0.6 surface: a nested topic with its own document,
   * ordinals, metadata, and one PNG asset referenced from a body.
   */
  withExtras?: boolean;
}): Promise<void> {
  const extras = opts.withExtras ?? false;
  await compileKnowledgeCatalog({
    catalog: {
      id: opts.id ?? 'test-notes',
      version: opts.version ?? '1.0.0',
      name: 'Test Notes',
      description: 'Service test fixture catalog.',
      language: 'en',
      publisher: { id: opts.publisherId ?? 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: [
      { id: 'joinery', name: 'Joinery', sortKey: '00' },
      { id: 'finishing', name: 'Finishing', sortKey: '01' },
      ...(extras
        ? [{ id: 'joinery-variants', name: 'Variants', parentId: 'joinery', sortKey: '00-00' }]
        : []),
    ],
    documents: (async function* () {
      yield {
        id: 'dovetails',
        title: 'Dovetail Joints',
        slug: 'dovetails',
        summary: 'Interlocking corner joinery.',
        language: 'en',
        topicPath: ['joinery'],
        markdown: `# Dovetail Joints\n\nTails and pins interlock to form a strong corner joint that resists pulling forces.\n${extras ? '\n![mark](assets/mark.png)\n' : ''}`,
        sourceUrl: 'https://example.test/dovetails',
        ...(extras ? { ordinal: 2, meta: { area: 'joinery', order: 2 } } : {}),
      };
      if (extras) {
        yield {
          id: 'half-blind',
          title: 'Half-blind Dovetails',
          slug: 'half-blind',
          summary: 'Dovetails hidden from the front.',
          language: 'en',
          topicPath: ['joinery', 'joinery-variants'],
          markdown: '# Half-blind Dovetails\n\nThe tails stop short of the show face.\n',
          ordinal: 1,
        };
      }
      yield {
        id: 'shellac',
        title: 'Shellac',
        slug: 'shellac',
        summary: 'A natural resin finish.',
        language: 'en',
        topicPath: ['finishing'],
        markdown: '# Shellac\n\nShellac dries fast and is easily repaired with alcohol.\n',
      };
    })(),
    outputPath: opts.outputPath,
    embeddingProfile: opts.embeddingProfile ?? TEST_EMBED_PROFILE,
    chunkingProfile: {
      id: 'markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      target: 420,
      overlap: 64,
      contextHeader: { max: 64 },
    },
    embed: async (texts) => texts.map(testHashVector),
    countTokens: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
    workDir: opts.workDir,
    ...(extras ? { assets: [{ path: 'assets/mark.png', content: TEST_PNG }] } : {}),
  });
}
