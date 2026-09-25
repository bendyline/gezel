/**
 * One stopword list and one tokenizer for every keyword-search path.
 *
 * There were two lists — a 24-word one behind the FTS5 query builder and a
 * 14-word one behind area-summary token coverage — and they had drifted.
 * Neither covered the vocabulary of an ordinary request, so "Can you create a
 * PowerPoint about France" reached FTS5 as
 * `"can"* OR "create"* OR "powerpoint"* OR "about"* OR "france"*`. In the
 * shared library `france` matched nothing at all while `can`/`about`/`create`
 * matched 66/25/30 rows, so ranking was decided entirely by the filler: the
 * top document hit was a career memoir, and the top symbol hit was a heading
 * called "All About DocBlocks" whose only matched token was `about`.
 *
 * Dropping a generic term is safe for an OR query: it can only remove hits
 * that matched nothing else, and anything holding a distinctive term still
 * ranks. A query made entirely of stopwords keeps every token, so "how to"
 * and a bare search for "create" still work.
 *
 * Judgment call worth knowing about: the request verbs `create` and `make`
 * are stopwords, while `build`, `fix`, `read`, `write`, `update`, `delete`
 * and `show` are not. The first two are how a user says "produce a thing" and
 * carry no subject; the rest name real work and real symbols in a codebase.
 */

const QUERY_STOP_WORDS = new Set([
  // articles + determiners
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'all',
  'each',
  'both',
  'every',
  'other',
  'another',
  'same',
  'such',
  // pronouns
  'i',
  'me',
  'my',
  'we',
  'us',
  'our',
  'you',
  'your',
  'it',
  'its',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  // be / have / do
  'am',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'done',
  // modals
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  // question words
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'why',
  // prepositions + conjunctions
  'about',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'if',
  'in',
  'into',
  'of',
  'on',
  'or',
  'so',
  'than',
  'then',
  'there',
  'to',
  'with',
  // request scaffolding + degree words
  'please',
  'help',
  'let',
  'tell',
  'want',
  'need',
  'create',
  'make',
  'give',
  'get',
  'got',
  'use',
  'using',
  'just',
  'like',
  'also',
  'very',
  'only',
  'new',
  'more',
  'most',
  'much',
  'many',
  'few',
  'own',
  // conversational scaffolding
  'hey',
  'hi',
  'hiya',
  'hello',
  'thanks',
  'thank',
  'okay',
  'ok',
  'yep',
  'yeah',
  'yes',
  'nope',
  'good',
  'great',
  'fine',
  'nice',
  'cool',
  'ready',
  'going',
  'doing',
  'sounds',
  'morning',
  'afternoon',
  'evening',
  'night',
  // Apostrophes are token boundaries, so contractions otherwise leave these
  // fragments looking like rare, highly distinctive query terms.
  's',
  't',
  're',
  've',
  'll',
  'd',
  'm',
  'isn',
  'aren',
  'wasn',
  'weren',
  'don',
  'doesn',
  'didn',
  'hasn',
  'haven',
  'hadn',
  'won',
  'wouldn',
  'shouldn',
  'couldn',
]);

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
