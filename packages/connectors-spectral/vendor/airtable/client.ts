// VENDORED from prismatic-io/components — airtable/src/client.ts (Apache-2.0).
// Verbatim except this header. Slice completeness + content sha are gated by
// `pnpm verify:vendor` (scripts/vendor-component.mjs); see vendor/provenance.json.
// Runs off-platform through the connectors-spectral host.

import type { Connection } from '@prismatic-io/spectral';
import { createClient } from '@prismatic-io/spectral/dist/clients/http';

export const createAirtableClient = (airtableConnection: Connection, debug = false) => {
  const apiKey = airtableConnection.token?.access_token || airtableConnection.fields.apiKey;
  return createClient({
    baseUrl: 'https://api.airtable.com',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    debug,
  });
};
