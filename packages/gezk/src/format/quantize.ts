/**
 * Frozen quantization formulas (the gezk spec §6.2). Deliberately computed
 * here in TypeScript rather than via sqlite-vec's `vec_quantize_*` scalar
 * functions, so extension-internal semantics can never drift the format:
 * both the compiler (packing) and the reader (query packing + rerank) call
 * exactly these functions.
 *
 * `quantizeBinary` is the raw sign packing. What a catalog actually stores
 * depends on the profile's `quantization.binary.method`: `sign` packs the
 * unit vector, `centered-sign` packs `vector − center` (see the profile
 * schema for why). `quantizeBinaryForProfile` is the one entry point that
 * applies that rule, so the compiler and every reader derive bits the same
 * way.
 */

import { type KnowledgeEmbeddingProfile, embeddingProfileCenter } from '../schemas/profiles.js';

/** int8: symmetric linear, scale 127, −128 never produced. */
export function quantizeInt8(unitVector: ArrayLike<number>): Int8Array {
  const out = new Int8Array(unitVector.length);
  for (let i = 0; i < unitVector.length; i++) {
    const q = Math.round((unitVector[i] as number) * 127);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}

/** `vector − center`, the input to a `centered-sign` profile's bits. */
export function centerVector(vector: ArrayLike<number>, center: ArrayLike<number>): Float32Array {
  if (vector.length !== center.length) {
    throw new Error(`vector has ${vector.length} dimensions, center has ${center.length}`);
  }
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) - (center[i] as number);
  return out;
}

/**
 * The sign bits a profile stores for a unit vector — and, symmetrically,
 * the bits a hamming reader packs for a query: centered first when the
 * profile pins a center, raw otherwise.
 */
export function quantizeBinaryForProfile(
  profile: KnowledgeEmbeddingProfile,
  unitVector: ArrayLike<number>,
): Uint8Array {
  const center = embeddingProfileCenter(profile);
  return quantizeBinary(center ? centerVector(unitVector, center) : unitVector);
}

/** binary: sign threshold 0 (exact 0.0 → 0), packed LSB-first. */
export function quantizeBinary(unitVector: ArrayLike<number>): Uint8Array {
  const bytes = Math.ceil(unitVector.length / 8);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < unitVector.length; i++) {
    if ((unitVector[i] as number) > 0) {
      out[i >> 3] = (out[i >> 3] as number) | (1 << (i & 7));
    }
  }
  return out;
}

/**
 * Rerank score: dot(float32 unit query, dequantized int8 passage). Passages
 * were unit vectors, so this approximates cosine; the query is not quantized.
 */
export function rerankScore(query: ArrayLike<number>, passageInt8: Int8Array): number {
  let dot = 0;
  const n = Math.min(query.length, passageInt8.length);
  for (let i = 0; i < n; i++) dot += (query[i] as number) * ((passageInt8[i] as number) / 127);
  return dot;
}

/** L2-normalize in place-free fashion; throws on a degenerate vector. */
export function l2Normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i] as number;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('degenerate vector (zero norm)');
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
  return out;
}
