import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { RunScriptOptions, ScriptRunner } from '../../scripts/runner.js';
import type { SecretStore } from '../../secrets/types.js';
import { isObservationRecord } from '../types.js';
import { ScriptConnectorAdapter } from './script.js';

/**
 * A tabular source expressed entirely as a manifest — no native adapter.
 * That is the bet Phase 6 makes: a new high-volume source should be a JSON
 * file, and only a cornerstone corpus should need code.
 *
 * Note where the two halves live. `normalize.tables` is the semantic layer
 * (what a column MEANS, rendered by describe_table); `source.rowMap` is the
 * driver's fetch shaping (how to get a row out of THIS endpoint). Keeping the
 * mapping in `source` also means adding a source needs no core schema release,
 * because `source` is a free-form record.
 */
const TABULAR_TYPE: ConnectorTypeManifest = {
  schemaVersion: 1,
  kind: 'connector-type',
  id: 'edge-logs',
  name: 'Edge Logs',
  description: 'fixture',
  tags: [],
  maintainer: { name: 'Gezel' },
  version: '1.0.0',
  releasedAt: '2026-08-01T00:00:00Z',
  driver: 'script',
  source: {
    fetch: 'edge-logs-fetch',
    table: 'requests',
    tsPath: '$.timeStamp',
    rowMap: {
      ts: '$.timeStamp',
      route: '$.uri',
      status: '$.httpStatus',
      latency_ms: '$.timeTaken',
    },
  },
  normalize: {
    kind: 'observations',
    tables: [
      {
        schemaVersion: 1,
        table: 'requests',
        grain: 'one row per HTTP request',
        timeColumn: 'ts',
        partitionColumn: 'dt',
        columns: [
          { name: 'ts', type: 'TIMESTAMP', role: 'time' },
          { name: 'dt', type: 'VARCHAR', role: 'dimension' },
          { name: 'route', type: 'VARCHAR', role: 'dimension' },
          { name: 'status', type: 'BIGINT', role: 'dimension' },
          { name: 'latency_ms', type: 'DOUBLE', role: 'measure', unit: 'milliseconds' },
        ],
        measures: [],
        exemplars: [],
        rollups: [],
      },
    ],
  },
  actions: [],
  availableVersions: ['1.0.0'],
} as unknown as ConnectorTypeManifest;

function adapterFor(output: Record<string, unknown>, calls: RunScriptOptions[] = []) {
  const runner = {
    run: async (opts: RunScriptOptions) => {
      calls.push(opts);
      return { status: 'ok', output } as Awaited<ReturnType<ScriptRunner['run']>>;
    },
  } as ScriptRunner;
  return new ScriptConnectorAdapter(
    TABULAR_TYPE,
    { id: 'edge-logs:abcd1234', type: 'edge-logs', config: {} },
    { projectId: 'p1', scriptRunner: runner, store: {} as Store, secrets: {} as SecretStore },
  );
}

const PAGE = [
  { timeStamp: '2026-08-04T10:00:00Z', uri: '/api/orders', httpStatus: 200, timeTaken: 12.5 },
  { timeStamp: '2026-08-04T10:00:01Z', uri: '/health', httpStatus: 200, timeTaken: 1.2 },
  { timeStamp: '2026-08-05T02:00:00Z', uri: '/api/orders', httpStatus: 500, timeTaken: 900 },
];

describe('ScriptConnectorAdapter — tabular sources', () => {
  it('returns ONE ref for a whole page, not one per row', async () => {
    const adapter = adapterFor({ records: PAGE, cursor: 'c1' });
    const batch = await adapter.listChangesSince('', undefined);

    // The engine's backfill cap counts refs. One ref per row would window a
    // large page away silently; one ref per page makes the cap bound pages.
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]?.id).toMatch(/^page-/);
    expect(batch.cursor).toBe('c1');
  });

  it('maps the page onto the declared columns', async () => {
    const adapter = adapterFor({ records: PAGE, cursor: 'c1' });
    const listed = await adapter.listChangesSince('', undefined);
    const record = await adapter.fetchRecord('', listed.records[0]!);

    expect(isObservationRecord(record)).toBe(true);
    if (!isObservationRecord(record)) throw new Error('unreachable');
    expect(record.batches).toHaveLength(1);
    expect(record.batches[0]?.table).toBe('requests');
    expect(record.batches[0]?.rows).toEqual([
      { ts: '2026-08-04T10:00:00Z', route: '/api/orders', status: 200, latency_ms: 12.5 },
      { ts: '2026-08-04T10:00:01Z', route: '/health', status: 200, latency_ms: 1.2 },
      { ts: '2026-08-05T02:00:00Z', route: '/api/orders', status: 500, latency_ms: 900 },
    ]);
  });

  it('emits no ref for an empty page rather than an empty batch', async () => {
    const adapter = adapterFor({ records: [], cursor: 'c2' });
    const batch = await adapter.listChangesSince('', undefined);
    expect(batch.records).toEqual([]);
    // The cursor still advances: the source said there is nothing new here.
    expect(batch.cursor).toBe('c2');
  });

  it('passes the script rate-limit and continuation signals through unchanged', async () => {
    const limited = adapterFor({ records: [], cursor: 'c', rateLimited: true });
    expect((await limited.listChangesSince('', undefined)).rateLimited).toBe(true);

    const partial = adapterFor({ records: PAGE, cursor: 'c', partial: true });
    expect((await partial.listChangesSince('', undefined)).partial).toBe(true);
  });

  it('still passes the binding cursor and config into the fetch script', async () => {
    const calls: RunScriptOptions[] = [];
    const adapter = adapterFor({ records: PAGE, cursor: 'c' }, calls);
    await adapter.listChangesSince('', { page: 4 });
    expect(calls[0]?.inputs).toEqual({ cursor: { page: 4 }, config: {} });
    expect(calls[0]?.scriptName).toBe('edge-logs-fetch');
    expect(calls[0]?.trigger).toMatchObject({ kind: 'connector', typeId: 'edge-logs' });
  });

  it('advances the page ordinal so newest-first sorting agrees with paging', async () => {
    const adapter = adapterFor({ records: PAGE });
    const first = await adapter.listChangesSince('', undefined);
    const second = await adapter.listChangesSince('', undefined);
    const a = first.records[0]?.ordinalKey ?? 0;
    const b = second.records[0]?.ordinalKey ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it('fails the pass when the fetch script fails, leaving the cursor unadvanced', async () => {
    const runner = {
      run: async () =>
        ({ status: 'error', error: 'upstream 503' }) as Awaited<ReturnType<ScriptRunner['run']>>,
    } as unknown as ScriptRunner;
    const adapter = new ScriptConnectorAdapter(
      TABULAR_TYPE,
      { id: 'edge-logs:abcd1234', type: 'edge-logs', config: {} },
      { projectId: 'p1', scriptRunner: runner, store: {} as Store, secrets: {} as SecretStore },
    );
    await expect(adapter.listChangesSince('', undefined)).rejects.toThrow(/upstream 503/);
  });
});
