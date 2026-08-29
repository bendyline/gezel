import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import { isObservationRecord } from '../types.js';
import {
  AzureMonitorLogsAdapter,
  type AzureMonitorLogsRuntime,
  columnsFromKusto,
  escapeKqlDatetime,
  kustoTypeToColumnType,
  parseConfig,
  toColumnName,
} from './azure-monitor-logs.js';

/**
 * A redacted Log Analytics response, in the column-oriented shape Azure
 * actually returns: a typed `columns` list and positional `rows`. That typing
 * is the whole reason this adapter is native rather than a manifest — it
 * yields a real schema instead of one guessed from a sample.
 */
const RESPONSE = {
  tables: [
    {
      name: 'PrimaryResult',
      columns: [
        { name: 'TimeGenerated', type: 'datetime' },
        { name: 'RequestUri', type: 'string' },
        { name: 'HttpStatusCode', type: 'long' },
        { name: 'TimeTaken', type: 'real' },
        { name: 'IsCached', type: 'bool' },
        { name: 'Properties', type: 'dynamic' },
      ],
      rows: [
        ['2026-08-04T10:00:00.000Z', '/api/orders', 200, 12.5, true, { region: 'weu' }],
        ['2026-08-04T10:00:05.000Z', '/health', 200, 1.25, false, null],
        ['2026-08-05T02:00:00.000Z', '/api/orders', 500, 903.1, false, { region: 'neu' }],
      ],
    },
  ],
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function harness(
  handler: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> },
  config: Record<string, unknown> = {},
) {
  const calls: Call[] = [];
  const runtime: AzureMonitorLogsRuntime = {
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      const call = { url: String(input), headers, body: String(init?.body ?? '') };
      calls.push(call);
      const res = handler(call);
      return new Response(
        res.body === undefined ? '' : JSON.stringify(res.body),
        { status: res.status ?? 200, headers: res.headers ?? {} },
      );
    },
  };
  const adapter = new AzureMonitorLogsAdapter(
    {
      id: 'azure-monitor-logs:abcd',
      type: 'azure-monitor-logs',
      config: {
        workspaceId: 'ws-1234',
        kqlTable: 'AzureDiagnostics',
        timeColumn: 'TimeGenerated',
        ...config,
      },
    },
    {
      projectId: 'p1',
      store: {} as Store,
      secrets: { get: async () => 'secret-azure-token' } as unknown as SecretStore,
    },
    runtime,
  );
  return { adapter, calls };
}

describe('config parsing', () => {
  it('rejects a table or column name that is not a Kusto identifier', () => {
    // These are interpolated into the query, so they are constrained rather
    // than trusted. A filter clause is arbitrary KQL by design and is not.
    expect(() => parseConfig({ workspaceId: 'w', kqlTable: 'Bad Name' })).toThrow(/not a valid table/);
    expect(() =>
      parseConfig({ workspaceId: 'w', kqlTable: 'T', timeColumn: 'a; drop' }),
    ).toThrow(/not a valid column/);
  });

  it('refuses a non-HTTPS endpoint — the token is a bearer credential', () => {
    expect(() =>
      parseConfig({ workspaceId: 'w', kqlTable: 'T', apiBaseUrl: 'http://logs.internal' }),
    ).toThrow(/must use HTTPS/);
  });

  it('requires a workspace and a table', () => {
    expect(() => parseConfig({})).toThrow(/workspace ID is required/);
    expect(() => parseConfig({ workspaceId: 'w' })).toThrow(/table name is required/);
  });

  it('clamps the page size and backfill window', () => {
    const wide = parseConfig({ workspaceId: 'w', kqlTable: 'T', pageRows: 10_000_000, backfillDays: 9_999 });
    expect(wide.pageRows).toBeLessThanOrEqual(50_000);
    expect(wide.backfillDays).toBeLessThanOrEqual(365);
  });

  it('refuses to build a query from a non-ISO timestamp', () => {
    expect(() => escapeKqlDatetime("2026-01-01') | evil //")).toThrow(/non-ISO timestamp/);
    expect(escapeKqlDatetime('2026-08-04T10:00:00.000Z')).toBe('2026-08-04T10:00:00.000Z');
  });
});

describe('schema derived from Azure column types', () => {
  it.each([
    ['datetime', 'TIMESTAMP'],
    ['bool', 'BOOLEAN'],
    ['long', 'BIGINT'],
    ['int', 'BIGINT'],
    ['real', 'DOUBLE'],
    ['dynamic', 'JSON'],
    ['string', 'VARCHAR'],
    ['timespan', 'VARCHAR'],
    ['something_new', 'VARCHAR'],
  ])('maps kusto %s to %s', (kusto, expected) => {
    expect(kustoTypeToColumnType(kusto)).toBe(expected);
  });

  it('normalizes PascalCase Azure names to snake_case columns', () => {
    expect(toColumnName('TimeGenerated')).toBe('time_generated');
    expect(toColumnName('HttpStatusCode')).toBe('http_status_code');
    expect(toColumnName('_ResourceId')).toBe('resource_id');
  });

  it('builds a typed column list and adds the synthesized partition column', () => {
    const columns = columnsFromKusto(RESPONSE.tables[0] as never, 'TimeGenerated', 'dt');
    expect(columns.find((c) => c.name === 'time_generated')).toMatchObject({
      type: 'TIMESTAMP',
      role: 'time',
    });
    expect(columns.find((c) => c.name === 'time_taken')).toMatchObject({
      type: 'DOUBLE',
      role: 'measure',
    });
    expect(columns.find((c) => c.name === 'properties')?.type).toBe('JSON');
    // The writer synthesizes `dt`, so Azure never reports it — but it must be
    // declared or the compactor drops it from the Parquet.
    expect(columns.find((c) => c.name === 'dt')).toMatchObject({ type: 'VARCHAR' });
  });
});

describe('AzureMonitorLogsAdapter', () => {
  it('builds a bounded, oldest-first, watermark-filtered KQL query', async () => {
    const { adapter, calls } = harness(() => ({ body: RESPONSE }));
    await adapter.ensureAuth();
    await adapter.listChangesSince('', { watermark: '2026-08-04T00:00:00.000Z' });

    const body = JSON.parse(calls[0]!.body) as { query: string };
    expect(body.query).toContain('AzureDiagnostics');
    expect(body.query).toContain('where TimeGenerated > datetime(2026-08-04T00:00:00.000Z)');
    // Oldest-first plus a bounded take is what makes time-paging deterministic.
    expect(body.query).toContain('sort by TimeGenerated asc');
    expect(body.query).toMatch(/take \d+/);
    expect(calls[0]!.url).toContain('/v1/workspaces/ws-1234/query');
  });

  it('sends the token as a bearer header and nowhere else', async () => {
    const { adapter, calls } = harness(() => ({ body: RESPONSE }));
    await adapter.ensureAuth();
    await adapter.listChangesSince('', undefined);
    expect(calls[0]!.headers.authorization).toBe('Bearer secret-azure-token');
    // Never in the URL or the query body, where it would reach logs.
    expect(calls[0]!.url).not.toContain('secret-azure-token');
    expect(calls[0]!.body).not.toContain('secret-azure-token');
  });

  it('appends a user filter clause without disturbing the ordering', async () => {
    const { adapter, calls } = harness(() => ({ body: RESPONSE }), {
      filter: '| where ResultType != "Success"',
    });
    await adapter.ensureAuth();
    await adapter.listChangesSince('', undefined);
    const query = (JSON.parse(calls[0]!.body) as { query: string }).query;
    expect(query).toContain('| where ResultType != "Success"');
    expect(query.indexOf('ResultType')).toBeLessThan(query.indexOf('sort by'));
  });

  it('turns column-oriented rows into row objects with our column names', async () => {
    const { adapter } = harness(() => ({ body: RESPONSE }));
    await adapter.ensureAuth();
    const listed = await adapter.listChangesSince('', undefined);
    expect(listed.records).toHaveLength(1);

    const record = await adapter.fetchRecord('', listed.records[0]!);
    expect(isObservationRecord(record)).toBe(true);
    if (!isObservationRecord(record)) throw new Error('unreachable');
    const [batch] = record.batches;
    expect(batch?.table).toBe('azure_diagnostics');
    expect(batch?.rows).toHaveLength(3);
    expect(batch?.rows[0]).toEqual({
      time_generated: '2026-08-04T10:00:00.000Z',
      request_uri: '/api/orders',
      http_status_code: 200,
      time_taken: 12.5,
      is_cached: true,
      // `dynamic` is normalized to text so the JSON column stores one shape,
      // whichever way the API version returned it.
      properties: '{"region":"weu"}',
    });
    expect(batch?.rows[1]?.properties).toBeNull();
  });

  it('advances the watermark to the newest row it actually read', async () => {
    const { adapter } = harness(() => ({ body: RESPONSE }));
    await adapter.ensureAuth();
    const listed = await adapter.listChangesSince('', undefined);
    expect(listed.cursor).toEqual({ watermark: '2026-08-05T02:00:00.000Z' });
  });

  it('holds the watermark when nothing new came back', async () => {
    const { adapter } = harness(() => ({ body: { tables: [] } }));
    await adapter.ensureAuth();
    const listed = await adapter.listChangesSince('', { watermark: '2026-08-01T00:00:00.000Z' });
    expect(listed.records).toEqual([]);
    // Advancing past a window we never read would skip late-arriving rows.
    expect(listed.cursor).toEqual({ watermark: '2026-08-01T00:00:00.000Z' });
  });

  it('splits a multi-table response into one batch per table', async () => {
    const twoTables = {
      tables: [
        RESPONSE.tables[0],
        {
          name: 'AppExceptions',
          columns: [
            { name: 'TimeGenerated', type: 'datetime' },
            { name: 'Message', type: 'string' },
          ],
          rows: [['2026-08-04T11:00:00.000Z', 'boom']],
        },
      ],
    };
    const { adapter } = harness(() => ({ body: twoTables }));
    await adapter.ensureAuth();
    const listed = await adapter.listChangesSince('', undefined);
    const record = await adapter.fetchRecord('', listed.records[0]!);
    if (!isObservationRecord(record)) throw new Error('unreachable');
    expect(record.batches.map((b) => b.table).sort()).toEqual(['app_exceptions', 'azure_diagnostics']);
  });

  it('reports a throttle as a signal rather than failing the pass', async () => {
    const { adapter } = harness(() => ({ status: 429, headers: { 'retry-after': '30' }, body: {} }));
    await adapter.ensureAuth();
    const listed = await adapter.listChangesSince('', { watermark: '2026-08-01T00:00:00.000Z' });
    // A throw would void the batch and re-read the same window next tick,
    // which is how a throttled API gets hammered.
    expect(listed.rateLimited).toBe(true);
    expect(listed.cursor).toEqual({ watermark: '2026-08-01T00:00:00.000Z' });
  });

  it('flags a full page as partial so the engine keeps reading this window', async () => {
    const short = harness(() => ({ body: RESPONSE }), { pageRows: 100 });
    await short.adapter.ensureAuth();
    // Three rows against a 100-row page: the window is drained, so no
    // continuation round is needed this tick.
    expect((await short.adapter.listChangesSince('', undefined)).partial).toBeUndefined();

    // A page that came back exactly full almost certainly has more behind it.
    const template = RESPONSE.tables[0]!;
    const fullPage = {
      tables: [
        {
          ...template,
          rows: Array.from({ length: 100 }, (_, i) => [
            `2026-08-04T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
            '/api/orders',
            200,
            1,
            false,
            null,
          ]),
        },
      ],
    };
    const full = harness(() => ({ body: fullPage }), { pageRows: 100 });
    await full.adapter.ensureAuth();
    expect((await full.adapter.listChangesSince('', undefined)).partial).toBe(true);
  });

  it('fails loudly when no row carries the configured time column', async () => {
    const mistyped = {
      tables: [
        {
          name: 'PrimaryResult',
          columns: [{ name: 'SomethingElse', type: 'string' }],
          rows: [['x']],
        },
      ],
    };
    const { adapter } = harness(() => ({ body: mistyped }));
    await adapter.ensureAuth();
    // A watermark that cannot advance re-reads the same window forever; a
    // clear error beats syncing in a silent loop.
    await expect(adapter.listChangesSince('', undefined)).rejects.toThrow(/cannot advance/);
  });

  it('surfaces an API error with the response body', async () => {
    const { adapter } = harness(() => ({ status: 400, body: { error: { message: 'Bad KQL' } } }));
    await adapter.ensureAuth();
    await expect(adapter.listChangesSince('', undefined)).rejects.toThrow(/400/);
  });

  it('refuses to run without a stored token', async () => {
    const adapter = new AzureMonitorLogsAdapter(
      { id: 'b', type: 'azure-monitor-logs', config: { workspaceId: 'w', kqlTable: 'T' } },
      {
        projectId: 'p1',
        store: {} as Store,
        secrets: { get: async () => null } as unknown as SecretStore,
      },
      { fetch: async () => new Response('{}') },
    );
    await expect(adapter.ensureAuth()).rejects.toThrow(/no access token/);
  });
});
