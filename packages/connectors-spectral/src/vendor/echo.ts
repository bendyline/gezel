import { action } from '@prismatic-io/spectral';

/**
 * A minimal spectral action that proves the off-platform host mechanism (SDK
 * loads, `action.perform(shim, params)` runs, returns `{ data }`) without
 * needing a real vendored Prismatic component. Real components (e.g. Airtable
 * `listRecords`, which hits the deep `dist/clients/http` path guarded by the
 * deep-import test) are vendored here later.
 */
export const list = action({
  display: {
    label: 'Echo list',
    description: 'Returns its inputs as data (host-mechanism proof).',
  },
  perform: async (_context, params) => ({
    data: (params.records as unknown[]) ?? [{ id: '1', title: 'hello from spectral' }],
  }),
  inputs: {
    connection: { label: 'Connection', type: 'connection', required: false },
    records: { label: 'Records', type: 'data', required: false, clean: (v: unknown) => v },
  },
});
