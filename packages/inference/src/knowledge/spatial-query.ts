/**
 * Radius pagination binds offsets to the authorized catalog snapshot and
 * query. Cursors confer no authority; the manager recalculates scope on
 * every request.
 */
export class KnowledgeSpatialCursorError extends Error {}
export function encodeNearbyCursor(snapshot: string, offset: number): string {
  return Buffer.from(JSON.stringify({ snapshot, offset })).toString('base64url');
}
export function nearbyCursorOffset(cursor: string | undefined, snapshot: string): number {
  if (!cursor) return 0;
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.snapshot !== snapshot || !Number.isSafeInteger(value.offset) || value.offset < 0)
      throw new Error();
    return value.offset;
  } catch {
    throw new KnowledgeSpatialCursorError('Invalid or stale nearby cursor; restart the query.');
  }
}
/**
 * Source-article ids (`wikipedia-<page-id>`) name the same article in every
 * catalog of one publisher, and regional catalogs overlap heavily — Pacific
 * Northwest and Canada & Alaska share 683 of the former's 1,106 articles — so
 * those copies are one result. Any other id is unique only within its catalog.
 * Keyed on the id, not the catalog name: an earlier catalog-name match never
 * fired for the published `regional-*` catalogs, so every copy came through.
 */
const SOURCE_ARTICLE_ID = /^(wikipedia|wikivoyage)-[0-9]+$/;

export function spatialDocumentIdentity(
  publisherId: string,
  catalogId: string,
  documentId: string,
): string {
  return SOURCE_ARTICLE_ID.test(documentId)
    ? `${publisherId}\u0000${documentId}`
    : `${publisherId}\u0000${catalogId}\u0000${documentId}`;
}
