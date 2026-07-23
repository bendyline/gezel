import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../fs/store.js';
import type { SecretStore } from '../../secrets/types.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';

/**
 * Adapter-level coverage for the `spectral` driver, with the sandbox host
 * (`runSpectralAction`) mocked out — so it exercises the trusted parent's logic
 * (connection building, input resolution, record extraction, normalize) without
 * spawning anything. The vendored component + its network path are covered
 * separately by connectors-spectral's conformance test.
 */

const hoisted = vi.hoisted(() => ({
  job: undefined as
    | { connection?: unknown; connectionInput?: unknown; inputs?: unknown }
    | undefined,
  data: [] as unknown[],
}));

vi.mock('./spectral-host.js', () => ({
  runSpectralAction: async (job: Record<string, unknown>) => {
    hoisted.job = job;
    return { data: hoisted.data };
  },
}));

const { SpectralConnectorAdapter } = await import('./spectral.js');

const AIRTABLE_TYPE = {
  schemaVersion: 1 as const,
  kind: 'connector-type' as const,
  id: 'airtable-records',
  name: 'Airtable Records',
  description: '',
  tags: [],
  maintainer: { name: 'x' },
  version: '1.0.0',
  releasedAt: '2026-01-01T00:00:00Z',
  driver: 'spectral' as const,
  source: {
    component: 'airtable',
    action: 'listRecords',
    connectionKey: 'personalAccessToken',
    connectionInput: 'airtableConnection',
    inputs: { baseId: '$config.baseId', tableName: '$config.tableName' },
    itemsPath: '$.data',
  },
  secretShape: { kind: 'apikey', field: 'apiKey' },
  normalize: {
    kind: 'mapping' as const,
    map: {
      id: '$.id',
      title: '$.fields.Name',
      timestamp: '$.createdTime',
      body: '$.fields',
      frontmatter: { recordId: '$.id' },
    },
  },
  actions: [],
  availableVersions: ['1.0.0'],
};

function deps(blob: string | undefined): AdapterDeps {
  return {
    secrets: { get: async () => blob } as unknown as SecretStore,
    store: {} as unknown as Store,
  };
}

const binding: ConnectorBindingRef = {
  id: 'abc123',
  type: 'airtable-records',
  config: { baseId: 'appTEST', tableName: 'Tasks' },
};

describe('SpectralConnectorAdapter', () => {
  beforeEach(() => {
    hoisted.job = undefined;
    hoisted.data = [];
  });

  it('wraps a BARE apikey/PAT blob into fields.<apiKeyField> for the component', async () => {
    const adapter = new SpectralConnectorAdapter(AIRTABLE_TYPE, binding, deps('patTEST.secret'));
    await adapter.ensureAuth();
    await adapter.listChangesSince('', undefined);

    expect(hoisted.job?.connection).toEqual({
      key: 'personalAccessToken',
      fields: { apiKey: 'patTEST.secret' },
    });
    expect(hoisted.job?.connectionInput).toBe('airtableConnection');
    expect(hoisted.job?.inputs).toEqual({ baseId: 'appTEST', tableName: 'Tasks' });
  });

  it('reads an OAuth JSON blob into token.access_token', async () => {
    const adapter = new SpectralConnectorAdapter(
      AIRTABLE_TYPE,
      binding,
      deps(JSON.stringify({ accessToken: 'oauth-tok', scope: 'x' })),
    );
    await adapter.ensureAuth();
    await adapter.listChangesSince('', undefined);

    expect(hoisted.job?.connection).toMatchObject({
      key: 'personalAccessToken',
      token: { access_token: 'oauth-tok' },
    });
  });

  it('extracts records at itemsPath and normalizes a record via the mapping', async () => {
    hoisted.data = [
      { id: 'recA1', createdTime: '2026-06-01T10:00:00.000Z', fields: { Name: 'Design review' } },
    ];
    const adapter = new SpectralConnectorAdapter(AIRTABLE_TYPE, binding, deps('patTEST'));
    await adapter.ensureAuth();

    const batch = await adapter.listChangesSince('', undefined);
    expect(batch.records).toEqual([{ id: 'recA1', raw: hoisted.data[0] }]);

    const rec = await adapter.fetchRecord('', batch.records[0]!);
    expect(rec.recordId).toBe('recA1');
    expect(rec.fileStem).toBe('design-review');
    expect(rec.scanOrigin).toBe('airtable-records');
    expect(rec.frontmatter.recordId).toBe('recA1');
  });

  it('throws a clear error when no credential is stored', async () => {
    const adapter = new SpectralConnectorAdapter(AIRTABLE_TYPE, binding, deps(undefined));
    await expect(adapter.ensureAuth()).rejects.toThrow(/no stored credential/);
  });
});
