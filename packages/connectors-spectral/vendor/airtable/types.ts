// VENDORED from prismatic-io/components — airtable/src/types/index.ts (Apache-2.0).
// `AirtableRecord` only (the slice `listRecords` needs). Verbatim.

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}
