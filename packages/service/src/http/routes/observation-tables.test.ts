import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactCorpus } from '../../observations/compactor.js';
import { DuckRunner } from '../../observations/duck.js';
import { findRealDuckdb, hasRealDuckdb } from '../../observations/testing/duck-fixture.js';
import { synthRequests, synthRequestsManifest } from '../../observations/testing/synth.js';
import { ObservationWriter } from '../../observations/writer.js';
import { type RunningService, startService } from '../../service.js';

const CORPUS = 'data/traffic';
let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorDuck = process.env.GEZEL_DUCKDB_BIN;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const real = findRealDuckdb();
  if (real) process.env.GEZEL_DUCKDB_BIN = real;
  home = await mkdtemp(join(tmpdir(), 'gezel-obs-routes-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  // Seed a corpus the way a connector sync would, then register the binding
  // so discovery can find it.
  const artifacts = svc.context.store.projectArtifactsDir('default');
  const writer = new ObservationWriter({
    storageDir: artifacts,
    corpusDir: CORPUS,
    manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
  });
  await writer.writeBatch({ table: 'requests', rows: synthRequests({ rows: 400, seed: 4, days: 3 }) });
  await writer.finish();
  if (real) {
    await compactCorpus({
      storageDir: artifacts,
      corpusDir: CORPUS,
      duck: new DuckRunner({ binaryPath: real }),
    });
  }
  await svc.context.store.updateProject('default', {
    connectors: [
      { id: 'b1', type: 'mock-traffic', displayName: 'Web traffic', corpusDir: CORPUS, config: {} },
    ],
  });
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorDuck === undefined) delete process.env.GEZEL_DUCKDB_BIN;
  else process.env.GEZEL_DUCKDB_BIN = priorDuck;
}, 30_000);

function api(path: string, body: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /:id/tools/list-tables', () => {
  it('lists the project observation tables with their stats', async () => {
    const res = await api('/api/projects/default/tools/list-tables', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: Record<string, unknown>[] };
    expect(body.tables).toHaveLength(1);
    expect(body.tables[0]).toMatchObject({
      table: 'requests',
      rows: 400,
      partitions: 3,
      origin: 'connector',
      source: 'Web traffic',
      schemaInferred: false,
    });
  });

  it('is an empty list, not an error, for a project with no corpus', async () => {
    await svc.context.store.createProject({ id: 'bare', name: 'Bare' } as never).catch(() => {});
    const res = await api('/api/projects/bare/tools/list-tables', {});
    expect(res.status).toBe(200);
    expect((await res.json()) as { tables: unknown[] }).toEqual({ tables: [] });
  });

  it('404s for a project that does not exist', async () => {
    const res = await api('/api/projects/nope/tools/list-tables', {});
    expect(res.status).toBe(404);
  });
});

describe('POST /:id/tools/describe-table', () => {
  it('returns the semantic layer as markdown', async () => {
    const res = await api('/api/projects/default/tools/describe-table', { table: 'requests' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { table: string; markdown: string };
    expect(body.table).toBe('requests');
    expect(body.markdown).toContain('Query it as `requests`');
    expect(body.markdown).toContain('Filter on `dt` whenever you can');
    expect(body.markdown).toContain('| `latency_ms` | DOUBLE | measure | unit: milliseconds |');
  });

  it('names the available tables when the requested one is unknown', async () => {
    const res = await api('/api/projects/default/tools/describe-table', { table: 'nope' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('table-not-found');
    expect(body.error).toContain('available: requests');
  });
});

describe.runIf(hasRealDuckdb())('POST /:id/tools/query-table', () => {
  it('answers an aggregate question', async () => {
    const res = await api('/api/projects/default/tools/query-table', {
      sql: 'SELECT route, count(*) AS requests FROM requests GROUP BY 1 ORDER BY requests DESC',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { route: string; requests: number }[];
      columns: string[];
      truncated: boolean;
      tablesInScope: string[];
    };
    expect(body.columns).toEqual(['route', 'requests']);
    expect(body.rows.reduce((n, r) => n + Number(r.requests), 0)).toBe(400);
    expect(body.truncated).toBe(false);
    expect(body.tablesInScope).toEqual(['requests']);
  });

  it('caps rows and says so', async () => {
    const res = await api('/api/projects/default/tools/query-table', {
      sql: 'SELECT * FROM requests',
      limit: 3,
    });
    const body = (await res.json()) as { rows: unknown[]; truncated: boolean; limit: number };
    expect(body.rows).toHaveLength(3);
    expect(body.truncated).toBe(true);
    expect(body.limit).toBe(3);
  });

  it('rejects a mutation with a 400 the caller can act on', async () => {
    const res = await api('/api/projects/default/tools/query-table', {
      sql: 'DELETE FROM requests',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('sql-rejected');
    expect(body.error).toMatch(/read-only/);
  });

  it('rejects a CTE that fronts a mutation', async () => {
    const res = await api('/api/projects/default/tools/query-table', {
      sql: 'WITH c AS (SELECT 1 AS v) INSERT INTO requests SELECT v FROM c',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('sql-rejected');
  });

  it('forwards the engine message so a model can repair its SQL', async () => {
    const res = await api('/api/projects/default/tools/query-table', {
      sql: 'SELECT rout FROM requests',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // DuckDB's binder suggests the right column; that suggestion is the whole
    // value of forwarding its text rather than replacing it with our own.
    expect(body.error).toMatch(/rout/i);
  });

  it('explains itself when the project has no tables', async () => {
    const res = await api('/api/projects/bare/tools/query-table', { sql: 'SELECT 1' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('no-observation-tables');
  });
});
