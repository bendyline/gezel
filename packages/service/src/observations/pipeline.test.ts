import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationTableManifestSchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compactCorpus } from './compactor.js';
import { DuckRunner } from './duck.js';
import {
  listPartitionFiles,
  listPartitions,
  listTables,
  readTableManifest,
  readTableState,
  tableRelDir,
} from './layout.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import {
  expectedRouteStats,
  synthRequests,
  synthRequestsManifest,
} from './testing/synth.js';
import { ObservationWriter, coerceRow, isoDay, resolvePartition } from './writer.js';

const CORPUS = 'data/traffic';

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'gezel-obs-'));
});
afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true }).catch(() => {});
});

function manifestMap() {
  return new Map([
    ['requests', ObservationTableManifestSchema.parse(synthRequestsManifest('requests'))],
  ]);
}

describe('row coercion', () => {
  const manifest = ObservationTableManifestSchema.parse(synthRequestsManifest());

  it('projects onto the declared columns, dropping unknowns and filling gaps', () => {
    const row = coerceRow({ route: '/x', latency_ms: 12.5, surprise: 'ignored' }, manifest);
    expect(Object.keys(row).sort()).toEqual(manifest.columns.map((c) => c.name).sort());
    expect(row.route).toBe('/x');
    expect(row.latency_ms).toBe(12.5);
    // A column the source omitted is null, never absent — that is what keeps
    // every Parquet part of the table mutually readable.
    expect(row.client_country).toBeNull();
    expect('surprise' in row).toBe(false);
  });

  it('normalizes awkward source field names onto their column', () => {
    // `inferTableManifest` would have created `latency_ms` from this key, so
    // the writer must find it again by the same normalization.
    const row = coerceRow({ 'Latency MS': 9 } as Record<string, unknown>, manifest);
    expect(row.latency_ms).toBe(9);
  });

  it('coerces numeric strings and keeps non-finite values out of the corpus', () => {
    expect(coerceRow({ latency_ms: '12.5' }, manifest).latency_ms).toBe(12.5);
    expect(coerceRow({ latency_ms: 'nonsense' }, manifest).latency_ms).toBeNull();
    expect(coerceRow({ bytes: 3.9 }, manifest).bytes).toBe(3);
  });
});

describe('partition resolution', () => {
  const manifest = ObservationTableManifestSchema.parse(synthRequestsManifest());

  it("prefers the adapter's own answer", () => {
    expect(resolvePartition('2026-01-02', {}, {}, manifest)).toBe('2026-01-02');
  });

  it('derives the day from the time column when the adapter is silent', () => {
    const raw = { ts: '2026-08-04T11:22:33.000Z' };
    expect(resolvePartition(undefined, raw, coerceRow(raw, manifest), manifest)).toBe('2026-08-04');
  });

  it('falls back to one bucket when a table has no time axis', () => {
    const flat = ObservationTableManifestSchema.parse({
      schemaVersion: 1,
      table: 'lookup',
      columns: [{ name: 'k', type: 'VARCHAR', role: 'dimension' }],
    });
    expect(resolvePartition(undefined, { k: 'a' }, { k: 'a' }, flat)).toBe('all');
  });

  it('reads a day out of epoch seconds and milliseconds alike', () => {
    expect(isoDay(1_754_265_600)).toBe(isoDay(1_754_265_600_000));
    expect(isoDay('nope')).toBeNull();
  });
});

describe('ObservationWriter', () => {
  it('lands rows as sealed NDJSON parts, partitioned by day', async () => {
    const rows = synthRequests({ rows: 300, seed: 7, days: 3 });
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS, manifests: manifestMap() });
    await writer.writeBatch({ table: 'requests', rows });
    const summary = await writer.finish();

    expect(summary.rowsWritten).toBe(300);
    expect(await listTables(storageDir, CORPUS)).toEqual(['requests']);

    const partitions = await listPartitions(storageDir, CORPUS, 'requests');
    expect(partitions).toHaveLength(3);
    expect(partitions.every((p) => p.startsWith('dt='))).toBe(true);

    // Nothing is left open: `finish()` is the commit point.
    for (const partition of partitions) {
      const files = await listPartitionFiles(storageDir, CORPUS, 'requests', partition);
      expect(files.open).toHaveLength(0);
      expect(files.sealed.length).toBeGreaterThan(0);
    }

    const state = await readTableState(storageDir, CORPUS, 'requests');
    expect(state.totalRows).toBe(300);
    expect(state.lastWriteAt).toBeTruthy();
  });

  it('writes the authored manifest to disk so describe_table can read it', async () => {
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS, manifests: manifestMap() });
    await writer.writeBatch({ table: 'requests', rows: synthRequests({ rows: 5 }) });
    await writer.finish();

    const manifest = await readTableManifest(storageDir, CORPUS, 'requests');
    expect(manifest?.timeColumn).toBe('ts');
    expect(manifest?.inferred).toBeUndefined();
  });

  it('infers a manifest for an unknown table and says so', async () => {
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS });
    await writer.writeBatch({
      table: 'unknown-source',
      rows: [
        { 'Event Time': '2026-08-04T00:00:00Z', Widget: 'alpha', Count: 3 },
        { 'Event Time': '2026-08-04T01:00:00Z', Widget: 'beta', Count: 4 },
      ],
    });
    const summary = await writer.finish();
    expect(summary.tables[0]?.manifestInferred).toBe(true);

    const manifest = await readTableManifest(storageDir, CORPUS, 'unknown-source');
    expect(manifest?.inferred).toBe(true);
    const names = manifest?.columns.map((c) => c.name).sort();
    // Source names are normalized to SQL-safe identifiers, and the original is
    // recorded in the description so the mapping stays discoverable.
    expect(names).toEqual(['count', 'event_time', 'widget']);
    expect(manifest?.columns.find((c) => c.name === 'count')?.type).toBe('BIGINT');
    expect(manifest?.columns.find((c) => c.name === 'event_time')?.role).toBe('time');
  });

  it('seals a part once it passes the size target, without losing rows', async () => {
    const writer = new ObservationWriter({
      storageDir,
      corpusDir: CORPUS,
      manifests: manifestMap(),
      partTargetBytes: 4_096,
    });
    // One day, so every part lands in the same partition and the roll-over is
    // the only thing that can create more than one file.
    await writer.writeBatch({ table: 'requests', rows: synthRequests({ rows: 400, days: 1 }) });
    const summary = await writer.finish();

    expect(summary.rowsWritten).toBe(400);
    const [partition] = await listPartitions(storageDir, CORPUS, 'requests');
    const files = await listPartitionFiles(storageDir, CORPUS, 'requests', partition as string);
    expect(files.sealed.length).toBeGreaterThan(1);

    let lines = 0;
    for (const file of files.sealed) {
      lines += (await readFile(file, 'utf8')).trimEnd().split('\n').length;
    }
    expect(lines).toBe(400);
  });

  it('rejects a page whose declared row count does not match its payload', async () => {
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS, manifests: manifestMap() });
    await expect(
      writer.writeBatch({
        table: 'requests',
        rows: synthRequests({ rows: 10 }),
        expectedRows: 25,
      }),
    ).rejects.toThrow(/declared 25 rows but carried 10/);
  });

  it('never reuses a part ordinal across passes', async () => {
    for (let pass = 0; pass < 3; pass++) {
      const writer = new ObservationWriter({
        storageDir,
        corpusDir: CORPUS,
        manifests: manifestMap(),
      });
      await writer.writeBatch({
        table: 'requests',
        rows: synthRequests({ rows: 20, seed: pass + 1, days: 1 }),
      });
      await writer.finish();
    }
    const [partition] = await listPartitions(storageDir, CORPUS, 'requests');
    const dir = join(storageDir, tableRelDir(CORPUS, 'requests'), partition as string);
    const names = (await readdir(dir)).filter((n) => n.endsWith('.ndjson'));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(3);
  });
});

/**
 * The pipeline claim, end to end: rows in, Parquet out, and the engine's
 * aggregates equal to ground truth computed independently in JS. Requires the
 * real binary — a fake CLI can prove the plumbing but not the arithmetic.
 */
describe.runIf(hasRealDuckdb())('write → seal → compact → query (real engine)', () => {
  let duck: DuckRunner;
  beforeEach(() => {
    duck = new DuckRunner({ binaryPath: findRealDuckdb() as string });
  });

  it('compacts sealed parts to Parquet and preserves every row', async () => {
    const rows = synthRequests({ rows: 2_000, seed: 11, days: 4 });
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS, manifests: manifestMap() });
    await writer.writeBatch({ table: 'requests', rows });
    await writer.finish();

    const [result] = await compactCorpus({ storageDir, corpusDir: CORPUS, duck });
    expect(result?.errors).toEqual([]);
    expect(result?.rowsCompacted).toBe(2_000);

    // Every NDJSON source is gone and a Parquet part stands in its place.
    for (const partition of await listPartitions(storageDir, CORPUS, 'requests')) {
      const files = await listPartitionFiles(storageDir, CORPUS, 'requests', partition);
      expect(files.sealed).toHaveLength(0);
      expect(files.open).toHaveLength(0);
      expect(files.parquet.length).toBeGreaterThan(0);
    }

    const tableRoot = join(storageDir, tableRelDir(CORPUS, 'requests'));
    const counted = await duck.runTrusted<{ n: number }>(
      `SELECT count(*) AS n FROM read_parquet('${tableRoot}/*/*.parquet')`,
      { allowedDirectories: [tableRoot] },
    );
    expect(Number(counted[0]?.n)).toBe(2_000);
  });

  it('answers an aggregate query with the same numbers computed in JS', async () => {
    const rows = synthRequests({ rows: 3_000, seed: 23, days: 5 });
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS, manifests: manifestMap() });
    await writer.writeBatch({ table: 'requests', rows });
    await writer.finish();
    await compactCorpus({ storageDir, corpusDir: CORPUS, duck });

    const tableRoot = join(storageDir, tableRelDir(CORPUS, 'requests'));
    const answered = await duck.runTrusted<{ route: string; requests: number; total: number }>(
      `SELECT route, count(*) AS requests, round(sum(latency_ms), 2) AS total
         FROM read_parquet('${tableRoot}/*/*.parquet')
        GROUP BY 1 ORDER BY 1`,
      { allowedDirectories: [tableRoot] },
    );

    const truth = expectedRouteStats(rows);
    expect(answered).toHaveLength(truth.size);
    for (const row of answered) {
      const expected = truth.get(row.route);
      expect(expected, `unexpected route ${row.route}`).toBeDefined();
      expect(Number(row.requests)).toBe(expected?.requests);
      expect(Number(row.total)).toBeCloseTo(expected?.totalLatency as number, 1);
    }
  });

  it('partition pruning means a one-day question never opens the other days', async () => {
    const rows = synthRequests({ rows: 1_000, seed: 5, days: 4, startDate: '2026-08-01' });
    const writer = new ObservationWriter({ storageDir, corpusDir: CORPUS, manifests: manifestMap() });
    await writer.writeBatch({ table: 'requests', rows });
    await writer.finish();
    await compactCorpus({ storageDir, corpusDir: CORPUS, duck });

    const tableRoot = join(storageDir, tableRelDir(CORPUS, 'requests'));
    const counted = await duck.runTrusted<{ n: number }>(
      `SELECT count(*) AS n
         FROM read_parquet('${tableRoot}/*/*.parquet', hive_partitioning = true)
        WHERE dt = '2026-08-02'`,
      { allowedDirectories: [tableRoot] },
    );
    const expected = rows.filter((r) => r.ts.startsWith('2026-08-02')).length;
    expect(Number(counted[0]?.n)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('publishes nothing and keeps the source when the engine reports a short part', async () => {
    // The guard's whole purpose is silent row loss: a truncated page compacts
    // into a smaller, perfectly valid Parquet file, and every later answer is
    // then confidently wrong. That disagreement cannot be staged with a real
    // engine — a short NDJSON produces a correspondingly short Parquet and the
    // counts agree — so the counts are controlled directly here.
    const writer = new ObservationWriter({
      storageDir,
      corpusDir: CORPUS,
      manifests: manifestMap(),
    });
    await writer.writeBatch({ table: 'requests', rows: synthRequests({ rows: 50, days: 1 }) });
    await writer.finish();

    const [partition] = await listPartitions(storageDir, CORPUS, 'requests');
    const before = await listPartitionFiles(storageDir, CORPUS, 'requests', partition as string);
    const sealed = before.sealed[0] as string;

    const lossyDuck = {
      async runTrusted<Row>(sql: string, opts: { allowedDirectories: string[] }): Promise<Row[]> {
        if (sql.includes('read_ndjson') && sql.includes('count(*)')) {
          return [{ n: 50 } as unknown as Row];
        }
        if (sql.includes('read_parquet') && sql.includes('count(*)')) {
          // The engine says the output is one row short of its source.
          return [{ n: 49 } as unknown as Row];
        }
        // The COPY: do the real conversion so a genuine file exists to reject.
        return duck.runTrusted<Row>(sql, opts as never);
      },
    };

    const [result] = await compactCorpus({
      storageDir,
      corpusDir: CORPUS,
      duck: lossyDuck,
    });

    expect(result?.partsCompacted).toBe(0);
    expect(result?.partsFailed).toBe(1);
    expect(result?.errors[0]).toMatch(/row count mismatch/);

    // The source survives for a retry, and no half-complete part was published.
    expect(existsSync(sealed)).toBe(true);
    const after = await listPartitionFiles(storageDir, CORPUS, 'requests', partition as string);
    expect(after.parquet).toHaveLength(0);
    expect(existsSync(`${sealed.replace('sealed-', 'part-').replace('.ndjson', '.parquet')}.tmp`)).toBe(
      false,
    );

    // And the failure is recorded where the next pass and the UI can see it.
    const state = await readTableState(storageDir, CORPUS, 'requests');
    expect(state.lastError).toMatch(/row count mismatch/);
  });
});
