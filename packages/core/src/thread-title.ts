import type { ChatMessage } from './schemas/gezel.js';

/** Persisted sentinel used until a thread has enough content to name. */
export const NEW_THREAD_TITLE = 'New session';

export const THREAD_TITLE_MAX_LENGTH = 60;

const MAX_TITLE_WORDS = 7;

/**
 * Glue and conversational framing that rarely help distinguish one thread
 * from another. The extractor remains deliberately small and deterministic:
 * it is a title heuristic, not a natural-language model hidden in the daemon.
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

function selectTopicText(input: string): string {
  const normalized = stripMarkup(input);
  if (!normalized) return '';

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
  return [prefix, sentence].filter(Boolean).join(' ');
}

function capitalizeFirstWord(title: string): string {
  const firstLetter = title.search(/\p{L}/u);
  if (firstLetter < 0) return title;
  const letter = title[firstLetter]!;
  if (letter !== letter.toLocaleLowerCase()) return title;
  return `${title.slice(0, firstLetter)}${letter.toLocaleUpperCase()}${title.slice(firstLetter + 1)}`;
}

function fitTitle(tokens: TitleToken[]): string {
  let title = '';
  for (const token of tokens) {
    const next = title ? `${title} ${token.raw}` : token.raw;
    if (next.length > THREAD_TITLE_MAX_LENGTH) continue;
    title = next;
  }
  if (title) return capitalizeFirstWord(title);

  const first = tokens[0]?.raw ?? '';
  return capitalizeFirstWord(first.slice(0, THREAD_TITLE_MAX_LENGTH).trim());
}

/**
 * Build a compact, extractive title from a thread starter. Repeated subject
 * words, technical tokens, and longer specific words receive a small score;
 * the winners are rendered in their original order so the result remains
 * recognizable as text the user actually wrote.
 */
export function deriveThreadTitle(input: string): string {
  const topicText = selectTopicText(input);
  const tokens = meaningfulTokens(topicText);
  if (tokens.length === 0) {
    const fallback = stripMarkup(topicText || input)
      .replace(/[.!?,;:]+$/g, '')
      .trim();
    if (!fallback) return 'Untitled';
    const clipped = fallback.slice(0, THREAD_TITLE_MAX_LENGTH);
    const boundary = clipped.length < fallback.length ? clipped.lastIndexOf(' ') : -1;
    return capitalizeFirstWord((boundary > 10 ? clipped.slice(0, boundary) : clipped).trim());
  }

  const unique = new Map<string, TitleToken>();
  const frequency = new Map<string, number>();
  for (const token of tokens) {
    frequency.set(token.key, (frequency.get(token.key) ?? 0) + 1);
    if (!unique.has(token.key)) unique.set(token.key, token);
  }

  const candidates = [...unique.values()];
  const selected =
    candidates.length <= MAX_TITLE_WORDS
      ? candidates
      : candidates
          .map((token) => ({
            token,
            score:
              (frequency.get(token.key) ?? 1) * 3 +
              Math.min(token.raw.length, 14) / 7 +
              (/\d|[._+#:/@-]/.test(token.raw) ? 2 : 0) +
              Math.max(0, 0.5 - token.position * 0.03),
          }))
          .sort((a, b) => b.score - a.score || a.token.position - b.token.position)
          .slice(0, MAX_TITLE_WORDS)
          .map(({ token }) => token)
          .sort((a, b) => a.position - b.position);

  return fitTitle(selected) || 'Untitled';
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
