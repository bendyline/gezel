// VENDORED from prismatic-io/components — airtable/src/util/index.ts (Apache-2.0).
// `getBaseId` + `paginateData` only (the slice `listRecords` needs). Verbatim.

import type { Connection } from '@prismatic-io/spectral';
import type { HttpClient } from '@prismatic-io/spectral/dist/clients/http';

export const getBaseId = (airtableConnection: Connection, baseId: string) => {
  if (!airtableConnection && !baseId) {
    throw new Error('You must specify a base ID');
  }
  return baseId || airtableConnection.fields.base;
};

export const paginateData = async <T>(
  client: HttpClient,
  url: string,
  recordArrayName: string,
  params: Record<string, unknown>,
  fetchAll: boolean,
) => {
  const records: T[] = [];
  let offset = '';
  do {
    const { data } = await client.get<{
      offset: string;
      [recordArrayName: string]: T[] | string;
    }>(url, {
      params: {
        ...params,
        offset,
      },
    });
    records.push(...(data[recordArrayName] as T[]));
    offset = data.offset as string;
  } while (offset && fetchAll);
  return records;
};
