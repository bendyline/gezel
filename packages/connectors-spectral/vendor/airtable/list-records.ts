// VENDORED from prismatic-io/components — airtable/src/actions/records/listRecords.ts
// (Apache-2.0). `perform` verbatim; imports repointed to the vendored slice, the
// docs-only `examplePayload` dropped, and `inputs` inlined from inputs/{records,common}.ts
// (docs-only example/placeholder/comments fields dropped; the `clean` coercers kept —
// they both normalize the raw value and give `perform`'s params their types).
// See vendor/provenance.json.

import { util, action, input } from '@prismatic-io/spectral';
import { createAirtableClient } from './client.js';
import type { AirtableRecord } from './types.js';
import { getBaseId, paginateData } from './util.js';

export const listRecords = action({
  display: {
    label: 'List Records',
    description: 'List all records within the specified table.',
  },
  inputs: {
    airtableConnection: input({ label: 'Connection', type: 'connection', required: true }),
    baseId: input({
      label: 'Base ID',
      type: 'string',
      required: false,
      clean: util.types.toString,
    }),
    tableName: input({
      label: 'Table',
      type: 'string',
      required: true,
      clean: util.types.toString,
    }),
    view: input({
      label: 'View',
      type: 'string',
      required: false,
      clean: (value) => util.types.toString(value) || undefined,
    }),
    fields: input({
      label: 'Fields',
      type: 'string',
      required: false,
      collection: 'valuelist',
      clean: (values) =>
        Array.isArray(values) && values.length
          ? values.map((field) => util.types.toString(field))
          : undefined,
    }),
    filterByFormula: input({
      label: 'Filter By Formula',
      type: 'string',
      required: false,
      clean: (value) => util.types.toString(value) || undefined,
    }),
  },
  perform: async (context, params) => {
    const client = createAirtableClient(params.airtableConnection, context.debug.enabled);
    const baseId = getBaseId(params.airtableConnection, params.baseId);
    const data = await paginateData<AirtableRecord>(
      client,
      `/v0/${baseId}/${params.tableName}`,
      'records',
      {
        view: params.view,
        fields: params.fields,
        filterByFormula: params.filterByFormula,
      },
      true,
    );
    return { data };
  },
});
