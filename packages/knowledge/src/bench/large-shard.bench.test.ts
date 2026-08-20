/**
 * Phase-0 exit benchmark (knowledge-catalogs plan): a full 200k-chunk shard's
 * stage-1 bit KNN scan must land in the ~10-25 ms band, and the stage-2 int8
 * rerank in low single-digit ms — the two figures the bit384+int8 scale
 * design rests on (gezk-format-v1.md §2). Gated behind GEZK_BENCH=1 so
 * ordinary suite runs never pay the ~200k-row setup; run it on the slowest
 * supported hardware when revisiting shard sizing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { loadVecExtension } from '../compiler/vec-load.js';
import { RERANK_FINAL_K, rerankK } from '../format/constants.js';
import { quantizeBinary, quantizeInt8, rerankScore } from '../format/quantize.js';

const enabled = process.env.GEZK_BENCH === '1';
const CHUNKS = 200_000;
const DIM = 384;

function seededVector(seed: number): Float32Array {
  // Cheap deterministic pseudo-random unit vector (xorshift32).
  let state = (seed + 0x9e3779b9) >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff - 0.5;
  };
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = next();
    norm += (v[i] as number) ** 2;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] = (v[i] as number) / norm;
  return v;
}

describe.skipIf(!enabled)('large-shard benchmark (GEZK_BENCH=1)', () => {
  let dir: string;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('200k-chunk bit scan + int8 rerank meet the format budget', { timeout: 600_000 }, () => {
    dir = mkdtempSync(join(tmpdir(), 'gezk-bench-'));
    const db = new DatabaseSync(join(dir, 'shard.db'), { allowExtension: true });
    loadVecExtension(db);
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY, embedding bit[${DIM}], chunk_size=1024)`);
    db.exec('CREATE TABLE chunk_vectors_int8 (chunk_id INTEGER PRIMARY KEY, v BLOB NOT NULL)');

    const insertBit = db.prepare(
      'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_bit(?))',
    );
    const insertInt8 = db.prepare('INSERT INTO chunk_vectors_int8 (chunk_id, v) VALUES (?, ?)');
    db.exec('BEGIN');
    const t0 = performance.now();
    for (let i = 1; i <= CHUNKS; i++) {
      const unit = seededVector(i);
      insertBit.run(BigInt(i), Buffer.from(quantizeBinary(unit)));
      insertInt8.run(BigInt(i), Buffer.from(quantizeInt8(unit).buffer));
    }
    db.exec('COMMIT');
    console.log(`[bench] inserted ${CHUNKS} rows in ${Math.round(performance.now() - t0)}ms`);

    const query = seededVector(123_456_789);
    const k = rerankK(RERANK_FINAL_K);
    const knn = db.prepare(
      'SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH vec_bit(?) AND k = ? ORDER BY distance',
    );
    const fetchInt8 = db.prepare('SELECT v FROM chunk_vectors_int8 WHERE chunk_id = ?');

    // Warm the page cache, then measure repeated scans.
    knn.all(Buffer.from(quantizeBinary(query)), BigInt(k));
    const scanTimes: number[] = [];
    let hits: Array<{ chunk_id: number | bigint }> = [];
    for (let run = 0; run < 10; run++) {
      const s0 = performance.now();
      hits = knn.all(Buffer.from(quantizeBinary(query)), BigInt(k)) as Array<{
        chunk_id: number | bigint;
      }>;
      scanTimes.push(performance.now() - s0);
    }
    scanTimes.sort((a, b) => a - b);
    const scanMedian = scanTimes[Math.floor(scanTimes.length / 2)] as number;

    const r0 = performance.now();
    const reranked = hits
      .map((h) => {
        const row = fetchInt8.get(BigInt(h.chunk_id)) as { v: Uint8Array };
        return {
          id: Number(h.chunk_id),
          score: rerankScore(
            query,
            new Int8Array(row.v.buffer, row.v.byteOffset, row.v.byteLength),
          ),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, RERANK_FINAL_K);
    const rerankMs = performance.now() - r0;

    console.log(
      `[bench] k=${k} bit-KNN median ${scanMedian.toFixed(1)}ms over ${CHUNKS} rows; ` +
        `int8 rerank ${rerankMs.toFixed(1)}ms; top score ${reranked[0]?.score.toFixed(3)}`,
    );
    db.close();

    expect(hits.length).toBe(k);
    expect(reranked.length).toBe(RERANK_FINAL_K);
    // Generous ceilings — the design budget is 10-25ms scan; a slow CI runner
    // gets 4x headroom before this counts as a regression signal.
    expect(scanMedian).toBeLessThan(100);
    expect(rerankMs).toBeLessThan(50);
  });
});
