import {
  KNOWLEDGE_VECTOR_FLOORS,
  MARKDOWN_CHUNKS_2,
  passageEmbedInput,
} from '@bendyline/gezel-knowledge/browser';
import {
  type KnowledgeEmbeddingProfile,
  centerVector,
  embeddingProfileCenter,
  profileUnitVector,
  quantizeBinaryForProfile,
  quantizeInt8,
  rerankScore,
} from '@bendyline/gezk';
import { type LiveChunking, markdownChunksByTokens } from './chunks.js';

/**
 * The embedding profile a live index stores vectors for, and its tokenizer.
 * Passages embed exactly as they would in a knowledge catalog built with the
 * same profile, so the profile's measured floor applies to both.
 */
export interface LiveEmbedding {
  readonly profile: KnowledgeEmbeddingProfile;
  /** The profile's tokenizer: context headers are budgeted with it. */
  readonly countTokens: (text: string) => number;
}

/**
 * The chunking and embedding a live index needs for `profile`: the catalogs'
 * `markdown-chunks@2`, counted with the profile's own tokenizer.
 */
export function liveIndexEmbedding(
  profile: KnowledgeEmbeddingProfile,
  countTokens: (text: string) => number,
): { readonly chunking: LiveChunking; readonly embedding: LiveEmbedding } {
  return {
    chunking: markdownChunksByTokens(countTokens, profile.id),
    embedding: { profile, countTokens },
  };
}

/** The exact text the embedder sees for one chunk. */
export function embedInputFor(
  embedding: LiveEmbedding,
  title: string,
  headingPath: readonly string[],
  text: string,
): string {
  return passageEmbedInput({
    passageInstruction: embedding.profile.passageInstruction,
    title,
    headingPath,
    text,
    headerMaxTokens: MARKDOWN_CHUNKS_2.contextHeader.max,
    countTokens: embedding.countTokens,
  });
}

/** A raw embedding as stored: sign bits and int8 of its unit vector. */
export function quantizeEmbedding(
  profile: KnowledgeEmbeddingProfile,
  vector: ArrayLike<number>,
): { readonly bits: Uint8Array; readonly int8: Uint8Array } {
  const unit = profileUnitVector(profile, vector);
  const int8 = quantizeInt8(unit);
  return {
    bits: quantizeBinaryForProfile(profile, unit),
    int8: new Uint8Array(int8.buffer, int8.byteOffset, int8.byteLength),
  };
}

/** A query embedding prepared for the scan: its unit vector, and what the sign bits are scored against. */
export function prepareQuery(
  profile: KnowledgeEmbeddingProfile,
  vector: ArrayLike<number>,
): { readonly unit: Float32Array; readonly scan: Float32Array } {
  const unit = profileUnitVector(profile, vector);
  const center = embeddingProfileCenter(profile);
  return { unit, scan: center ? centerVector(unit, center) : unit };
}

/** Approximate cosine of a unit query and a stored int8 passage. */
export function similarity(unit: Float32Array, int8: Uint8Array): number {
  return rerankScore(unit, new Int8Array(int8.buffer, int8.byteOffset, int8.byteLength));
}

/**
 * The profile's measured cosine floor, or null when it was never measured
 * (its hits then rank, but do not count as vector evidence).
 */
export function measuredFloor(profile: KnowledgeEmbeddingProfile): number | null {
  return KNOWLEDGE_VECTOR_FLOORS[profile.id] ?? null;
}

/** The start of a passage, cut at a word, for a hit no query word highlights. */
export function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.lastIndexOf(' ', max);
  return `${flat.slice(0, cut > max / 2 ? cut : max)}…`;
}

/** Reciprocal-rank fusion constant, as the catalogs' unified search uses. */
export const LIVE_RRF_K = 60;

/**
 * Arm weights for hybrid search. Equal: in a person's own notes the exact
 * word they remember is as telling as a passage about the same thing.
 */
export const LIVE_HYBRID_WEIGHTS = { lexical: 1, vector: 1 } as const;
