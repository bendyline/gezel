import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageTableInfo, ProjectTypePageReadScope } from '@bendyline/gezel';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { DuckRunner } from '../observations/duck.js';
import { findRealDuckdb, hasRealDuckdb } from '../observations/testing/duck-fixture.js';
import { tabularCorpusDir } from '../observations/workspace-tables.js';
import { ObservationWriter } from '../observations/writer.js';
import type { ServiceContext } from './context.js';
import { type PageTableDeps, readPageTables } from './page-tables.js';
import { pageTableRoutes } from './routes/page-tables.js';

let scopes: ProjectTypePageReadScope[] = [];
vi.mock('../project-type/script-tools.js', () => ({ resolvePageReads: async () => scopes }));
let home: string;
let deps: PageTableDeps;
let workspace: string;
const projectId = 'default';
const rows = [
  { category: 'North', amount: 10 },
  { category: 'South', amount: 20 },
  { category: 'North', amount: 5 },
];
async function seed(path: string, corpus = tabularCorpusDir(path)!) {
  await mkdir(deps.store.projectArtifactsDir(projectId), { recursive: true });
  await mkdir(join(workspace, 'data'), { recursive: true });
  await writeFile(join(workspace, path), 'category,amount\nNorth,10');
  const writer = new ObservationWriter({
    storageDir: deps.store.projectArtifactsDir(projectId),
    corpusDir: corpus,
    manifests: new Map([
      [
        'sales',
        {
          schemaVersion: 1,
          table: 'sales',
          columns: [
            { name: 'category', type: 'VARCHAR', role: 'dimension' },
            { name: 'amount', type: 'DOUBLE', role: 'measure' },
          ],
          measures: [],
          exemplars: [],
          rollups: [],
        },
      ],
    ]),
  });
  await writer.writeBatch({ table: 'sales', rows });
  await writer.finish();
}
const request = (body: Parameters<typeof readPageTables>[1]['request']) =>
  readPageTables(deps, { projectId, request: body });
const list = async () => (await request({ op: 'list' })).body.tables as PageTableInfo[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-page-tables-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  workspace = await store.projectWorkspaceDir(projectId);
  deps = {
    store,
    catalog: {} as PageTableDeps['catalog'],
    duck: new DuckRunner({ binaryPath: findRealDuckdb() ?? '/missing/duckdb' }),
  };
  scopes = [{ source: 'workspace', path: 'data/allowed.csv', subtree: false }];
  await seed('data/allowed.csv');
  await seed('data/secret.csv');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('page table permission boundary', () => {
  it('lists only allowed source files, with structured schema and stable names', async () => {
    const tables = await list();
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      path: 'data/allowed.csv',
      source: 'workspace',
      rows: 3,
      columnCount: 2,
    });
    const described = await request({ op: 'describe', table: tables[0]!.name });
    expect(described.body.columns).toMatchObject([
      { name: 'category', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ]);
    expect(JSON.stringify(described)).not.toContain('secret.csv');
    scopes.push({ source: 'workspace', path: 'data/secret.csv', subtree: false });
    expect((await list()).find((t) => t.path === 'data/allowed.csv')?.name).toBe(tables[0]!.name);
  });
  it('rechecks revoked scopes, deleted sources, and client-supplied table names', async () => {
    const table = (await list())[0]!;
    scopes = [];
    expect(await list()).toEqual([]);
    expect((await request({ op: 'describe', table: table.name })).status).toBe(403);
    expect((await request({ op: 'query', sql: 'SELECT 1', tables: [table.name] })).status).toBe(
      403,
    );
    scopes = [{ source: 'workspace', path: 'data/allowed.csv', subtree: false }];
    await rm(join(workspace, 'data/allowed.csv'));
    expect(await list()).toEqual([]);
    expect((await request({ op: 'query', sql: 'SELECT 1' })).status).toBe(503);
  });
  it('requires an artifact subtree grant for connector tables', async () => {
    await seed('connector.csv', 'data/connector');
    await deps.store.updateProject(projectId, {
      connectors: [{ id: 'feed', type: 'fixture', corpusDir: 'data/connector', config: {} }],
    });
    scopes = [{ source: 'artifacts', path: 'data/connector/tables/sales', subtree: false }];
    expect(await list()).toEqual([]);
    scopes[0]!.subtree = true;
    expect(await list()).toMatchObject([
      { source: 'artifacts', path: 'data/connector/tables/sales' },
    ]);
  });
  it('keeps table discovery available when the query engine is absent', async () => {
    deps.duck = new DuckRunner({ binaryPath: join(home, 'missing-duckdb') });
    const table = (await list())[0]!;
    expect((await request({ op: 'describe', table: table.name })).status).toBe(200);
    expect(await request({ op: 'query', sql: 'SELECT 1' })).toMatchObject({
      status: 503,
      body: { errorCode: 'unavailable' },
    });
  });
  it('caps concurrent requests and releases slots after completion', async () => {
    const getProject = deps.store.getProject.bind(deps.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(deps.store, 'getProject').mockImplementation(async (id) => {
      await gate;
      return getProject(id);
    });
    const first = request({ op: 'list' });
    const second = request({ op: 'list' });
    expect((await request({ op: 'list' })).status).toBe(429);
    release();
    await Promise.all([first, second]);
    spy.mockRestore();
    expect((await request({ op: 'list' })).status).toBe(200);
  });
  it('does not follow a derived corpus redirected to a denied table', async () => {
    const root = deps.store.projectArtifactsDir(projectId);
    const allowed = join(root, tabularCorpusDir('data/allowed.csv')!, 'tables/sales');
    const denied = join(root, tabularCorpusDir('data/secret.csv')!, 'tables/sales');
    await rm(allowed, { recursive: true });
    await symlink(denied, allowed, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await list()).toEqual([]);
  });
  it('requires first-party auth and rejects malformed requests at the HTTP boundary', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (c.req.header('x-scopes'))
        c.set('auth', { scopes: c.req.header('x-scopes')!.split(',') } as never);
      await next();
    });
    app.route('/api/projects', pageTableRoutes(deps as ServiceContext));
    const call = (scopes?: string, body: unknown = { op: 'list' }) =>
      app.request('/api/projects/default/page-tables', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(scopes ? { 'x-scopes': scopes } : {}) },
        body: JSON.stringify(body),
      });
    expect((await call()).status).toBe(401);
    expect((await call('session')).status).toBe(403);
    expect((await call('ui')).status).toBe(200);
    expect(
      (await call('ui', { op: 'query', sql: 'SELECT 1', tables: [], projectId: 'other' })).status,
    ).toBe(400);
  });
});

describe.runIf(hasRealDuckdb())('page queries with real DuckDB', () => {
  it('aggregates and caps rows without exposing denied tables or files', async () => {
    const table = (await list())[0]!;
    const query = (sql: string, limit = 100) =>
      request({ op: 'query', sql, tables: [table.name], limit });
    expect(
      (
        await query(
          `SELECT category, sum(amount) AS total FROM "${table.name}" GROUP BY category ORDER BY category`,
        )
      ).body.rows,
    ).toEqual([
      { category: 'North', total: 15 },
      { category: 'South', total: 20 },
    ]);
    expect((await query(`SELECT * FROM "${table.name}"`, 1)).body).toMatchObject({
      truncated: true,
      limit: 1,
    });
    const secret = join(workspace, 'data/secret.csv').replaceAll('\\', '/').replaceAll("'", "''");
    expect((await query(`SELECT * FROM read_csv('${secret}')`)).status).toBe(400);
    expect((await query('SELECT * FROM sales')).status).toBe(400);
    scopes.push({ source: 'workspace', path: 'data/secret.csv', subtree: false });
    const other = (await list()).find((item) => item.path === 'data/secret.csv')!;
    expect((await query(`SELECT * FROM "${other.name}"`)).status).toBe(400);
    scopes.pop();
    expect((await query(`DELETE FROM "${table.name}"`)).status).toBe(400);
    expect((await query('SELECT 1; SELECT 2')).status).toBe(400);
    expect((await query("SELECT repeat('x', 1100000) AS huge")).status).toBe(413);
    const alias = join(
      deps.store.projectArtifactsDir(projectId),
      tabularCorpusDir('data/allowed.csv')!,
      'tables/sales/redirect',
    );
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const redirected = join(alias, 'data/secret.csv').replaceAll('\\', '/').replaceAll("'", "''");
    expect((await query(`SELECT * FROM read_csv('${redirected}')`)).status).toBe(400);
  });
});
