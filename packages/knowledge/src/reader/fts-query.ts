/**
 * The one document-FTS query. The compiler's seal-time smoke verification
 * and the validator's install-time smoke check MUST agree on semantics
 * (same MATCH, same ranking, same limit interpretation) — the arts-pilot
 * incident was a smoke query that had never been executed until a user's
 * install ran it. Sharing the query is what keeps the two in lockstep.
 *
 * Ranking is NAME-first, because this index is search's exact-name arm
 * (the service fuses it as `docFts` next to the vector and chunk-body arms,
 * which carry descriptive queries):
 *
 *   1. A title equal to the query (ASCII case-insensitive) comes first.
 *      Plain BM25 cannot promise that: "Quiche" ranked behind "Coronation
 *      quiche" and "Lasagna" behind "Matzo lasagna".
 *   2. Then BM25 with the title weighted 10×, aliases 5×, the summary 1×.
 *      FTS5's default `rank` weights every column alike, so in a series of
 *      near-identical titles the siblings whose short summary repeats the
 *      title's words outranked the page asked for: "1944 Republican Party
 *      vice presidential candidate selection" was not in its own top 5 —
 *      a dozen sibling selections were — and neither was "1903 Nobel Prize
 *      in Literature". Measured on six Wikipedia catalogs (2,000 sampled
 *      titles each), title lookup top-1 went from 91–95% to 96–98% and
 *      top-5 from 97.8–99.6% to 98.8–100%; 3/1/2 and 5/1/3 helped less.
 *
 * Reader-side, so it applies to every catalog already published — the index
 * itself is unchanged.
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

/** bm25() column weights, in `fts_documents` column order: title, summary, aliases. */
export const DOCUMENT_FTS_WEIGHTS = { title: 10, summary: 1, aliases: 5 } as const;

const DOCUMENT_FTS_ORDER = `bm25(fts_documents, ${DOCUMENT_FTS_WEIGHTS.title}.0, ${DOCUMENT_FTS_WEIGHTS.summary}.0, ${DOCUMENT_FTS_WEIGHTS.aliases}.0)`;

/**
 * Top document ids for a sanitized MATCH expression. Pass the user's raw
 * query as `exactTitle` so a document titled exactly that ranks first.
 */
export function documentFtsTopIds(
  db: DatabaseSync,
  match: string,
  limit: number,
  exactTitle?: string,
): string[] {
  const title = exactTitle?.normalize('NFKC').trim() ?? '';
  return (
    db
      .prepare(
        `SELECT document_id FROM fts_documents WHERE fts_documents MATCH ?
         ORDER BY (title = ? COLLATE NOCASE) DESC, ${DOCUMENT_FTS_ORDER} LIMIT ?`,
      )
      .all(match, title, limit) as Array<{ document_id: string }>
  ).map((row) => row.document_id);
}

/** The smoke contract: every expected id must appear in the top-N results. */
export const SMOKE_QUERY_TOP_N = 10;

/**
 * Run one recorded smoke query the way the validator will: sanitized, then
 * top-N in `documentFtsTopIds` order. Returns the ids the index failed to
 * surface (empty = pass).
 */
export function documentSmokeQueryMisses(
  db: DatabaseSync,
  smoke: { query: string; expectedDocumentIds: string[] },
): string[] {
  const match = sanitizeFtsQuery(smoke.query);
  if (!match) return [...smoke.expectedDocumentIds];
  const top = documentFtsTopIds(db, match, SMOKE_QUERY_TOP_N, smoke.query);
  return smoke.expectedDocumentIds.filter((id) => !top.includes(id));
}
