/**
 * One tokenizer for every project-index keyword-search path, over the one
 * stopword list every keyword search shares (`QUERY_STOP_WORDS`, owned by the
 * knowledge package so its catalog reader can use it too).
 */

import { QUERY_STOP_WORDS } from '@bendyline/gezel-knowledge';

/**
 * Tokens of this length or longer become FTS5 prefix queries (`"tok"*`);
 * shorter ones must match exactly. Anything comparing text against query
 * terms has to apply the same rule or it disagrees with what was searched.
 */
const PREFIX_MIN_LENGTH = 3;

/** FTS5 is handed at most this many terms — an OR of more is noise, not recall. */
const MAX_QUERY_TERMS = 16;

export function tokenizeText(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}

/**
 * The distinctive tokens of a query, deduped and capped. Falls back to every
 * token when the query is nothing but stopwords, so a search for "how to" or
 * "create" still searches for what the user typed.
 */
export function queryTerms(text: string): string[] {
  const unique = [...new Set(tokenizeText(text))].slice(0, MAX_QUERY_TERMS);
  const meaningful = unique.filter((token) => !QUERY_STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : unique;
}

/**
 * Terms that make automatic, pre-inference retrieval worthwhile.
 *
 * Unlike {@link queryTerms}, this never falls back to filler-only input. That
 * fallback is useful for an explicit search (a user really may search for
 * "how to" or "hello"), but it is the wrong contract for proactive context injection:
 * greetings and acknowledgements should stay ordinary conversation. One-letter
 * terms are also excluded here because contraction shards such as the `s` in
 * "how's" create extremely broad FTS matches.
 */
export function proactiveRetrievalTerms(text: string): string[] {
  return [...new Set(tokenizeText(text))]
    .slice(0, MAX_QUERY_TERMS)
    .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token));
}

/**
 * Distinctive tokens with plural folding, for the token-coverage scorers that
 * compare a query against a body of text rather than against an FTS index.
 */
export function searchTokens(text: string): Set<string> {
  return new Set(
    tokenizeText(text)
      .filter((token) => !QUERY_STOP_WORDS.has(token))
      .map((token) => (token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)),
  );
}

/**
 * Does `text` contain any of `terms`, under the same prefix rule the FTS5
 * query builder applies? Used to check that a keyword hit is grounded in the
 * text about to be injected — a hit whose only matched token was a stopword
 * has nothing here and must not reach a prompt.
 */
export function textMatchesAnyTerm(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  for (const token of new Set(tokenizeText(text))) {
    for (const term of terms) {
      if (token === term) return true;
      if (term.length >= PREFIX_MIN_LENGTH && token.startsWith(term)) return true;
    }
  }
  return false;
}

/**
 * The share of `terms` that `text` contains, under the same prefix rule as
 * {@link textMatchesAnyTerm} — so any text scoring above zero is grounded.
 * Ranks keyword hits over a corpus with no FTS index (the daily memory files).
 */
export function termMatchFraction(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const tokens = new Set(tokenizeText(text));
  let matched = 0;
  for (const term of terms) {
    for (const token of tokens) {
      if (token === term || (term.length >= PREFIX_MIN_LENGTH && token.startsWith(term))) {
        matched++;
        break;
      }
    }
  }
  return matched / terms.length;
}
