/**
 * Stage-1 retrieval over a shard's sign-bit vectors, in memory. A full
 * 200k-chunk shard is 9.6 MB of bits; one linear hamming pass with a SWAR
 * popcount plus a histogram selection of the top-K is a few milliseconds and
 * needs nothing beyond plain SQLite to load — which is what lets any reader
 * implement the format without a vector extension.
 */

export interface ShardBitIndex {
  /** Row-major sign-bit rows, `bytesPerRow` each; row i holds chunk_id i + 1. */
  bits: Uint8Array;
  bytesPerRow: number;
  rows: number;
}

export interface HammingHit {
  chunkId: number;
  distance: number;
}

const POPCOUNT8 = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT8[i] = (i & 1) + (POPCOUNT8[i >> 1] as number);

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Hamming distance of every row against `query`, into `out`. */
function hammingAll(index: ShardBitIndex, query: Uint8Array, out: Uint16Array): void {
  const { bits, bytesPerRow, rows } = index;
  if (bytesPerRow % 4 === 0 && bits.byteOffset % 4 === 0) {
    const perRow = bytesPerRow / 4;
    const words = new Uint32Array(bits.buffer, bits.byteOffset, rows * perRow);
    const aligned = new Uint8Array(bytesPerRow);
    aligned.set(query);
    const qwords = new Uint32Array(aligned.buffer, 0, perRow);
    let offset = 0;
    for (let r = 0; r < rows; r++) {
      let d = 0;
      for (let w = 0; w < perRow; w++) {
        d += popcount32(((words[offset + w] as number) ^ (qwords[w] as number)) >>> 0);
      }
      out[r] = d;
      offset += perRow;
    }
    return;
  }
  let offset = 0;
  for (let r = 0; r < rows; r++) {
    let d = 0;
    for (let b = 0; b < bytesPerRow; b++) {
      d += POPCOUNT8[(bits[offset + b] as number) ^ (query[b] as number)] as number;
    }
    out[r] = d;
    offset += bytesPerRow;
  }
}

/**
 * The K nearest rows by hamming distance, ascending, ties broken by chunk
 * id. Selection is a histogram over the (small, integer) distance range, so
 * the whole query is two linear passes and no heap.
 */
export function hammingTopK(index: ShardBitIndex, query: Uint8Array, k: number): HammingHit[] {
  if (query.length !== index.bytesPerRow) {
    throw new Error(`query has ${query.length} bytes, shard rows have ${index.bytesPerRow}`);
  }
  const limit = Math.min(k, index.rows);
  if (limit <= 0) return [];
  const distances = new Uint16Array(index.rows);
  hammingAll(index, query, distances);

  const maxDistance = index.bytesPerRow * 8;
  const histogram = new Uint32Array(maxDistance + 1);
  for (let r = 0; r < index.rows; r++) {
    const d = distances[r] as number;
    histogram[d] = (histogram[d] as number) + 1;
  }
  let threshold = 0;
  let seen = 0;
  for (; threshold <= maxDistance; threshold++) {
    seen += histogram[threshold] as number;
    if (seen >= limit) break;
  }
  let atThreshold = limit - (seen - (histogram[threshold] as number));

  const hits: HammingHit[] = [];
  for (let r = 0; r < index.rows && hits.length < limit; r++) {
    const d = distances[r] as number;
    if (d < threshold) hits.push({ chunkId: r + 1, distance: d });
    else if (d === threshold && atThreshold > 0) {
      hits.push({ chunkId: r + 1, distance: d });
      atThreshold--;
    }
  }
  hits.sort((a, b) => a.distance - b.distance || a.chunkId - b.chunkId);
  return hits;
}
