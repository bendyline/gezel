/**
 * Seeded synthetic corpus generator for format tests — committed as a
 * GENERATOR, never as a binary fixture. Deterministic across platforms:
 * xorshift PRNG, fixed vocabulary, no wall-clock. The fake embedder derives
 * a unit vector from the text's SHA-256 (identical text ⇒ identical vector
 * on every machine), which is exactly what the determinism and self-KNN
 * exit tests need; retrieval-quality testing uses the real embedder later.
 */

import { createHash } from 'node:crypto';
import type { CatalogDocument, KnowledgeEmbeddingProfile } from '@bendyline/gezk';
import type { KnowledgeChunkingProfile } from '@bendyline/gezk';
import type { CompileAsset, CompileTopic } from '../compiler/compile.js';

const VOCAB = (
  'lattice harbor quill ember cascade meridian tundra copper sonata drift glacier ' +
  'anvil marrow tide beacon cinder fable garnet hollow ingot jasper kestrel lumen ' +
  'mantle nectar orchard pumice quarry russet saffron talon umber vellum wicker'
).split(' ');

function makePrng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export const FIXTURE_TOPICS: CompileTopic[] = [
  { id: 'craft', name: 'Craft', sortKey: '00-craft' },
  { id: 'nature', name: 'Nature', parentId: undefined, sortKey: '01-nature' },
  { id: 'metals', name: 'Metals', parentId: 'craft', sortKey: '00-craft/00-metals' },
];

/** A 1×1 transparent PNG (70 bytes) — the conformance kit's one asset. */
export const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
export const FIXTURE_ASSET_PATH = 'assets/mark.png';
export const FIXTURE_ASSETS: CompileAsset[] = [{ path: FIXTURE_ASSET_PATH, content: FIXTURE_PNG }];
/** The document whose body references the asset. */
export const FIXTURE_ASSET_DOCUMENT_ID = 'doc-0001';
/** Every fifth document carries an ordinal, every seventh a meta object. */
export function fixtureOrdinal(i: number): number | undefined {
  return i % 5 === 0 ? 1000 - i : undefined;
}
export function fixtureMeta(i: number): Record<string, unknown> | undefined {
  return i % 7 === 0 ? { tags: ['fixture', i % 2 ? 'odd' : 'even'], generatedIndex: i } : undefined;
}

export function generateFixtureCorpus(count = 1000, seed = 42): CatalogDocument[] {
  const rand = makePrng(seed);
  const word = () => VOCAB[Math.floor(rand() * VOCAB.length)] as string;
  const sentence = () => {
    const n = 6 + Math.floor(rand() * 10);
    const words = Array.from({ length: n }, word);
    return `${(words[0] as string)[0]?.toUpperCase()}${(words[0] as string).slice(1)} ${words.slice(1).join(' ')}.`;
  };
  const docs: CatalogDocument[] = [];
  for (let i = 0; i < count; i++) {
    const topic = FIXTURE_TOPICS[i % FIXTURE_TOPICS.length] as CompileTopic;
    const title = `${word()} ${word()} ${String(i).padStart(4, '0')}`;
    const sections = 2 + Math.floor(rand() * 3);
    let markdown = `${sentence()}\n\n`;
    for (let s = 0; s < sections; s++) {
      markdown += `## Section ${s + 1} ${word()}\n\n`;
      const paras = 1 + Math.floor(rand() * 3);
      for (let p = 0; p < paras; p++) {
        markdown += `${Array.from({ length: 3 + Math.floor(rand() * 4) }, sentence).join(' ')}\n\n`;
      }
    }
    const id = `doc-${String(i).padStart(4, '0')}`;
    if (id === FIXTURE_ASSET_DOCUMENT_ID) markdown += `![mark](${FIXTURE_ASSET_PATH})\n`;
    const ordinal = fixtureOrdinal(i);
    const meta = fixtureMeta(i);
    docs.push({
      id,
      title,
      slug: id,
      summary: sentence(),
      language: 'en',
      topicPath: topic.parentId ? [topic.parentId, topic.id] : [topic.id],
      markdown,
      sourceUrl: `https://example.test/${i}`,
      aliases: i % 7 === 0 ? [`alias-${i}`] : [],
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(meta ? { meta } : {}),
    });
  }
  return docs;
}

/** Deterministic hash-based unit-vector embedder (fixture/profile dim 384). */
export async function fakeEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    const dims = 384;
    const out = new Array<number>(dims);
    let hash = createHash('sha256').update(text, 'utf8').digest();
    let offset = 0;
    for (let i = 0; i < dims; i++) {
      if (offset >= hash.length) {
        hash = createHash('sha256').update(hash).digest();
        offset = 0;
      }
      // Signed byte → [-1, 1); normalized below by the compiler.
      out[i] = (hash.readInt8(offset) + 0.5) / 128;
      offset++;
    }
    return out;
  });
}

/** Deterministic whitespace token counter for fixture chunking. */
export function fakeCountTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** The conformance profile: a hash embedder anyone can reimplement. */
export const FIXTURE_EMBEDDING_PROFILE: KnowledgeEmbeddingProfile = {
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

export const FIXTURE_CHUNKING_PROFILE: KnowledgeChunkingProfile = {
  id: 'markdown-chunks@2',
  unit: 'tokens',
  tokenizer: 'profile',
  target: 420,
  overlap: 64,
  contextHeader: { max: 64 },
};
