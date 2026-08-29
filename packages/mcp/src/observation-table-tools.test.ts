import { type Server as HttpServer, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three observation-table tools, driven over an in-memory transport
 * against a fake daemon. No subprocess, no service boot — this is the fast
 * loop for the tools' own behaviour: what they advertise, what text they
 * hand the model, and how they degrade.
 */

type RequestHandler = (
  url: URL,
  method: string,
  body: Record<string, unknown> | undefined,
) => unknown;

interface HttpFixtureResponse {
  __status: number;
  body: unknown;
}
function isFixture(value: unknown): value is HttpFixtureResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { __status?: unknown }).__status === 'number' &&
      'body' in value,
  );
}

let handler: RequestHandler;
let client: Client;
let httpServer: HttpServer;

const TABLE_SUMMARY = {
  table: 'requests',
  title: 'Front Door request log',
  grain: 'one row per HTTP request',
  rows: 4_312_889,
  columns: 8,
  partitions: 30,
  earliestPartition: '2026-07-06',
  latestPartition: '2026-08-04',
  binding: 'Web traffic',
  schemaInferred: false,
};

describe('observation table tools', () => {
  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      try {
        const result = handler(new URL(req.url ?? '/', 'http://127.0.0.1'), req.method ?? 'GET', body);
        res.writeHead(isFixture(result) ? result.__status : 200, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify(isFixture(result) ? result.body : result));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;

    vi.stubEnv('GEZEL_MCP_NO_MAIN', '1');
    vi.stubEnv('GEZEL_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('GEZEL_TOKEN', 'test-token');
    vi.stubEnv('GEZEL_AGENT_ID', 'ada');
    vi.stubEnv('GEZEL_PROJECT_ID', 'project-a');
    vi.stubEnv('GEZEL_HOME', '/tmp/gezel-observation-tools');
    // The gate the chat manager sets after probing for a tabular corpus.
    vi.stubEnv('GEZEL_TABLES_ENABLED', '1');

    const { server } = await import('./server.js');
    client = new Client({ name: 'obs-table-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  beforeEach(() => {
    handler = (url) => {
      throw new Error(`Unexpected request: ${url}`);
    };
  });

  it('advertises all three tools as read-only', async () => {
    const { tools } = await client.listTools();
    for (const name of ['list_tables', 'describe_table', 'query_table']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it("query_table's description steers toward aggregation and away from raw rows", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === 'query_table')?.description ?? '';
    // The whole scaling argument depends on the model aggregating in SQL
    // rather than selecting rows and reasoning over them.
    expect(description).toMatch(/aggregate/i);
    expect(description).toMatch(/partition/i);
    expect(description).toMatch(/read-only|cannot be modified/i);
  });

  it('list_tables reports each table with its size and time span', async () => {
    handler = (url) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/list-tables');
      return { tables: [TABLE_SUMMARY] };
    };
    const res = (await client.callTool({ name: 'list_tables', arguments: {} })) as unknown as {
      content: { text: string }[];
      structuredContent: { count: number; items: unknown[] };
    };
    expect(res.structuredContent.count).toBe(1);
    const text = res.content[0]?.text ?? '';
    expect(text).toContain('requests');
    expect(text).toContain('4,312,889 rows');
    expect(text).toContain('2026-07-06→2026-08-04');
    // The listing's job is to route the model to the grounding step.
    expect(text).toContain('describe_table');
  });

  it('list_tables explains an empty project rather than returning a bare zero', async () => {
    handler = () => ({ tables: [] });
    const res = (await client.callTool({ name: 'list_tables', arguments: {} })) as unknown as {
      structuredContent: { summary: string; count: number };
    };
    expect(res.structuredContent.count).toBe(0);
    expect(res.structuredContent.summary).toMatch(/no data tables/i);
  });

  it('describe_table hands the model the markdown schema verbatim', async () => {
    const markdown = '# Front Door request log\n\nQuery it as `requests`.\n\n## Columns\n';
    handler = (url, _method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/describe-table');
      expect(body).toEqual({ table: 'requests' });
      return { table: 'requests', markdown, summary: TABLE_SUMMARY };
    };
    const res = (await client.callTool({
      name: 'describe_table',
      arguments: { table: 'requests' },
    })) as unknown as { content: { text: string }[]; structuredContent: { rows: number } };
    expect(res.content[0]?.text).toBe(markdown);
    expect(res.structuredContent.rows).toBe(TABLE_SUMMARY.rows);
  });

  it('describe_table points at list_tables when the name is wrong', async () => {
    handler = () => ({
      __status: 404,
      body: { error: "no table named 'requsts'; available: requests", code: 'table-not-found' },
    });
    const res = (await client.callTool({
      name: 'describe_table',
      arguments: { table: 'requsts' },
    })) as unknown as { content: { text: string }[]; isError: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('available: requests');
    expect(res.content[0]?.text).toContain('list_tables');
  });

  it('query_table renders rows as a table the model can read', async () => {
    handler = (url, _method, body) => {
      expect(url.pathname).toBe('/api/projects/project-a/tools/query-table');
      expect(body).toMatchObject({ sql: 'SELECT route, count(*) AS n FROM requests GROUP BY 1' });
      return {
        rows: [
          { route: '/api/v1/search', n: 91_233 },
          { route: '/health', n: 4_001 },
        ],
        columns: ['route', 'n'],
        truncated: false,
        limit: 100,
        tablesInScope: ['requests'],
      };
    };
    const res = (await client.callTool({
      name: 'query_table',
      arguments: { sql: 'SELECT route, count(*) AS n FROM requests GROUP BY 1' },
    })) as unknown as { content: { text: string }[]; structuredContent: { count: number } };
    const text = res.content[0]?.text ?? '';
    expect(res.structuredContent.count).toBe(2);
    expect(text).toContain('| route | n |');
    expect(text).toContain('| /api/v1/search | 91233 |');
  });

  it('query_table says how to narrow when a result was capped', async () => {
    handler = () => ({
      rows: [{ a: 1 }],
      columns: ['a'],
      truncated: true,
      limit: 1,
      tablesInScope: ['requests'],
    });
    const res = (await client.callTool({
      name: 'query_table',
      arguments: { sql: 'SELECT * FROM requests', limit: 1 },
    })) as unknown as { content: { text: string }[] };
    const text = res.content[0]?.text ?? '';
    expect(text).toMatch(/Only the first 1 row\(s\)/);
    expect(text).toMatch(/Aggregate further|WHERE clause|raise `limit`/);
  });

  it('flattens and truncates a wide cell so one value cannot blow the turn', async () => {
    handler = () => ({
      rows: [{ blob: `${'x'.repeat(500)}\nsecond line`, pipe: 'a|b' }],
      columns: ['blob', 'pipe'],
      truncated: false,
      limit: 100,
      tablesInScope: ['requests'],
    });
    const res = (await client.callTool({
      name: 'query_table',
      arguments: { sql: 'SELECT blob, pipe FROM requests' },
    })) as unknown as { content: { text: string }[] };
    const text = res.content[0]?.text ?? '';
    expect(text).toContain('…');
    // A newline would break the markdown row; a bare pipe would break the column.
    const bodyRow = text.split('\n').find((l) => l.startsWith('| xxx')) ?? '';
    expect(bodyRow).not.toContain('second line\n');
    expect(text).toContain('a\\|b');
  });

  it('forwards the engine message on a rejected query so the model can repair it', async () => {
    handler = () => ({
      __status: 400,
      body: {
        error: 'query failed: Binder Error: Referenced column "rout" not found. Did you mean "route"?',
        code: 'duckdb-query-failed',
      },
    });
    const res = (await client.callTool({
      name: 'query_table',
      arguments: { sql: 'SELECT rout FROM requests' },
    })) as unknown as { content: { text: string }[]; isError: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('Did you mean "route"?');
    expect(res.content[0]?.text).toContain('describe_table');
  });

  it('reports a refused mutation as the caller error it is', async () => {
    handler = () => ({
      __status: 400,
      body: {
        error: '`DELETE` is not allowed here — this corpus is read-only; it mirrors an external source.',
        code: 'sql-rejected',
      },
    });
    const res = (await client.callTool({
      name: 'query_table',
      arguments: { sql: 'DELETE FROM requests' },
    })) as unknown as { content: { text: string }[]; isError: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/read-only/);
  });
});
