/**
 * Stage-1 retrieval over a shard's sign-bit vectors, in memory. A full
 * 200k-chunk shard is 9.6 MB of bits, and either scan below is one linear
 * pass over them, a few milliseconds, needing nothing beyond plain SQLite
 * to load — which is what lets any reader implement the format without a
 * vector extension.
 *
 * Two scans share the bits:
 *   - `hammingTopK` — symmetric: the query is binarized too and rows are
 *     ranked by popcount(xor). The format's baseline (§2), and what the
 *     self-KNN smoke and the conformance kit exercise.
 *   - `asymmetricTopK` — the float query against each row's bits, ranked by
 *     Σ q[d]·(bit ? +1 : −1). Keeps the query's magnitudes, which on real
 *     embeddings roughly doubles the share of true neighbours a small
 *     candidate pool retains (measured on multilingual-e5-small: 22% → 39%
 *     of the exact top-24 at K = 192 with raw bits, 73% → 88% with centered
 *     bits). This is what `CatalogHandle` uses.
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

export interface AsymmetricHit {
  chunkId: number;
  score: number;
}

/**
 * The K best rows by asymmetric score, descending, ties broken by chunk id.
 *
 * The score of a row is Σ_d query[d] · (bit_d ? +1 : −1). Per query a table
 * of 256 partial sums is built for each byte position, so a row costs
 * `bytesPerRow` table reads and adds — about the popcount scan's cost. The
 * top-K is kept in a bounded min-heap whose root is the worst kept row.
 *
 * For a `centered-sign` profile the caller passes `query − center`; for a
 * plain `sign` profile the unit query. The bits are whatever the catalog
 * stored; this function does not know or care which.
 */
export function asymmetricTopK(
  index: ShardBitIndex,
  query: ArrayLike<number>,
  k: number,
): AsymmetricHit[] {
  const { bits, bytesPerRow, rows } = index;
  if (Math.ceil(query.length / 8) !== bytesPerRow) {
    throw new Error(
      `query has ${query.length} dimensions, shard rows have ${bytesPerRow} bytes of bits`,
    );
  }
  const limit = Math.min(k, rows);
  if (limit <= 0) return [];

  const lut = new Float32Array(bytesPerRow * 256);
  for (let p = 0; p < bytesPerRow; p++) {
    for (let b = 0; b < 256; b++) {
      let s = 0;
      for (let i = 0; i < 8; i++) {
        const d = p * 8 + i;
        if (d >= query.length) break;
        const v = query[d] as number;
        s += (b >> i) & 1 ? v : -v;
      }
      lut[p * 256 + b] = s;
    }
  }

  // Bounded min-heap: index 0 holds the worst kept row (lowest score; among
  // equal scores the higher chunk id, so ties resolve to the lower id).
  const heapScore = new Float64Array(limit);
  const heapId = new Int32Array(limit);
  let size = 0;
  const worse = (i: number, j: number): boolean =>
    (heapScore[i] as number) < (heapScore[j] as number) ||
    ((heapScore[i] as number) === (heapScore[j] as number) &&
      (heapId[i] as number) > (heapId[j] as number));
  const swap = (i: number, j: number): void => {
    const s = heapScore[i] as number;
    const id = heapId[i] as number;
    heapScore[i] = heapScore[j] as number;
    heapId[i] = heapId[j] as number;
    heapScore[j] = s;
    heapId[j] = id;
  };
  const siftUp = (start: number): void => {
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!worse(i, parent)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const siftDown = (start: number): void => {
    let i = start;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= size) break;
      const right = left + 1;
      const child = right < size && worse(right, left) ? right : left;
      if (!worse(child, i)) break;
      swap(child, i);
      i = child;
    }
  };

  let offset = 0;
  for (let r = 0; r < rows; r++) {
    let score = 0;
    for (let p = 0; p < bytesPerRow; p++) {
      score += lut[p * 256 + (bits[offset + p] as number)] as number;
    }
    offset += bytesPerRow;
    if (size < limit) {
      heapScore[size] = score;
      heapId[size] = r + 1;
      size++;
      siftUp(size - 1);
    } else if (
      score > (heapScore[0] as number) ||
      (score === (heapScore[0] as number) && r + 1 < (heapId[0] as number))
    ) {
      heapScore[0] = score;
      heapId[0] = r + 1;
      siftDown(0);
    }
  }

  const hits: AsymmetricHit[] = [];
  for (let i = 0; i < size; i++) {
    hits.push({ chunkId: heapId[i] as number, score: heapScore[i] as number });
  }
  hits.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  return hits;
}
