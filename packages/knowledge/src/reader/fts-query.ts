/**
 * The one document-FTS query. The compiler's seal-time smoke verification
 * and the validator's install-time smoke check MUST agree on semantics
 * (same MATCH, same ranking, same limit interpretation) — the arts-pilot
 * incident was a smoke query that had never been executed until a user's
 * install ran it. Sharing the query is what keeps the two in lockstep:
 * `documentFtsTopIds` takes the raw query and builds its own MATCH.
 *
 * Ranking is NAME-first, because this index is search's exact-name arm
 * (the service fuses it as `docFts` next to the vector and chunk-body arms,
 * which carry descriptive queries):
 *
 *   1. A title equal to the query (case-insensitive) comes first.
 *      Plain BM25 cannot promise that: "Quiche" ranked behind "Coronation
 *      quiche" and "Lasagna" behind "Matzo lasagna".
 *   2. Then titles the query NAMES (`namedTitleMatches`): every word of the
 *      title appears in the query, and at least one is not a function word —
 *      "ABBA" in "Who were the members of ABBA?". The most specific name
 *      first: summed IDF of the title's words over the title column, a word
 *      the asker capitalized mid-sentence counting double. Without this tier
 *      the question's function words decided: a vandalised alias reading
 *      "…who were the disciples…" put "Romans (group)" first, and ABBA was
 *      not in the top 6. Measured on the music catalog, the ABBA article went
 *      from absent to first; "What is <title>?" lookups improved alike.
 *   3. Then BM25 with the title weighted 10×, aliases 5×, the summary 1×.
 *      FTS5's default `rank` weights every column alike, so in a series of
 *      near-identical titles the siblings whose short summary repeats the
 *      title's words outranked the page asked for: "1944 Republican Party
 *      vice presidential candidate selection" was not in its own top 5 —
 *      a dozen sibling selections were — and neither was "1903 Nobel Prize
 *      in Literature". Measured on six Wikipedia catalogs (2,000 sampled
 *      titles each), title lookup top-1 went from 91–95% to 96–98% and
 *      top-5 from 97.8–99.6% to 98.8–100%; 3/1/2 and 5/1/3 helped less.
 *      This tier matches the query's content words only: request filler
 *      (`QUERY_STOP_WORDS`) ranked a title like "What can you do with X" on
 *      "can", "you" and "with" alone.
 *
 * Reader-side, so it applies to every catalog already published — the index
 * itself is unchanged. A recorded smoke query is a document's own title, so
 * tier 1 keeps it first under every tier added since: tiers 1 and 2 read the
 * raw query, and that title holds every word tier 3 matches.
 *
 * The named tier also drives title-assisted routing
 * (`CatalogHandle.titleRouteShards`): the shard holding a page the question
 * names is scanned even when its centroids rank it outside the budget.
 *
 * Throws on invalid FTS5 MATCH syntax — callers decide whether that is a
 * build failure (compiler) or an empty result (user-facing search).
 */

import type { DatabaseSync } from '../format/node-sqlite.js';
import { QUERY_STOP_WORDS } from '../query-stopwords.js';

/**
 * The query's words worth matching, deduped and capped: request filler
 * (`QUERY_STOP_WORDS`) dropped, unless nothing else is left — a bare "how
 * to" still searches for what was typed.
 */
function contentTokens(query: string): string[] {
  const tokens = [
    ...new Set((query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16)),
  ];
  const content = tokens.filter((t) => !QUERY_STOP_WORDS.has(t.toLowerCase()));
  return content.length > 0 ? content : tokens;
}

/** Injection-safe FTS5 query over the content words: quoted, OR'd, capped. */
export function contentFtsQuery(query: string): string | null {
  const tokens = contentTokens(query);
  return tokens.length > 0 ? tokens.map(quoteToken).join(' OR ') : null;
}

/**
 * The chunk-body FTS expression: the content words minus the ones that cost
 * a scan nearly everything and cannot change its order.
 *
 * FTS5's bm25 clamps the IDF of a term found in more than half the rows to
 * 1e-6, yet an OR still ranks every row that term matches. In a 200k-chunk
 * Azure-docs shard "azure" is in 82% of rows, and "Can you tell me how to
 * integrate Azure search with blob storage?" spent ~240 ms per shard ranking
 * it and the function words around it. Next to the vector arm that blew the
 * chat turn's 600 ms knowledge budget, so the catalog answered nothing.
 * Without those terms the same scan takes ~20 ms.
 *
 * Request filler goes first (`contentTokens`), then any term in more than
 * half of `rows`. Neither empties the query: a query of only filler keeps it,
 * and one whose every term is that common keeps its rarest. The title index
 * skips the second step: one row per document is cheap to rank.
 */
export function selectiveFtsQuery(
  query: string,
  rows: number,
  rowsMatching: (phrase: string) => number,
): string | null {
  const tokens = contentTokens(query);
  if (tokens.length === 0) return null;
  const counted = tokens.map((token) => {
    const phrase = quoteToken(token);
    return { phrase, hits: rowsMatching(phrase) };
  });
  const kept = counted.filter((c) => c.hits * 2 <= rows);
  const chosen =
    kept.length > 0 ? kept : [counted.reduce((rarest, c) => (c.hits < rarest.hits ? c : rarest))];
  return chosen.map((c) => c.phrase).join(' OR ');
}

/** bm25() column weights, in `fts_documents` column order: title, summary, aliases. */
export const DOCUMENT_FTS_WEIGHTS = { title: 10, summary: 1, aliases: 5 } as const;

const DOCUMENT_FTS_ORDER = `bm25(fts_documents, ${DOCUMENT_FTS_WEIGHTS.title}.0, ${DOCUMENT_FTS_WEIGHTS.summary}.0, ${DOCUMENT_FTS_WEIGHTS.aliases}.0)`;

/**
 * Top document ids for the user's raw query: a document titled exactly that
 * first, the titles it names next, then BM25 over its content words.
 */
export function documentFtsTopIds(
  db: DatabaseSync,
  query: string,
  limit: number,
  allowedDocumentIds?: ReadonlySet<string>,
): string[] {
  const match = contentFtsQuery(query);
  if (!match || allowedDocumentIds?.size === 0) return [];
  const scope = allowedDocumentIds ? JSON.stringify([...allowedDocumentIds]) : null;
  const title = query.normalize('NFKC').trim();
  const ids = namedTitleMatches(db, query, limit, allowedDocumentIds).map((m) => m.documentId);
  const rest = db
    .prepare(
      `SELECT document_id FROM fts_documents WHERE fts_documents MATCH ?
       ${scope === null ? '' : 'AND document_id IN (SELECT value FROM json_each(?))'}
       ORDER BY (title = ? COLLATE NOCASE) DESC, ${DOCUMENT_FTS_ORDER} LIMIT ?`,
    )
    .all(
      ...(scope === null
        ? [match, title, limit + ids.length]
        : [match, scope, title, limit + ids.length]),
    ) as Array<{ document_id: string }>;
  for (const row of rest) {
    if (ids.length >= limit) break;
    if (!ids.includes(row.document_id)) ids.push(row.document_id);
  }
  return ids;
}

/**
 * Function words: a title made only of these is never "named" (the band
 * "The Who" is not what "Who wrote it?" asks for), and they add nothing to
 * how specifically a query names a title. English, like the published
 * catalogs; in other languages the IDF weighting does the same job, less
 * sharply. Narrower than `QUERY_STOP_WORDS` on purpose: that list drops
 * request words such as "help", "good" and "night" from a search, but each
 * can be a whole title ("Help!", "Night") that a question names.
 */
const NAME_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the of in on at to for by with from and or nor but as into onto about than then ' +
    'is are was were be been being am do does did done has have had having ' +
    'who whom whose what which when where why how whats wheres ' +
    'it its this that these those there their them they he him his she her hers ' +
    'i me my we us our you your not no yes if so can could would should will shall may might must'
  ).split(' '),
);

/** Title-column candidates fetched for the named tier; short named titles rank well inside this. */
const NAMED_TITLE_CANDIDATES = 256;
/** Title-column document frequencies cached per router before the cache is reset. */
const TITLE_DF_CACHE_MAX = 50_000;
/** A title spelled exactly as the query (case-insensitive), ahead of one whose words merely match. */
const EXACT_TITLE_SCORE = Number.POSITIVE_INFINITY;
const SAME_WORDS_SCORE = Number.MAX_VALUE;

/** A document the query names by title, and how specifically (higher names it more precisely). */
export interface NamedTitleMatch {
  documentId: string;
  score: number;
}

/**
 * The query's words as the index folds them (`unicode61 remove_diacritics
 * 2`: case and diacritics removed, letters and digits kept), closely enough
 * to compare a title's words with a question's.
 */
function nameWords(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

interface TitleStats {
  documents: number;
  df: Map<string, number>;
  dfQuery: ReturnType<DatabaseSync['prepare']>;
  candidates: ReturnType<DatabaseSync['prepare']>;
}

const titleStatsByDb = new WeakMap<DatabaseSync, TitleStats>();

function titleStats(db: DatabaseSync): TitleStats {
  let stats = titleStatsByDb.get(db);
  if (!stats) {
    const row = db.prepare('SELECT COUNT(*) AS c FROM documents').get() as { c: number | bigint };
    stats = {
      documents: Math.max(1, Number(row.c)),
      df: new Map(),
      dfQuery: db.prepare('SELECT COUNT(*) AS c FROM fts_documents WHERE fts_documents MATCH ?'),
      candidates: db.prepare(
        `SELECT document_id, title FROM fts_documents WHERE fts_documents MATCH ?
         ORDER BY ${DOCUMENT_FTS_ORDER} LIMIT ?`,
      ),
    };
    titleStatsByDb.set(db, stats);
  }
  return stats;
}

/** How many titles contain `word` (FTS5 counts the title column's doclist). */
function titleDf(stats: TitleStats, word: string): number {
  let df = stats.df.get(word);
  if (df === undefined) {
    if (stats.df.size >= TITLE_DF_CACHE_MAX) stats.df.clear();
    const row = stats.dfQuery.get(`title : ${quoteToken(word)}`) as { c: number | bigint };
    df = Number(row.c);
    stats.df.set(word, df);
  }
  return df;
}

/**
 * Documents whose title the query names — every word of the title appears
 * in the query and at least one is not a function word — most specific
 * first: a title spelled exactly as the query, then one with exactly the
 * query's words, then by summed IDF of the title's words (a word the asker
 * capitalized after the first counting double, which is what tells "ABBA"
 * from the band "The Members" in "Who were the members of ABBA?"). Ties
 * keep BM25 order. Throws on an FTS error like `documentFtsTopIds`.
 */
export function namedTitleMatches(
  db: DatabaseSync,
  query: string,
  limit: number,
  allowedDocumentIds?: ReadonlySet<string>,
): NamedTitleMatch[] {
  if (allowedDocumentIds?.size === 0) return [];
  const raw = query.normalize('NFKC').trim();
  const words = [...new Set(nameWords(raw))].slice(0, 16);
  const content = words.filter((w) => !NAME_STOPWORDS.has(w));
  if (content.length === 0 || limit <= 0) return [];
  const asked = new Set(words);
  const capitalized = new Set(
    (raw.match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w, i) => i > 0 && /^\p{Lu}/u.test(w))
      .flatMap(nameWords),
  );
  const queryWords = nameWords(raw).join(' ');
  const stats = titleStats(db);
  const expression = `title : (${content.map(quoteToken).join(' OR ')})`;
  const rows = (
    allowedDocumentIds
      ? db
          .prepare(`SELECT document_id, title FROM fts_documents WHERE fts_documents MATCH ?
        AND document_id IN (SELECT value FROM json_each(?)) ORDER BY ${DOCUMENT_FTS_ORDER} LIMIT ?`)
          .all(expression, JSON.stringify([...allowedDocumentIds]), NAMED_TITLE_CANDIDATES)
      : stats.candidates.all(expression, NAMED_TITLE_CANDIDATES)
  ) as Array<{ document_id: string; title: string }>;
  const named: Array<NamedTitleMatch & { order: number }> = [];
  for (const row of rows) {
    const titleWords = nameWords(row.title);
    if (titleWords.length === 0 || !titleWords.every((w) => asked.has(w))) continue;
    const distinct = [...new Set(titleWords)].filter((w) => !NAME_STOPWORDS.has(w));
    if (distinct.length === 0) continue;
    let score: number;
    if (row.title.normalize('NFKC').trim().toLowerCase() === raw.toLowerCase()) {
      score = EXACT_TITLE_SCORE;
    } else if (titleWords.join(' ') === queryWords) {
      score = SAME_WORDS_SCORE;
    } else {
      score = 0;
      for (const w of distinct) {
        score +=
          (capitalized.has(w) ? 2 : 1) * Math.log(stats.documents / Math.max(1, titleDf(stats, w)));
      }
    }
    named.push({ documentId: row.document_id, score, order: named.length });
  }
  named.sort((a, b) => compareScores(b.score, a.score) || a.order - b.order);
  return named.slice(0, limit).map(({ documentId, score }) => ({ documentId, score }));
}

/** Numeric order that treats two infinities as equal (plain subtraction gives NaN). */
export function compareScores(a: number, b: number): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

/** The smoke contract: every expected id must appear in the top-N results. */
export const SMOKE_QUERY_TOP_N = 10;

/**
 * Run one recorded smoke query the way the validator will: top-N in
 * `documentFtsTopIds` order. Returns the ids the index failed to surface
 * (empty = pass).
 */
export function documentSmokeQueryMisses(
  db: DatabaseSync,
  smoke: { query: string; expectedDocumentIds: string[] },
): string[] {
  const top = documentFtsTopIds(db, smoke.query, SMOKE_QUERY_TOP_N);
  return smoke.expectedDocumentIds.filter((id) => !top.includes(id));
}
