import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toSpectralConnection } from '../../src/connection.js';
import { makeContextShim } from '../../src/context-shim.js';
import { VENDORED } from '../../src/vendor/index.js';
import type { AirtableRecord } from './types.js';

/**
 * Conformance gate for the vendored `airtable/listRecords` slice. It compiles
 * (tsc, part of `pnpm typecheck`) and here runs `perform` against a RECORDED
 * Airtable response — no network — through the exact production entrypoint
 * (`VENDORED['airtable/listRecords']`, the shape the sandbox host invokes).
 *
 * What it pins:
 *  - the vendored client builds a PAT Bearer request at api.airtable.com,
 *  - `getBaseId` uses the config `baseId` (a PAT connection carries no base),
 *  - `paginateData` follows `offset` across pages and concatenates them,
 *  - the raw return shape is `{ data: AirtableRecord[] }` — the contract the
 *    trusted parent's `applyNormalize` + safety writer then consume.
 *
 * If a spectral bump changes the client contract (params key, response unwrap),
 * this goes red before the connector ever runs live.
 */

const hoisted = vi.hoisted(() => ({
  clientConfig: undefined as { baseUrl?: string; headers?: Record<string, string> } | undefined,
  requests: [] as { url: string; params: Record<string, unknown> | undefined }[],
  responses: [] as unknown[],
}));

vi.mock('@prismatic-io/spectral/dist/clients/http', () => ({
  createClient: (config: { baseUrl?: string; headers?: Record<string, string> }) => {
    hoisted.clientConfig = config;
    let call = 0;
    return {
      get: async (url: string, opts?: { params?: Record<string, unknown> }) => {
        hoisted.requests.push({ url, params: opts?.params });
        const data = hoisted.responses[call] ?? { records: [] };
        call += 1;
        return { data };
      },
    };
  },
  handleErrors: () => {},
}));

const recorded = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/list-records.recorded.json', import.meta.url)),
    'utf8',
  ),
) as { responses: unknown[] };

describe('airtable/listRecords conformance (pinned spectral 10.23.0)', () => {
  beforeEach(() => {
    hoisted.clientConfig = undefined;
    hoisted.requests = [];
    hoisted.responses = recorded.responses;
  });

  it('returns { data: AirtableRecord[] } across paginated responses', async () => {
    const connection = toSpectralConnection(
      JSON.stringify({ apiKey: 'patTEST.secret' }),
      'personalAccessToken',
    );
    const action = VENDORED['airtable/listRecords'];
    expect(action).toBeDefined();

    const out = (await action!.perform(makeContextShim(), {
      airtableConnection: connection,
      baseId: 'appTEST',
      tableName: 'Tasks',
    })) as { data: AirtableRecord[] };

    expect(Array.isArray(out.data)).toBe(true);
    expect(out.data.map((r) => r.id)).toEqual(['recA1', 'recA2', 'recA3']);
    expect(out.data[0]).toMatchObject({
      id: 'recA1',
      createdTime: '2026-06-01T10:00:00.000Z',
      fields: { Name: 'Design review', Status: 'In progress' },
    });
  });

  it('builds a PAT Bearer client at api.airtable.com and follows the offset cursor', async () => {
    const connection = toSpectralConnection(
      JSON.stringify({ apiKey: 'patTEST.secret' }),
      'personalAccessToken',
    );

    await VENDORED['airtable/listRecords']!.perform(makeContextShim(), {
      airtableConnection: connection,
      baseId: 'appTEST',
      tableName: 'Tasks',
    });

    expect(hoisted.clientConfig?.baseUrl).toBe('https://api.airtable.com');
    expect(hoisted.clientConfig?.headers?.Authorization).toBe('Bearer patTEST.secret');

    expect(hoisted.requests).toHaveLength(2);
    expect(hoisted.requests[0]?.url).toBe('/v0/appTEST/Tasks');
    expect(hoisted.requests[0]?.params?.offset).toBe('');
    expect(hoisted.requests[1]?.params?.offset).toBe('itrPage2/recA2');
  });
});
