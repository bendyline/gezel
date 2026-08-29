import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckRunner } from './duck.js';
import { readTableManifest, readTableState, tableRelDir } from './layout.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import {
  duckTypeToColumnType,
  materializeCsv,
  parseSniffedColumns,
  removeWorkspaceTable,
  shouldMaterialize,
  sourceRelPathFromCorpusDir,
  tabularCorpusDir,
  tableNameForSource,
} from './workspace-tables.js';

let artifacts: string;
let workspace: string;
let duck: DuckRunner;

beforeEach(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-wt-art-'));
  workspace = await mkdtemp(join(tmpdir(), 'gezel-wt-ws-'));
  duck = new DuckRunner({ binaryPath: findRealDuckdb() ?? '/nonexistent/duckdb' });
});
afterEach(async () => {
  await rm(artifacts, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function seedCsv(rel: string, body: string) {
  const abs = join(workspace, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
  return { relPath: rel, absPath: abs, hash: `h-${rel}`, size: Buffer.byteLength(body) };
}

const SALES = [
  'Region,Total Revenue (USD),Units,Active',
  'North,1200.50,12,true',
  'South,980.25,9,false',
  'North,1500.00,15,true',
  '',
].join('\n');

describe('corpus placement', () => {
  it('keeps the source basename so the reverse map is lossless', () => {
    expect(tabularCorpusDir('data/sales.csv')).toBe('tabular/data/sales.csv_tables');
    expect(tabularCorpusDir('sales.csv')).toBe('tabular/sales.csv_tables');
    // a.csv and a.xlsx must not collide, which is why the extension stays.
    expect(tabularCorpusDir('a.csv')).not.toBe(tabularCorpusDir('a.xlsx'));
  });

  it('round-trips back to the source path for orphan collection', () => {
    for (const rel of ['data/sales.csv', 'sales.csv', 'a/b/c/deep.tsv']) {
      expect(sourceRelPathFromCorpusDir(tabularCorpusDir(rel) as string)).toBe(rel);
    }
    expect(sourceRelPathFromCorpusDir('shadow/x')).toBeNull();
    expect(sourceRelPathFromCorpusDir('tabular/not-a-companion')).toBeNull();
  });

  it('returns null rather than throwing for a path it cannot place safely', () => {
    // Workspace names are attacker-controlled; a file we cannot place is
    // skipped quietly so one bad name does not fail a whole pass.
    expect(tabularCorpusDir('../escape.csv')).toBeNull();
    expect(tabularCorpusDir('a/../../escape.csv')).toBeNull();
    expect(tabularCorpusDir('')).toBeNull();
  });

  it('names the table from the file stem', () => {
    expect(tableNameForSource('data/Q3 Sales.csv')).toBe('q3-sales');
    // `.csv` is a dotfile, not an extension — Node reads no extname from it.
    expect(tableNameForSource('data/.csv')).toBe('csv');
  });
});

describe('materialization policy', () => {
  it('is the indexer trivial line, not a new magic number', () => {
    const min = 512 * 1024;
    expect(shouldMaterialize('data/big.csv', min, { minBytes: min })).toBe(true);
    expect(shouldMaterialize('data/small.csv', min - 1, { minBytes: min })).toBe(false);
    // Below the line the file is already chunked, searchable and readable.
  });

  it('ignores files it has no reader for', () => {
    expect(shouldMaterialize('notes.md', 10_000_000, { minBytes: 0 })).toBe(false);
    expect(shouldMaterialize('data/report.tsv', 10_000_000, { minBytes: 0 })).toBe(true);
  });
});

describe('type mapping', () => {
  it.each([
    ['BOOLEAN', 'BOOLEAN'],
    ['BIGINT', 'BIGINT'],
    ['INTEGER', 'BIGINT'],
    ['DOUBLE', 'DOUBLE'],
    ['DECIMAL(18,3)', 'DOUBLE'],
    ['DATE', 'DATE'],
    ['TIMESTAMP WITH TIME ZONE', 'TIMESTAMP'],
    ['VARCHAR', 'VARCHAR'],
    ['STRUCT(a INTEGER)', 'JSON'],
    ['VARCHAR[]', 'JSON'],
  ])('maps %s to %s', (duckType, expected) => {
    expect(duckTypeToColumnType(duckType)).toBe(expected);
  });

  it('tolerates the shapes sniff_csv has used across releases', () => {
    expect(parseSniffedColumns([{ name: 'a', type: 'BIGINT' }])).toEqual([
      { name: 'a', type: 'BIGINT' },
    ]);
    expect(parseSniffedColumns([{ column_name: 'a', column_type: 'BIGINT' }])).toEqual([
      { name: 'a', type: 'BIGINT' },
    ]);
    expect(parseSniffedColumns(null)).toEqual([]);
    expect(parseSniffedColumns([{ nope: 1 }])).toEqual([]);
  });
});

describe.runIf(hasRealDuckdb())('materializeCsv (real engine)', () => {
  it('derives a typed schema from the engine and writes Parquet', async () => {
    const source = await seedCsv('data/sales.csv', SALES);
    const result = await materializeCsv({ storageDir: artifacts, duck, source });

    expect(result.state).toBe('ok');
    expect(result.rows).toBe(3);
    const corpusDir = result.corpusDir as string;

    const manifest = await readTableManifest(artifacts, corpusDir, 'sales');
    // Column names are normalized so a model never has to quote them, and the
    // original is recorded so the mapping stays discoverable.
    expect(manifest?.columns.map((c) => c.name)).toEqual([
      'region',
      'total_revenue_usd',
      'units',
      'active',
    ]);
    expect(manifest?.columns.find((c) => c.name === 'total_revenue_usd')?.type).toBe('DOUBLE');
    expect(manifest?.columns.find((c) => c.name === 'units')?.type).toBe('BIGINT');
    expect(manifest?.columns.find((c) => c.name === 'active')?.type).toBe('BOOLEAN');
    expect(manifest?.inferred).toBe(true);
    expect(
      manifest?.columns.find((c) => c.name === 'total_revenue_usd')?.description,
    ).toContain('Total Revenue (USD)');

    const state = await readTableState(artifacts, corpusDir, 'sales');
    expect(state.totalRows).toBe(3);

    const tableRoot = join(artifacts, tableRelDir(corpusDir, 'sales'));
    const counted = await duck.runTrusted<{ n: number; revenue: number }>(
      `SELECT count(*) AS n, round(sum(total_revenue_usd), 2) AS revenue
         FROM read_parquet('${tableRoot}/*/*.parquet')`,
      { allowedDirectories: [tableRoot] },
    );
    expect(Number(counted[0]?.n)).toBe(3);
    expect(Number(counted[0]?.revenue)).toBeCloseTo(3680.75, 2);
  });

  it('answers a GROUP BY over the real values', async () => {
    const source = await seedCsv('data/sales.csv', SALES);
    const result = await materializeCsv({ storageDir: artifacts, duck, source });
    const tableRoot = join(artifacts, tableRelDir(result.corpusDir as string, 'sales'));
    const rows = await duck.runTrusted<{ region: string; units: number }>(
      `SELECT region, sum(units) AS units FROM read_parquet('${tableRoot}/*/*.parquet')
        GROUP BY 1 ORDER BY units DESC`,
      { allowedDirectories: [tableRoot] },
    );
    expect(rows.map((r) => [r.region, Number(r.units)])).toEqual([
      ['North', 27],
      ['South', 9],
    ]);
  });

  it('handles quoted delimiters and a BOM without losing a column', async () => {
    const body = ['﻿name,note,qty', 'Widget,"a, b",3', 'Gadget,"say ""hi""",4', ''].join('\n');
    const source = await seedCsv('messy.csv', body);
    const result = await materializeCsv({ storageDir: artifacts, duck, source });
    expect(result.state).toBe('ok');
    expect(result.rows).toBe(2);

    const manifest = await readTableManifest(artifacts, result.corpusDir as string, 'messy');
    expect(manifest?.columns.map((c) => c.name)).toEqual(['name', 'note', 'qty']);
  });

  it('keeps every column when headers repeat', async () => {
    const source = await seedCsv('dupes.csv', 'Total,Total,total\n1,2,3\n');
    const result = await materializeCsv({ storageDir: artifacts, duck, source });
    const manifest = await readTableManifest(artifacts, result.corpusDir as string, 'dupes');
    // The engine de-duplicates repeated headers itself (Total, Total_1,
    // total_2); our normalization must not then collapse them back together.
    // A CSV with two `Total` columns is ordinary; dropping one is not.
    const names = manifest?.columns.map((c) => c.name) ?? [];
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('defers a file too large for the interactive path', async () => {
    const source = await seedCsv('big.csv', SALES);
    const result = await materializeCsv({
      storageDir: artifacts,
      duck,
      source: { ...source, size: 999_999_999 },
      maxInlineBytes: 1024,
    });
    expect(result.state).toBe('deferred');
    // Nothing written; the night shift picks it up.
    expect(existsSync(join(artifacts, result.corpusDir as string))).toBe(false);
  });

  it('reports an empty file as blocked, publishing nothing', async () => {
    // The engine invents a phantom `column0 VARCHAR` for a zero-byte file, so
    // without an explicit guard this would publish a table of nothing.
    const source = await seedCsv('broken.csv', '');
    const result = await materializeCsv({ storageDir: artifacts, duck, source });
    expect(result.state).toBe('blocked');
    expect(result.reason).toBeTruthy();
    const parquet = join(
      artifacts,
      tableRelDir(result.corpusDir as string, 'broken'),
      'part=all',
      'part-000000.parquet',
    );
    expect(existsSync(parquet)).toBe(false);
  });

  it('rebuilds wholesale when the source changes', async () => {
    const first = await seedCsv('data/sales.csv', SALES);
    await materializeCsv({ storageDir: artifacts, duck, source: first });

    const grown = await seedCsv('data/sales.csv', `${SALES}East,50.00,1,true\n`);
    const result = await materializeCsv({ storageDir: artifacts, duck, source: grown });
    expect(result.rows).toBe(4);

    // A snapshot, not an append: exactly one part, holding only current rows.
    const tableRoot = join(artifacts, tableRelDir(result.corpusDir as string, 'sales'));
    const counted = await duck.runTrusted<{ n: number }>(
      `SELECT count(*) AS n FROM read_parquet('${tableRoot}/*/*.parquet')`,
      { allowedDirectories: [tableRoot] },
    );
    expect(Number(counted[0]?.n)).toBe(4);
  });

  it('removes the whole companion directory when the source goes', async () => {
    const source = await seedCsv('data/sales.csv', SALES);
    const result = await materializeCsv({ storageDir: artifacts, duck, source });
    const corpusDir = result.corpusDir as string;
    expect(existsSync(join(artifacts, corpusDir))).toBe(true);

    expect(await removeWorkspaceTable(artifacts, corpusDir)).toBe(true);
    expect(existsSync(join(artifacts, corpusDir))).toBe(false);
    expect(await removeWorkspaceTable(artifacts, corpusDir)).toBe(false);
  });
});
