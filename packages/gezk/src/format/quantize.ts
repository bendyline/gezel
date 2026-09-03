/**
 * Frozen quantization formulas (the gezk spec §6.2). Deliberately computed
 * here in TypeScript rather than via sqlite-vec's `vec_quantize_*` scalar
 * functions, so extension-internal semantics can never drift the format:
 * both the compiler (packing) and the reader (query packing + rerank) call
 * exactly these functions.
 */

/** int8: symmetric linear, scale 127, −128 never produced. */
export function quantizeInt8(unitVector: ArrayLike<number>): Int8Array {
  const out = new Int8Array(unitVector.length);
  for (let i = 0; i < unitVector.length; i++) {
    const q = Math.round((unitVector[i] as number) * 127);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
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
