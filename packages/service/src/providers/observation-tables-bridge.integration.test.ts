import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactCorpus } from '../observations/compactor.js';
import { DuckRunner } from '../observations/duck.js';
import { findRealDuckdb, hasRealDuckdb } from '../observations/testing/duck-fixture.js';
import {
  expectedRouteStats,
  synthRequests,
  synthRequestsManifest,
} from '../observations/testing/synth.js';
import { ObservationWriter } from '../observations/writer.js';
import { type RunningService, startService } from '../service.js';
import { McpBridge } from './mcp-bridge.js';

/**
 * The whole path, as a gezel actually walks it: a real gezel-mcp subprocess,
 * a real daemon, a real corpus on disk, and a real DuckDB. Everything the
 * narrower suites stub is live here — this is the test that would catch a
 * broken env gate, a route that never got mounted, or a client method whose
 * path drifted from its route.
 */

const require = createRequire(import.meta.url);
const CORPUS = 'data/traffic';

let svc: RunningService;
let bridge: McpBridge;
let home: string;
let rows: ReturnType<typeof synthRequests>;
const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorDuck = process.env.GEZEL_DUCKDB_BIN;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const real = findRealDuckdb();
  if (real) process.env.GEZEL_DUCKDB_BIN = real;

  home = await mkdtemp(join(tmpdir(), 'gezel-obs-bridge-'));
  svc = await startService({ home });
  const baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;

  const artifacts = svc.context.store.projectArtifactsDir('default');
  const writer = new ObservationWriter({
    storageDir: artifacts,
    corpusDir: CORPUS,
    manifests: new Map([['requests', synthRequestsManifest('requests') as never]]),
  });
  rows = synthRequests({ rows: 900, seed: 17, days: 3 });
  await writer.writeBatch({ table: 'requests', rows });
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

  bridge = new McpBridge();
  const env: Record<string, string> = {
    GEZEL_BASE_URL: baseUrl,
    GEZEL_TOKEN: svc.context.token,
    GEZEL_AGENT_ID: 'ada',
    GEZEL_PROJECT_ID: 'default',
    GEZEL_HOME: svc.context.home,
    // What the chat manager sets after its directory probe finds a table.
    GEZEL_TABLES_ENABLED: '1',
  };
  if (svc.cert) env.GEZEL_CERT_PATH = gezelPaths(svc.context.home).runtime.cert;
  await bridge.start({
    command: 'node',
    args: [require.resolve('@bendyline/gezel-mcp/dist/server.js')],
    env,
  });
}, 60_000);

afterAll(async () => {
  await bridge?.stop();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorDuck === undefined) delete process.env.GEZEL_DUCKDB_BIN;
  else process.env.GEZEL_DUCKDB_BIN = priorDuck;
}, 30_000);

describe('observation tables over a live MCP bridge', () => {
  it('registers the three tools when the project has a tabular corpus', () => {
    for (const name of ['list_tables', 'describe_table', 'query_table']) {
      expect(bridge.hasTool(name), name).toBe(true);
    }
  });

  it('list_tables reaches the daemon and reports the real corpus', async () => {
    const text = await bridge.callTool('list_tables', {});
    expect(text).toContain('requests');
    expect(text).toContain('900 rows');
    expect(text).toContain('describe_table');
  });

  it('describe_table returns the schema a model needs before writing SQL', async () => {
    const text = await bridge.callTool('describe_table', { table: 'requests' });
    expect(text).toContain('Query it as `requests`');
    expect(text).toContain('`latency_ms`');
    expect(text).toContain('milliseconds');
    expect(text).toContain('Filter on `dt`');
  });

  it.runIf(hasRealDuckdb())('query_table answers with the numbers computed in JS', async () => {
    const text = await bridge.callTool('query_table', {
      sql: 'SELECT route, count(*) AS n FROM requests GROUP BY 1 ORDER BY route',
    });
    const truth = expectedRouteStats(rows);
    for (const [route, stats] of truth) {
      expect(text, route).toContain(`| ${route} | ${stats.requests} |`);
    }
  });

  it.runIf(hasRealDuckdb())('query_table refuses a mutation and says why', async () => {
    const text = await bridge.callTool('query_table', { sql: 'DELETE FROM requests' });
    expect(text).toMatch(/read-only/);
  });

  it.runIf(hasRealDuckdb())('query_table refuses a CTE that fronts a mutation', async () => {
    const text = await bridge.callTool('query_table', {
      sql: 'WITH c AS (SELECT 1 AS v) INSERT INTO requests SELECT v FROM c',
    });
    expect(text).toMatch(/rejected|read-only|not allowed/i);
  });
});

/**
 * The other half of the gate: a project with no tabular corpus must not carry
 * these tools in its prompt at all.
 */
describe('the tools are absent without the gate', () => {
  it('does not register them when GEZEL_TABLES_ENABLED is unset', async () => {
    const plain = new McpBridge();
    const env: Record<string, string> = {
      GEZEL_BASE_URL: `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`,
      GEZEL_TOKEN: svc.context.token,
      GEZEL_AGENT_ID: 'ada',
      GEZEL_PROJECT_ID: 'default',
      GEZEL_HOME: svc.context.home,
    };
    if (svc.cert) env.GEZEL_CERT_PATH = gezelPaths(svc.context.home).runtime.cert;
    await plain.start({
      command: 'node',
      args: [require.resolve('@bendyline/gezel-mcp/dist/server.js')],
      env,
    });
    try {
      for (const name of ['list_tables', 'describe_table', 'query_table']) {
        expect(plain.hasTool(name), name).toBe(false);
      }
      // And a tool every session has is still there, so this is a real
      // negative rather than a bridge that failed to start.
      expect(plain.hasTool('read_artifact')).toBe(true);
    } finally {
      await plain.stop();
    }
  }, 30_000);
});
