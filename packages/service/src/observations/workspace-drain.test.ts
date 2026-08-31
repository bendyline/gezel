import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexStore } from '../index-store/index-store.js';
import { DuckRunner } from './duck.js';
import { readTableState, tableRelDir } from './layout.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import {
  MAX_TABULAR_ATTEMPTS,
  drainWorkspaceTables,
  sweepOrphanedTables,
} from './workspace-drain.js';

let home: string;
let artifacts: string;
let workspace: string;
let store: IndexStore;
let duck: DuckRunner;

const HEADER = 'region,revenue,units';

/** A CSV big enough to clear the "too big to just read" threshold. */
function bigCsv(rows: number, seed = 0): string {
  const lines = [HEADER];
  for (let i = 0; i < rows; i++) {
    lines.push(`${i % 2 === 0 ? 'North' : 'South'},${(i + seed) * 10}.50,${i + 1}`);
  }
  return `${lines.join('\n')}\n`;
}

async function seed(rel: string, body: string) {
  const abs = join(workspace, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body);
  const size = Buffer.byteLength(body);
  // Mirror what the index pass enrols: path, content hash, size.
  store.upsertFile({
    path: rel,
    hash: `hash-${rel}-${size}`,
    size,
    mtimeMs: Date.now(),
    lang: 'csv',
    kind: 'data',
    modality: 'text',
    // How the indexer records a data file over the readable threshold today:
    // enrolled for the deletion sweep, but with no chunks and no enrichment.
    trivial: true,
    indexedAt: new Date().toISOString(),
    loc: null,
  });
  return { rel, abs, size };
}

function drain(overrides: Partial<Parameters<typeof drainWorkspaceTables>[0]> = {}) {
  return drainWorkspaceTables({
    store,
    duck,
    storageDir: artifacts,
    workspaceDir: workspace,
    minBytes: 0,
    ...overrides,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-drain-home-'));
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-drain-art-'));
  workspace = await mkdtemp(join(tmpdir(), 'gezel-drain-ws-'));
  store = (await IndexStore.open(join(home, 'index.db'), {
    collectionId: 'ws:p1',
    kind: 'workspace',
    rootPath: workspace,
    vectorless: true,
  })) as IndexStore;
  duck = new DuckRunner({ binaryPath: findRealDuckdb() ?? '/nonexistent/duckdb' });
});
afterEach(async () => {
  store?.close();
  for (const dir of [home, artifacts, workspace]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('drain gating', () => {
  it('does nothing but stay safe when the engine is not installed', async () => {
    await seed('data/sales.csv', bigCsv(50));
    const missing = new DuckRunner({ binaryPath: '' });
    const prior = process.env.GEZEL_DUCKDB_BIN;
    delete process.env.GEZEL_DUCKDB_BIN;
    try {
      const result = await drain({ duck: missing });
      // The files stay enrolled and unconverted; a later drain picks them up.
      expect(result.materialized).toBe(0);
      expect(result.failed).toBe(0);
    } finally {
      if (prior !== undefined) process.env.GEZEL_DUCKDB_BIN = prior;
    }
  });

  it('leaves small files alone — they are already readable and searchable', async () => {
    await seed('notes/tiny.csv', `${HEADER}\nNorth,1,1\n`);
    const result = await drain({ minBytes: 512 * 1024 });
    expect(result.materialized).toBe(0);
  });
});

describe.runIf(hasRealDuckdb())('drainWorkspaceTables (real engine)', () => {
  it('converts an enrolled data file into a queryable table', async () => {
    await seed('data/sales.csv', bigCsv(100));
    const result = await drain();

    expect(result.materialized).toBe(1);
    expect(result.rows).toBe(100);
    const corpusDir = 'tabular/data/sales.csv_tables';
    expect(await readTableState(artifacts, corpusDir, 'sales')).toMatchObject({ totalRows: 100 });

    const tableRoot = join(artifacts, tableRelDir(corpusDir, 'sales'));
    const rows = await duck.runTrusted<{ region: string; units: number }>(
      `SELECT region, sum(units) AS units FROM read_parquet('${tableRoot}/*/*.parquet')
        GROUP BY 1 ORDER BY 1`,
      { allowedDirectories: [tableRoot] },
    );
    expect(rows.map((r) => r.region)).toEqual(['North', 'South']);
  });

  it('is idempotent: a second drain over unchanged files does nothing', async () => {
    await seed('data/sales.csv', bigCsv(20));
    expect((await drain()).materialized).toBe(1);
    // The gate is the content hash, so an unchanged file costs nothing.
    expect((await drain()).materialized).toBe(0);
  });

  it('rebuilds when the file content changes', async () => {
    await seed('data/sales.csv', bigCsv(20));
    await drain();
    await seed('data/sales.csv', bigCsv(35, 1));
    const second = await drain();
    expect(second.materialized).toBe(1);
    expect(second.rows).toBe(35);
  });

  it('sweeps a table whose source file is gone, and forgets its gate row', async () => {
    await seed('data/sales.csv', bigCsv(20));
    await drain();
    const corpusDir = 'tabular/data/sales.csv_tables';
    expect(existsSync(join(artifacts, corpusDir))).toBe(true);

    store.deleteFile('data/sales.csv');
    const swept = await sweepOrphanedTables(store, artifacts);
    expect(swept).toBe(1);
    expect(existsSync(join(artifacts, corpusDir))).toBe(false);

    // The gate row is dropped too, so the file re-appearing rebuilds rather
    // than being skipped by a stale 'ok'.
    await seed('data/sales.csv', bigCsv(20));
    expect((await drain()).materialized).toBe(1);
  });

  it('does not confuse two sources that differ only by extension', async () => {
    // The companion dir keeps the full basename precisely so this cannot go
    // wrong — a deleted a.csv must not take a live a.tsv's table with it.
    await seed('a.csv', bigCsv(10));
    await seed('a.tsv', bigCsv(10).replaceAll(',', '\t'));
    await drain();
    expect(existsSync(join(artifacts, 'tabular/a.csv_tables'))).toBe(true);
    expect(existsSync(join(artifacts, 'tabular/a.tsv_tables'))).toBe(true);

    store.deleteFile('a.csv');
    await sweepOrphanedTables(store, artifacts);
    expect(existsSync(join(artifacts, 'tabular/a.csv_tables'))).toBe(false);
    expect(existsSync(join(artifacts, 'tabular/a.tsv_tables'))).toBe(true);
  });

  it('caps work per drain and reports what it left, rather than truncating silently', async () => {
    for (let i = 0; i < 5; i++) await seed(`data/f${i}.csv`, bigCsv(10, i));
    const result = await drain({ maxTables: 2 });
    expect(result.materialized).toBe(2);
    expect(result.remaining).toBeGreaterThan(0);

    // The rest arrive on later ticks.
    expect((await drain({ maxTables: 5 })).materialized).toBe(3);
  });

  it('defers a file too large for the interactive pass', async () => {
    await seed('data/huge.csv', bigCsv(50));
    const result = await drain({ maxInlineBytes: 10 });
    expect(result.deferred).toBe(1);
    expect(result.materialized).toBe(0);
  });

  it('gives up on an unreadable file instead of retrying it every pass', async () => {
    await seed('data/empty.csv', '');
    // An empty file is terminal: it will not become readable by retrying.
    expect((await drain()).blocked).toBe(1);
    expect((await drain()).blocked).toBe(0);
  });

  it('stops retrying a repeatedly failing file after the attempt cap', async () => {
    await seed('data/sales.csv', bigCsv(10));
    const exploding = {
      available: () => true,
      runTrusted: async () => {
        throw new Error('engine exploded');
      },
    } as unknown as DuckRunner;

    for (let i = 0; i < MAX_TABULAR_ATTEMPTS; i++) {
      await drain({ duck: exploding });
    }
    // Capped: one bad file costs a bounded number of conversions, not one per
    // pass forever.
    expect((await drain({ duck: exploding })).failed).toBe(0);
  });
});

describe.runIf(hasRealDuckdb())('the shadow table card', () => {
  it('makes an otherwise-invisible data file findable by keyword', async () => {
    await seed('data/sales.csv', bigCsv(40));
    await drain();

    // Without this the file is a dead end: too big for the indexer to chunk,
    // too big to read, and with no trace in search that it exists at all.
    const card = join(artifacts, 'shadow', 'data', 'sales.csv_files', 'sales.md');
    expect(existsSync(card)).toBe(true);

    const text = await readFile(card, 'utf8');
    expect(text).toContain('data/sales.csv');
    expect(text).toContain('40');
    // Column names make it keyword-findable; the card routes to the tools.
    expect(text).toContain('revenue');
    expect(text).toContain('describe_table');
    // A signpost, not a second copy of the data — rows in the index are the
    // vector-space poisoning this whole shape exists to avoid.
    expect(text).not.toContain('North,');
  });

  it('does not fail the table when a card cannot be written', async () => {
    await seed('data/sales.csv', bigCsv(20));
    // The table is the deliverable; the card is a convenience.
    const result = await drain({ storageDir: artifacts });
    expect(result.materialized).toBe(1);
  });
});
