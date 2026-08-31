import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckRunner } from './duck.js';
import { readTableManifest, readTableState, tableRelDir } from './layout.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import { shouldMaterialize } from './workspace-tables.js';
import {
  type ExtractedTable,
  cellKindToColumnType,
  manifestForTable,
  materializeWorkbook,
  parseExtractedTables,
  tableNameForRegion,
} from './workspace-xlsx.js';

let artifacts: string;
let duck: DuckRunner;

/**
 * What squisq's typed export yields for a realistic sheet: a captioned island
 * whose columns carry VALUES, not the strings the sheet displays.
 */
const REVENUE: ExtractedTable = {
  sheet: 'Sales',
  anchor: 'B4',
  title: 'Q3 Revenue',
  hasHeader: true,
  columns: [
    { name: 'Region', kind: 'string' },
    { name: 'Share', kind: 'number' },
    { name: 'Closed', kind: 'bool' },
    { name: 'As Of', kind: 'date' },
  ],
  rows: [
    ['North', 0.15, true, '2026-08-04'],
    ['South', 0.095, false, '2026-08-05'],
  ],
};

const SECOND: ExtractedTable = {
  sheet: 'Sales',
  anchor: 'F4',
  hasHeader: true,
  columns: [
    { name: 'Item', kind: 'string' },
    { name: 'Qty', kind: 'number' },
  ],
  rows: [['Widget', 3]],
};

const SOURCE = {
  relPath: 'data/plan.xlsx',
  absPath: '/nowhere/data/plan.xlsx',
  hash: 'h1',
  size: 4096,
};

function extractor(tables: ExtractedTable[]) {
  return async () => ({ ndjson: tables.map((t) => JSON.stringify(t)).join('\n') });
}

beforeEach(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-xlsx-'));
  duck = new DuckRunner({ binaryPath: findRealDuckdb() ?? '/nonexistent/duckdb' });
});
afterEach(async () => {
  await rm(artifacts, { recursive: true, force: true }).catch(() => {});
});

describe('policy', () => {
  it('admits a spreadsheet at any size, unlike a CSV', () => {
    // A gezel cannot read the binary at all, so the threshold that protects
    // small CSVs from becoming noise does not apply.
    expect(shouldMaterialize('a.xlsx', 200, { minBytes: 512 * 1024 })).toBe(true);
    expect(shouldMaterialize('a.csv', 200, { minBytes: 512 * 1024 })).toBe(false);
    // But an empty file is still nothing.
    expect(shouldMaterialize('a.xlsx', 0, { minBytes: 0 })).toBe(false);
  });
});

describe('type mapping', () => {
  it.each([
    ['number', 'DOUBLE'],
    ['bool', 'BOOLEAN'],
    ['date', 'TIMESTAMP'],
    ['string', 'VARCHAR'],
    ['error', 'VARCHAR'],
    // A column that genuinely holds several kinds is text: anything narrower
    // would drop values.
    ['mixed', 'VARCHAR'],
  ])('maps the %s cell kind to %s', (kind, expected) => {
    expect(cellKindToColumnType(kind)).toBe(expected);
  });
});

describe('parsing the worker output', () => {
  it('reads one table per line', () => {
    expect(
      parseExtractedTables(`${JSON.stringify(REVENUE)}\n${JSON.stringify(SECOND)}\n`),
    ).toHaveLength(2);
  });

  it('loses only the bad line, not the workbook', () => {
    // NDJSON exists precisely so a truncated write costs the last table.
    const ndjson = `${JSON.stringify(REVENUE)}\n{"broken":\n`;
    expect(parseExtractedTables(ndjson)).toHaveLength(1);
    expect(parseExtractedTables('')).toEqual([]);
  });
});

describe('naming', () => {
  it('prefers the caption a person would use', () => {
    expect(tableNameForRegion(REVENUE, new Set())).toBe('q3-revenue');
  });

  it('falls back to sheet and anchor for a nameless island', () => {
    expect(tableNameForRegion(SECOND, new Set())).toBe('sales-f4');
  });

  it('disambiguates two islands sharing a caption', () => {
    const taken = new Set<string>();
    const first = tableNameForRegion(REVENUE, taken);
    const second = tableNameForRegion({ ...REVENUE, anchor: 'J9' }, taken);
    expect(first).toBe('q3-revenue');
    expect(second).toBe('q3-revenue-j9');
    expect(first).not.toBe(second);
  });
});

describe('manifest', () => {
  it('types columns from squisq and records where the data came from', () => {
    const manifest = manifestForTable(REVENUE, 'q3-revenue', 'data/plan.xlsx');
    expect(manifest.columns.map((c) => [c.name, c.type])).toEqual([
      ['region', 'VARCHAR'],
      ['share', 'DOUBLE'],
      ['closed', 'BOOLEAN'],
      ['as_of', 'TIMESTAMP'],
    ]);
    // A user asks "which sheet?" — the answer belongs in describe_table.
    expect(manifest.description).toContain('Sales');
    expect(manifest.description).toContain('B4');
    expect(manifest.description).toContain('data/plan.xlsx');
    expect(manifest.inferred).toBe(true);
  });

  it('keeps two columns that normalize to the same name', () => {
    const manifest = manifestForTable(
      {
        ...REVENUE,
        columns: [
          { name: 'Total', kind: 'number' },
          { name: 'total', kind: 'number' },
        ],
      },
      't',
      'a.xlsx',
    );
    expect(new Set(manifest.columns.map((c) => c.name)).size).toBe(2);
  });
});

describe.runIf(hasRealDuckdb())('materializeWorkbook (real engine)', () => {
  it('writes one table per island, carrying values rather than renderings', async () => {
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: extractor([REVENUE, SECOND]),
    });

    expect(result.state).toBe('ok');
    expect(result.tables?.sort()).toEqual(['q3-revenue', 'sales-f4']);
    expect(result.rows).toBe(3);

    const corpusDir = result.corpusDir as string;
    const tableRoot = join(artifacts, tableRelDir(corpusDir, 'q3-revenue'));
    const rows = await duck.runTrusted<{ region: string; share: number; closed: boolean }>(
      `SELECT region, share, closed FROM read_parquet('${tableRoot}/*/*.parquet') ORDER BY region`,
      { allowedDirectories: [tableRoot] },
    );
    // 0.15, not "15.0%". This is the whole reason the data path avoids markdown.
    expect(Number(rows[0]?.share)).toBeCloseTo(0.15, 5);
    expect(rows[0]?.region).toBe('North');
    expect(rows[0]?.closed).toBe(true);

    // And it aggregates, which a percent-suffixed string could not.
    const [total] = await duck.runTrusted<{ n: number }>(
      `SELECT round(sum(share), 4) AS n FROM read_parquet('${tableRoot}/*/*.parquet')`,
      { allowedDirectories: [tableRoot] },
    );
    expect(Number(total?.n)).toBeCloseTo(0.245, 4);
  });

  it('records the row count in state so list_tables can report it', async () => {
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: extractor([REVENUE]),
    });
    const state = await readTableState(artifacts, result.corpusDir as string, 'q3-revenue');
    expect(state.totalRows).toBe(2);
    const manifest = await readTableManifest(artifacts, result.corpusDir as string, 'q3-revenue');
    expect(manifest?.title).toBe('Q3 Revenue');
  });

  it('reports a workbook with no table-shaped data rather than writing nothing quietly', async () => {
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: async () => ({ ndjson: '' }),
    });
    expect(result.state).toBe('blocked');
    expect(result.reason).toMatch(/no table-shaped data/);
  });

  it('passes a sandbox refusal straight through', async () => {
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: async () => ({ ndjson: null, blocked: 'file exceeds the conversion limit' }),
    });
    expect(result.state).toBe('blocked');
    expect(result.reason).toContain('exceeds');
  });

  it('names a version mismatch as itself, not as a broken spreadsheet', async () => {
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: async () => ({ ndjson: null }),
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/could not be read/);
  });

  it('skips an island with no body rows without failing the workbook', async () => {
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: extractor([{ ...REVENUE, rows: [] }, SECOND]),
    });
    expect(result.state).toBe('ok');
    expect(result.tables).toEqual(['sales-f4']);
  });

  it('caps how many tables one workbook may contribute', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...SECOND,
      anchor: `A${i + 1}`,
      title: undefined,
    }));
    const result = await materializeWorkbook({
      storageDir: artifacts,
      duck,
      source: SOURCE,
      extract: extractor(many),
      maxTables: 2,
    });
    expect(result.tables).toHaveLength(2);
  });
});
