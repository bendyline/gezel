/**
 * The one document-FTS query. The compiler's seal-time smoke verification
 * and the validator's install-time smoke check MUST agree on semantics
 * (same MATCH, same ranking, same limit interpretation) — the arts-pilot
 * incident was a smoke query that had never been executed until a user's
 * install ran it. Sharing the query is what keeps the two in lockstep.
 *
 * Throws on invalid FTS5 MATCH syntax — callers decide whether that is a
 * build failure (compiler) or an empty result (user-facing search).
 */

import type { DatabaseSync } from '../format/node-sqlite.js';

/** Injection-safe FTS5 query: quoted OR'd tokens, capped. */
export function sanitizeFtsQuery(query: string): string | null {
  const tokens = [
    ...new Set((query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16)),
  ];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export function documentFtsTopIds(db: DatabaseSync, match: string, limit: number): string[] {
  return (
    db
      .prepare(
        'SELECT document_id FROM fts_documents WHERE fts_documents MATCH ? ORDER BY rank LIMIT ?',
      )
      .all(match, limit) as Array<{ document_id: string }>
  ).map((row) => row.document_id);
}

/** The smoke contract: every expected id must appear in the top-N results. */
export const SMOKE_QUERY_TOP_N = 10;

/**
 * Run one recorded smoke query the way the validator will: sanitized, then
 * top-N by rank. Returns the ids the index failed to surface (empty = pass).
 */
export function documentSmokeQueryMisses(
  db: DatabaseSync,
  smoke: { query: string; expectedDocumentIds: string[] },
): string[] {
  const match = sanitizeFtsQuery(smoke.query);
  if (!match) return [...smoke.expectedDocumentIds];
  const top = documentFtsTopIds(db, match, SMOKE_QUERY_TOP_N);
  return smoke.expectedDocumentIds.filter((id) => !top.includes(id));
}
