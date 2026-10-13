import type { ChatMessage } from './schemas/gezel.js';

/** Persisted sentinel used until a thread has enough content to name. */
export const NEW_THREAD_TITLE = 'New session';

export const THREAD_TITLE_MAX_LENGTH = 60;

/**
 * Glue and conversational framing. A sentence made only of these is no
 * topic, so the title keeps the person's words as they wrote them.
 */
const STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'after',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  "can't",
  'cannot',
  'could',
  "couldn't",
  'did',
  "didn't",
  'do',
  'does',
  "doesn't",
  'doing',
  "don't",
  'for',
  'from',
  'had',
  'has',
  'have',
  'having',
  'he',
  'hello',
  'help',
  'her',
  'here',
  'hers',
  'hey',
  'hi',
  'him',
  'his',
  'how',
  'i',
  "i'd",
  "i'll",
  "i'm",
  "i've",
  'if',
  'in',
  'into',
  'is',
  "isn't",
  'it',
  "it's",
  'its',
  'just',
  'let',
  "let's",
  'like',
  'me',
  'might',
  'more',
  'much',
  'my',
  'need',
  'needed',
  'of',
  'on',
  'one',
  'or',
  'our',
  'ours',
  'please',
  'really',
  'she',
  'should',
  'so',
  'some',
  'something',
  'that',
  "that's",
  'the',
  'their',
  'them',
  'there',
  "there's",
  'these',
  'they',
  'think',
  'thinking',
  'this',
  'those',
  'to',
  'try',
  'trying',
  'turn',
  'up',
  'us',
  'very',
  'want',
  'wanted',
  'was',
  'we',
  "we'd",
  "we'll",
  "we're",
  "we've",
  'were',
  "weren't",
  'what',
  "what's",
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'wondering',
  'would',
  "wouldn't",
  'you',
  "you'd",
  "you'll",
  "you're",
  "you've",
  'your',
]);

const TOKEN_RE = /[@#]?[\p{L}\p{N}][\p{L}\p{N}'’._+#:/-]*/gu;

interface TitleToken {
  raw: string;
  key: string;
  position: number;
}

function tokenKey(raw: string): string {
  let key = raw.toLocaleLowerCase().replace(/’/g, "'");
  // A tiny plural fold lets repeated subjects such as "title/titles" vote
  // together without pulling in a stemmer (or turning "analysis" into
  // "analysi"). The first spelling still wins in the rendered title.
  if (key.length > 5 && key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (
    key.length > 4 &&
    key.endsWith('s') &&
    !key.endsWith('ss') &&
    !key.endsWith('us') &&
    !key.endsWith('is')
  ) {
    key = key.slice(0, -1);
  }
  return key;
}

function stripMarkup(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\0/g, ' ')
    .replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
    .replace(/@\[([^\]]+)\]\(gezel\\?:[^)\s]+\)/g, '@$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(input: string): TitleToken[] {
  const matches = input.match(TOKEN_RE) ?? [];
  const tokens: TitleToken[] = [];
  for (const match of matches) {
    const raw = match.replace(/[.'’:_/-]+$/g, '');
    if (!raw) continue;
    const key = tokenKey(raw);
    if (STOP_WORDS.has(key)) continue;
    // Single letters are normally sentence debris; keep language names and
    // numbered coordinates because C, R, and board/file labels can be real.
    if (key.length === 1 && !/^[cr]$/i.test(raw) && !/\d/.test(raw)) continue;
    tokens.push({ raw, key, position: tokens.length });
  }
  return tokens;
}

function selectTopic(input: string): { prefix: string; sentence: string } {
  const normalized = stripMarkup(input);
  if (!normalized) return { prefix: '', sentence: '' };

  // Project-type reactions use "[Checkers page]: …". The surface name is
  // valuable context, while the literal word "page" is chrome rather than
  // topic. Keep the former beside the first substantive sentence.
  const surface = normalized.match(/^\[([^\]]{1,80})\]\s*:?\s*/);
  const prefix = surface?.[1]?.replace(/\s+page$/i, '').trim() ?? '';
  const body = surface ? normalized.slice(surface[0].length).trim() : normalized;
  const sentences = body
    .split(/(?<=[.!?])\s+|[\r\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const sentence =
    sentences.find((part) => meaningfulTokens(part).length > 0) ?? sentences[0] ?? body;
  return { prefix, sentence };
}

function capitalizeFirstWord(title: string): string {
  const firstLetter = title.search(/\p{L}/u);
  if (firstLetter < 0) return title;
  const letter = title[firstLetter]!;
  if (letter !== letter.toLocaleLowerCase()) return title;
  return `${title.slice(0, firstLetter)}${letter.toLocaleUpperCase()}${title.slice(firstLetter + 1)}`;
}

/**
 * Requests open with framing that names no topic. Peeled off so the title
 * starts where the person's request does.
 */
const LEAD_IN_RE =
  /^(?:(?:hi|hey|hello)[,!.]?\s+(?=\S+\s+\S))?(?:(?:could|can|would|will) you\s+|please\s+|kindly\s+|i(?:'d| would) like (?:you )?to\s+|i want (?:you )?to\s+|help me(?: to)?\s+)+/i;

/** Clause breaks a long sentence may be cut at without losing its sense. */
const CLAUSE_BREAK_RE = /\s*(?:[,;:]|\s[-–—]\s)\s*/g;

/** Glue a title should not end on once it has been cut short. */
const TRAILING_GLUE_RE = /(?:\s+(?:a|an|and|at|by|for|from|in|of|on|or|the|to|with))+$/i;

/**
 * Cut a sentence to the title limit: at the last clause break that keeps
 * most of it, else at a word, with an ellipsis to say there is more.
 */
function fitSentence(sentence: string): string {
  if (sentence.length <= THREAD_TITLE_MAX_LENGTH) return sentence;
  let clause = '';
  for (const match of sentence.matchAll(CLAUSE_BREAK_RE)) {
    const head = sentence.slice(0, match.index).trim();
    if (head.length > THREAD_TITLE_MAX_LENGTH) break;
    clause = head;
  }
  if (clause.length >= THREAD_TITLE_MAX_LENGTH * 0.6) return clause;
  const room = sentence.slice(0, THREAD_TITLE_MAX_LENGTH - 1);
  const boundary = room.lastIndexOf(' ');
  const head = (boundary > 0 ? room.slice(0, boundary) : room)
    .replace(/[\s,;:.-]+$/, '')
    .replace(TRAILING_GLUE_RE, '');
  return `${head || room.trim()}…`;
}

/**
 * Title a thread with the person's own sentence: the first one that says
 * something, without its conversational lead-in, cut to the limit at a
 * clause or a word. Keyword extraction made "Plan a trip to Lisbon next
 * spring for the four of us" read "Plan trip Lisbon next spring four week".
 */
export function deriveThreadTitle(input: string): string {
  const { prefix, sentence: topic } = selectTopic(input);
  const sentence = topic.replace(/[.!?,;:]+$/g, '').trim();
  const peeled = sentence.replace(LEAD_IN_RE, '').trim();
  // A request that is all framing ("Can you help?") keeps its own words.
  const words = peeled && meaningfulTokens(peeled).length > 0 ? peeled : sentence;
  if (!words) return 'Untitled';
  const titled = capitalizeFirstWord(words);
  return fitSentence(prefix ? `${prefix}: ${titled}` : titled) || 'Untitled';
}

export type ThreadTitleMessage = Pick<
  ChatMessage,
  'role' | 'content' | 'at' | 'hidden' | 'synthetic'
>;

/**
 * Derive a title from the original user starter (or, for an assistant-only
 * transcript, the first real reply). `requireCompletedTurn` is used by list
 * views when repairing the display of old sentinel-titled sessions: passive
 * CC messages alone must not make a thread look like its owner answered them.
 */
export function deriveThreadTitleFromMessages(
  messages: readonly ThreadTitleMessage[],
  options: { requireCompletedTurn?: boolean } = {},
): string | null {
  if (
    options.requireCompletedTurn &&
    !messages.some(
      (message) =>
        message.role === 'assistant' &&
        !message.hidden &&
        !message.synthetic &&
        message.content.trim().length > 0,
    )
  ) {
    return null;
  }

  const starter =
    messages.find((message) => message.role === 'user' && message.content.trim().length > 0) ??
    messages.find(
      (message) =>
        message.role === 'assistant' && !message.synthetic && message.content.trim().length > 0,
    );
  return starter ? deriveThreadTitle(starter.content) : null;
}
