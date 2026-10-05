/**
 * Radius pagination binds offsets to the authorized catalog snapshot and
 * query. Cursors confer no authority; the manager recalculates scope on
 * every request. Regional replicas share identity only under Qualla's
 * declared regional catalog and source-document naming convention.
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
export function regionalDocumentIdentity(
  publisherId: string,
  catalogId: string,
  documentId: string,
): string {
  const regional =
    catalogId.startsWith('qualla-region-') &&
    /^qualla-(wikipedia|wikivoyage)-[0-9]+$/.test(documentId);
  return regional
    ? `${publisherId}\u0000${documentId}`
    : `${publisherId}\u0000${catalogId}\u0000${documentId}`;
}
