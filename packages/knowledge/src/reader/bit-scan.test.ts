/**
 * The two stage-1 scans over one bit index: `asymmetricTopK` must score
 * exactly like the brute-force definition, select deterministically, and —
 * the reason it exists — keep far more of the true neighbours than a
 * hamming scan does on anisotropic embeddings once the bits are centered.
 *
 * The anisotropy fixture reproduces what multilingual-e5-small actually
 * looks like (a corpus mean of norm ≈ 0.87, unrelated passages at cosine
 * ≈ 0.8) with a seeded generator, so the recall claim in constants.ts and
 * the profile registry is checked here without a model or a catalog.
 */

import {
  centerVector,
  l2Normalize,
  quantizeBinary,
  quantizeInt8,
  rerankScore,
} from '@bendyline/gezk';
import { describe, expect, it } from 'vitest';
import { type ShardBitIndex, asymmetricTopK, hammingTopK } from './bit-scan.js';

const DIM = 384;
const BYTES_PER_ROW = DIM / 8;

/** xorshift32 in [0, 1). */
function makePrng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Standard normal via Box–Muller over the seeded uniform. */
function makeGaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function packIndex(rows: Uint8Array[]): ShardBitIndex {
  const bits = new Uint8Array(rows.length * BYTES_PER_ROW);
  rows.forEach((row, i) => bits.set(row, i * BYTES_PER_ROW));
  return { bits, bytesPerRow: BYTES_PER_ROW, rows: rows.length };
}

/** Brute-force definition of the asymmetric score for one packed row. */
function asymmetricScore(row: Uint8Array, query: ArrayLike<number>): number {
  let s = 0;
  for (let d = 0; d < query.length; d++) {
    const bit = ((row[d >> 3] as number) >> (d & 7)) & 1;
    s += bit ? (query[d] as number) : -(query[d] as number);
  }
  return s;
}

describe('asymmetricTopK', () => {
  const rand = makePrng(7);
  const rows: Uint8Array[] = [];
  for (let r = 0; r < 500; r++) {
    const row = new Uint8Array(BYTES_PER_ROW);
    for (let b = 0; b < BYTES_PER_ROW; b++) row[b] = Math.floor(rand() * 256);
    rows.push(row);
  }
  const index = packIndex(rows);
  const query = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) query[d] = rand() - 0.5;

  it('scores every row exactly as the definition and returns them in descending order', () => {
    const hits = asymmetricTopK(index, query, rows.length);
    expect(hits.length).toBe(rows.length);
    for (const hit of hits) {
      expect(hit.score).toBeCloseTo(asymmetricScore(rows[hit.chunkId - 1] as Uint8Array, query), 4);
    }
    for (let i = 1; i < hits.length; i++) {
      expect((hits[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
        (hits[i] as { score: number }).score,
      );
    }
    // The top-K prefix is the same set whatever K is.
    const top10 = asymmetricTopK(index, query, 10).map((h) => h.chunkId);
    expect(top10).toEqual(hits.slice(0, 10).map((h) => h.chunkId));
  });

  it('breaks ties toward the lower chunk id, whichever order the rows arrive in', () => {
    const duplicate = packIndex([
      rows[3] as Uint8Array,
      rows[3] as Uint8Array,
      rows[3] as Uint8Array,
    ]);
    const hits = asymmetricTopK(duplicate, query, 2);
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2]);
    expect(hits[0]?.score).toBe(hits[1]?.score);
  });

  it('caps K at the row count and refuses a query of another dimension', () => {
    expect(asymmetricTopK(index, query, 10_000).length).toBe(rows.length);
    expect(asymmetricTopK(index, query, 0)).toEqual([]);
    expect(() => asymmetricTopK(index, new Float32Array(DIM + 8), 5)).toThrow(/dimensions/);
  });
});

describe('stage-1 recall on anisotropic embeddings', () => {
  // A corpus shaped like multilingual-e5-small's: every vector shares one
  // dominant direction (|mean| ≈ 0.86, unrelated rows at cosine ≈ 0.7), and
  // the passage-specific part is a topic direction plus noise. Queries are
  // drawn the same way, so their true neighbours are the rows of their
  // topic. The candidate pool is 0.48% of the corpus, the ratio the shipped
  // reader had on the 43,859-chunk arts pilot (192 of 43,859), where the
  // measured recall of the exact top-24 was 22% raw hamming, 39% raw
  // asymmetric, 73% centered hamming and 89% centered asymmetric. This
  // fixture lands at 28 / 48 / 68 / 90 with the seed below.
  const ROWS = 20_000;
  const TOPICS = 500;
  const FINAL_K = 24;
  const K = 96;
  const rand = makePrng(2026);
  const gauss = makeGaussian(rand);
  const unit = (draw: () => number): Float32Array =>
    l2Normalize(Float32Array.from({ length: DIM }, draw));
  const shared = unit(gauss);
  const topics: Float32Array[] = [];
  for (let t = 0; t < TOPICS; t++) topics.push(Float32Array.from({ length: DIM }, () => gauss()));
  const sample = (topic: number): Float32Array => {
    const direction = topics[topic % TOPICS] as Float32Array;
    const v = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) {
      v[d] =
        0.85 * (shared[d] as number) +
        (0.25 * (direction[d] as number) + 0.45 * gauss()) / Math.sqrt(DIM);
    }
    return l2Normalize(v);
  };
  const vectors: Float32Array[] = [];
  for (let r = 0; r < ROWS; r++) vectors.push(sample(r));
  const int8 = vectors.map((v) => quantizeInt8(v));
  const center = new Float32Array(DIM);
  for (const v of vectors) {
    for (let d = 0; d < DIM; d++) center[d] = (center[d] as number) + (v[d] as number) / ROWS;
  }
  const rawIndex = packIndex(vectors.map((v) => quantizeBinary(v)));
  const centeredIndex = packIndex(vectors.map((v) => quantizeBinary(centerVector(v, center))));
  const queries: Float32Array[] = [];
  for (let q = 0; q < 10; q++) queries.push(sample(q * 13));

  const recall = (candidates: (query: Float32Array) => number[]): number => {
    let kept = 0;
    for (const query of queries) {
      const exact = int8
        .map((v, i) => ({ i, cos: rerankScore(query, v) }))
        .sort((a, b) => b.cos - a.cos)
        .slice(0, FINAL_K)
        .map((e) => e.i + 1);
      const found = new Set(candidates(query));
      kept += exact.filter((id) => found.has(id)).length / FINAL_K;
    }
    return kept / queries.length;
  };

  it('the fixture is anisotropic the way the real model is', () => {
    const norm = Math.sqrt(Array.from(center).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.8);
    expect(norm).toBeLessThan(0.95);
    expect(rerankScore(vectors[0] as Float32Array, int8[7] as Int8Array)).toBeGreaterThan(0.6);
  });

  it('centered asymmetric keeps the exact top-24; raw hamming loses most of it', () => {
    const rawHamming = recall((q) =>
      hammingTopK(rawIndex, quantizeBinary(q), K).map((h) => h.chunkId),
    );
    const centeredHamming = recall((q) =>
      hammingTopK(centeredIndex, quantizeBinary(centerVector(q, center)), K).map((h) => h.chunkId),
    );
    const centeredAsymmetric = recall((q) =>
      asymmetricTopK(centeredIndex, centerVector(q, center), K).map((h) => h.chunkId),
    );
    expect(centeredAsymmetric).toBeGreaterThan(0.8);
    // Each step is worth having on its own: centering, then the asymmetric scan.
    expect(centeredHamming).toBeGreaterThan(rawHamming + 0.25);
    expect(centeredAsymmetric).toBeGreaterThan(centeredHamming + 0.1);
    expect(rawHamming).toBeLessThan(centeredAsymmetric - 0.4);
  });
});
