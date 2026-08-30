import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { compactCorpus } from './compactor.js';
import { DuckRunner } from './duck.js';
import {
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  NoTablesError,
  findTable,
  hasObservationTables,
  listProjectTables,
  renderTableDescription,
  runQuery,
  summarizeTable,
} from './query.js';
import { SqlRejectedError } from './statement-guard.js';
import { findRealDuckdb, hasRealDuckdb } from './testing/duck-fixture.js';
import { expectedRouteStats, synthRequests, synthRequestsManifest } from './testing/synth.js';
import { ObservationWriter } from './writer.js';

let artifacts: string;
let duck: DuckRunner;

const PROJECT = {
  id: 'p1',
  connectors: [
    { id: 'b1', type: 'mock-traffic', displayName: 'Web traffic', corpusDir: 'data/traffic' },
  ],
};

function makeStore(): Store {
  return {
    projectArtifactsDir: () => artifacts,
    getProject: async () => PROJECT,
  } as unknown as Store;
}

async function seed(rows = 500, opts?: { compact?: boolean; days?: number }) {
  const writer = new ObservationWriter({
    storageDir: artifacts,
    corpusDir: 'data/traffic',
    manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
  });
  const generated = synthRequests({ rows, seed: 3, days: opts?.days ?? 3 });
  await writer.writeBatch({ table: 'requests', rows: generated });
  await writer.finish();
  if (opts?.compact) {
    await compactCorpus({ storageDir: artifacts, corpusDir: 'data/traffic', duck });
  }
  return generated;
}

beforeEach(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'gezel-obsq-'));
  duck = new DuckRunner({ binaryPath: findRealDuckdb() ?? '/nonexistent/duckdb' });
});
afterEach(async () => {
  await rm(artifacts, { recursive: true, force: true }).catch(() => {});
});

describe('table discovery', () => {
  it('finds tables through the corpus on disk, not the catalog', async () => {
    await seed(50);
    const tables = await listProjectTables(makeStore(), PROJECT);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      table: 'requests',
      queryName: 'requests',
      source: 'connector',
      bindingId: 'b1',
      sourceLabel: 'Web traffic',
    });
    expect(tables[0]?.state.totalRows).toBe(50);
    expect(tables[0]?.partitions.length).toBeGreaterThan(0);
  });

  it('is empty for a project with no corpus', async () => {
    expect(await listProjectTables(makeStore(), { id: 'p1', connectors: [] })).toEqual([]);
  });

  it('qualifies only the names that actually collide', async () => {
    await seed(10);
    const second = new ObservationWriter({
      storageDir: artifacts,
      corpusDir: 'data/cdn',
      manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
    });
    await second.writeBatch({ table: 'requests', rows: synthRequests({ rows: 10 }) });
    await second.writeBatch({
      table: 'errors',
      rows: [{ ts: '2026-08-01T00:00:00Z', route: '/a' }],
    });
    await second.finish();

    const tables = await listProjectTables(makeStore(), {
      id: 'p1',
      connectors: [
        ...PROJECT.connectors,
        { id: 'b2', type: 'mock-cdn', displayName: 'CDN', corpusDir: 'data/cdn' },
      ],
    });
    const names = tables.map((t) => t.queryName).sort();
    // Both `requests` tables get qualified; the unique `errors` keeps its
    // short name, because qualifying it would be noise.
    expect(names).toEqual(['cdn_requests', 'errors', 'traffic_requests']);
  });

  it('resolves a table by either its query name or its bare table name', async () => {
    await seed(10);
    const tables = await listProjectTables(makeStore(), PROJECT);
    expect(findTable(tables, 'requests')?.table).toBe('requests');
    expect(findTable(tables, 'REQUESTS')?.table).toBe('requests');
    expect(findTable(tables, 'nope')).toBeNull();
  });
});

describe('describe_table rendering', () => {
  it('leads with identity and the partition hint, and ends with examples', async () => {
    await seed(120, { days: 2 });
    const [ref] = await listProjectTables(makeStore(), PROJECT);
    const manifest = { ...(ref as NonNullable<typeof ref>).manifest };
    manifest.exemplars = [{ question: 'busiest route', sql: 'SELECT route FROM requests' }];
    manifest.measures = [
      { name: 'p95_latency', sql: 'quantile_cont(latency_ms, 0.95)', unit: 'milliseconds' },
    ];
    const md = renderTableDescription({ ...(ref as NonNullable<typeof ref>), manifest });

    expect(md).toContain('Query it as `requests`');
    expect(md).toContain('**One row is:** one row per HTTP request');
    expect(md).toContain('**Rows:** 120');
    // The partition hint is the single most useful thing in the document.
    expect(md).toContain('Filter on `dt` whenever you can');
    expect(md).toContain('| `latency_ms` | DOUBLE | measure | unit: milliseconds |');
    expect(md).toContain('p95_latency');
    expect(md.indexOf('## Example queries')).toBeGreaterThan(md.indexOf('## Columns'));
  });

  it('says plainly when a schema was inferred rather than authored', async () => {
    const writer = new ObservationWriter({ storageDir: artifacts, corpusDir: 'data/traffic' });
    await writer.writeBatch({
      table: 'guessed',
      rows: [{ when: '2026-08-01T00:00:00Z', n: 1 }],
    });
    await writer.finish();
    const tables = await listProjectTables(makeStore(), PROJECT);
    const ref = findTable(tables, 'guessed');
    expect(renderTableDescription(ref as NonNullable<typeof ref>)).toMatch(
      /inferred from the data/,
    );
  });

  it('summarizes a table for the listing tool', async () => {
    await seed(75, { days: 3 });
    const [ref] = await listProjectTables(makeStore(), PROJECT);
    expect(summarizeTable(ref as NonNullable<typeof ref>)).toMatchObject({
      table: 'requests',
      rows: 75,
      partitions: 3,
      origin: 'connector',
      source: 'Web traffic',
      schemaInferred: false,
    });
  });
});

describe.runIf(hasRealDuckdb())('runQuery (real engine)', () => {
  it('answers an aggregate over uncompacted NDJSON — fresh data is queryable at once', async () => {
    const rows = await seed(600, { days: 3 });
    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT route, count(*) AS requests FROM requests GROUP BY 1 ORDER BY 1',
    });

    const truth = expectedRouteStats(rows);
    expect(result.rows).toHaveLength(truth.size);
    for (const row of result.rows) {
      expect(Number(row.requests)).toBe(truth.get(String(row.route))?.requests);
    }
    expect(result.truncated).toBe(false);
    expect(result.tablesInScope).toEqual(['requests']);
  });

  it('gives the same answer once the parts are Parquet', async () => {
    const rows = await seed(600, { days: 3, compact: true });
    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT count(*) AS n FROM requests',
    });
    expect(Number(result.rows[0]?.n)).toBe(rows.length);
  });

  it('reads Parquet and not-yet-compacted NDJSON as one table', async () => {
    await seed(300, { days: 2, compact: true });
    // A second sync lands after compaction, so the table now spans both forms.
    const writer = new ObservationWriter({
      storageDir: artifacts,
      corpusDir: 'data/traffic',
      manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
    });
    await writer.writeBatch({
      table: 'requests',
      rows: synthRequests({ rows: 120, seed: 99, days: 2 }),
    });
    await writer.finish();

    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT count(*) AS n FROM requests',
    });
    expect(Number(result.rows[0]?.n)).toBe(420);
  });

  it('caps rows and reports that it did', async () => {
    await seed(400, { days: 1 });
    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT * FROM requests',
      limit: 5,
    });
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.columns).toContain('route');
  });

  it('clamps an absurd limit instead of honouring it', async () => {
    await seed(20, { days: 1 });
    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT * FROM requests',
      limit: 10_000_000,
    });
    expect(result.limit).toBe(MAX_ROW_LIMIT);
    expect(result.truncated).toBe(false);
  });

  it('defaults the limit when the caller names none', async () => {
    await seed(300, { days: 1 });
    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT * FROM requests',
    });
    expect(result.limit).toBe(DEFAULT_ROW_LIMIT);
    expect(result.rows).toHaveLength(DEFAULT_ROW_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it('returns no rows — not an error — for a table with no data yet', async () => {
    const writer = new ObservationWriter({
      storageDir: artifacts,
      corpusDir: 'data/traffic',
      manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
    });
    // A table that exists on disk but never received a row.
    await writer.writeBatch({ table: 'requests', rows: [] });
    await writer.finish();

    const result = await runQuery({ store: makeStore(), duck }, PROJECT, {
      sql: 'SELECT count(*) AS n FROM requests',
    });
    expect(Number(result.rows[0]?.n)).toBe(0);
  });

  it('refuses a mutation fronted by a CTE, even though it starts with WITH', async () => {
    await seed(10, { days: 1 });
    await expect(
      runQuery({ store: makeStore(), duck }, PROJECT, {
        sql: 'WITH c AS (SELECT 1 AS v) INSERT INTO requests SELECT v FROM c',
      }),
    ).rejects.toBeInstanceOf(SqlRejectedError);
  });

  it('refuses the wrapper injection before assembling anything around it', async () => {
    await seed(10, { days: 1 });
    await expect(
      runQuery({ store: makeStore(), duck }, PROJECT, {
        sql: "SELECT 1) ; ATTACH '/tmp/gezel-query-injection.db' AS w; SELECT * FROM (SELECT 1",
      }),
    ).rejects.toBeInstanceOf(SqlRejectedError);
  });

  it('explains itself when the project has no tables', async () => {
    await expect(
      runQuery({ store: makeStore(), duck }, { id: 'p1', connectors: [] }, { sql: 'SELECT 1' }),
    ).rejects.toBeInstanceOf(NoTablesError);
  });

  it('names the available tables when the requested one does not exist', async () => {
    await seed(10, { days: 1 });
    await expect(
      runQuery({ store: makeStore(), duck }, PROJECT, {
        sql: 'SELECT 1',
        tables: ['nonexistent'],
      }),
    ).rejects.toThrow(/available: requests/);
  });
});

/**
 * Workspace tables come from a file in the project rather than a connector
 * sync. They must be visible to exactly the same tools, so a gezel asks one
 * question ("what tables are here?") rather than learning two vocabularies.
 */
describe('workspace-derived tables', () => {
  async function seedWorkspaceTable(fileRel: string, table: string, rows = 12) {
    const corpusDir = `tabular/${fileRel}_tables`;
    const writer = new ObservationWriter({
      storageDir: artifacts,
      corpusDir,
      manifests: new Map([[table, synthRequestsManifest(table) as never]]),
    });
    await writer.writeBatch({ table, rows: synthRequests({ rows, days: 1 }) });
    await writer.finish();
    return corpusDir;
  }

  it('are found for a project with no connectors at all', async () => {
    await seedWorkspaceTable('data/sales.csv', 'sales');
    // The case the old early-return made impossible.
    const tables = await listProjectTables(makeStore(), { id: 'p1', connectors: [] });
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      source: 'workspace',
      table: 'sales',
      queryName: 'sales',
      sourceLabel: 'data/sales.csv',
    });
    expect(tables[0]?.bindingId).toBeUndefined();
  });

  it('appear alongside connector tables in one list', async () => {
    await seed(30);
    await seedWorkspaceTable('data/sales.csv', 'sales');
    const tables = await listProjectTables(makeStore(), PROJECT);
    expect(tables.map((t) => [t.queryName, t.source]).sort()).toEqual([
      ['requests', 'connector'],
      ['sales', 'workspace'],
    ]);
  });

  it('qualify only when a name actually collides across sources', async () => {
    await seed(30);
    await seedWorkspaceTable('data/requests.csv', 'requests');
    const names = (await listProjectTables(makeStore(), PROJECT)).map((t) => t.queryName).sort();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it('flip the existence probe on their own', async () => {
    const empty = { id: 'p1', connectors: [] };
    expect(await hasObservationTables(makeStore(), empty)).toBe(false);
    await seedWorkspaceTable('data/sales.csv', 'sales');
    expect(await hasObservationTables(makeStore(), empty)).toBe(true);
  });

  it('name their source file, which is what a user asks about', async () => {
    await seedWorkspaceTable('reports/Q3 figures.csv', 'q3');
    const [ref] = await listProjectTables(makeStore(), { id: 'p1', connectors: [] });
    const md = renderTableDescription(ref as NonNullable<typeof ref>);
    expect(md).toContain('reports/Q3 figures.csv');
    expect(md).toMatch(/Built from the file/);

    expect(summarizeTable(ref as NonNullable<typeof ref>)).toMatchObject({
      origin: 'workspace',
      source: 'reports/Q3 figures.csv',
    });
  });

  it('explains both routes when a project has no tables at all', async () => {
    const err = await runQuery(
      { store: makeStore(), duck },
      { id: 'p1' },
      { sql: 'SELECT 1' },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(NoTablesError);
    expect((err as Error).message).toMatch(/connector/);
    expect((err as Error).message).toMatch(/workspace/);
  });
});
