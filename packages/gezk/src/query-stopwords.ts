/**
 * Words that carry no subject in a search request. Dropping one from an FTS5
 * OR query is safe: it can only remove hits that matched nothing else, and
 * anything holding a distinctive term still ranks.
 *
 * One list for every keyword-search path — the project index's query builder
 * and token scorers in the service, the knowledge-catalog reader, and the
 * phone runtime's memory recall. It lives here, in the format package,
 * because this is the one package all three can import: the reader must not
 * depend on core or the service, and core must stay browser-safe.
 * There were three lists once: a 24-word one behind the project index's FTS5
 * query, a 14-word one behind area-summary token coverage, and the catalog
 * reader's function words. Neither project list covered the vocabulary of an
 * ordinary request, so "Can you create a PowerPoint about France" reached
 * FTS5 as `"can"* OR "create"* OR "powerpoint"* OR "about"* OR "france"*`.
 * In the shared library `france` matched nothing at all while
 * `can`/`about`/`create` matched 66/25/30 rows, so ranking was decided
 * entirely by the filler: the top document hit was a career memoir, and the
 * top symbol hit was a heading called "All About DocBlocks" whose only
 * matched token was `about`. The catalog reader kept `tell`, `please` and
 * `help` in "Can you tell me how to integrate Azure search with blob
 * storage?".
 *
 * Callers fall back to every token when a query is nothing but these words,
 * so "how to" and a bare search for "create" still search for what was typed.
 *
 * Judgment call worth knowing about: the request verbs `create` and `make`
 * are stopwords, while `build`, `fix`, `read`, `write`, `update`, `delete`
 * and `show` are not. The first two are how a user says "produce a thing" and
 * carry no subject; the rest name real work and real symbols in a codebase.
 *
 * Lowercase; compare against a lowercased token.
 */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
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
