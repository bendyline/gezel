/**
 * Which project type, if any, a new goal belongs to — decided without a
 * model, from the words of the brief.
 *
 * The meester's kickoff used to send every goal to a generic build crew:
 * "plan a family trip to Portugal" got a Developer building `index.html`,
 * while the catalog shipped a Trip Planner with a Reisleider and a trip
 * dashboard. This picks the type when the brief clearly names its subject,
 * and fills the type's parameters from the same words.
 *
 * Precision over recall. A type matches only on a tag no other type shares
 * ("trip", not "planning" or "family"), a brief that asks for something to
 * be built (a website, an app, a game) is never routed to a type, and a type
 * whose required parameters cannot all be read from the brief does not
 * match. Every miss falls back to the ordinary kickoff, so a wrong guess is
 * the only real failure.
 */

import { QUERY_STOP_WORDS } from '@bendyline/gezk';

/** The slice of a project-type manifest routing reads. */
export interface BriefRoutableType {
  id: string;
  name: string;
  tags?: readonly string[];
  params?: {
    properties?: Record<string, BriefRoutableParam>;
    required?: readonly string[];
  };
  gezels?: ReadonlyArray<{ templateId: string; voorman?: boolean }>;
  pages?: { reads?: ReadonlyArray<{ source: string; path: string }> };
}

export interface BriefRoutableParam {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
}

export interface BriefTypeMatch {
  typeId: string;
  /** The distinctive tags the brief named. */
  hits: string[];
  /** Values for every parameter the brief supplied, plus "soon" for an unnamed date. */
  params: Record<string, string>;
  /** Parameters filled with a neutral value because the brief did not say. */
  assumed: string[];
  /** The workspace file the type's Output page reads first, if any. */
  dataFile?: string;
}

/**
 * The words that mean "make me software". A request for a website, a web
 * page or something in HTML is a build whatever its subject; "app" and
 * "game" count only after a making verb, so "play chess" and "a trip
 * planner app" still read as the goal they are about.
 */
export function briefAsksForBuild(text: string): boolean {
  if (/\b(?:web\s?sites?|web\s?pages?|landing\s+pages?|web\s?apps?|html)\b|\.html?\b/i.test(text)) {
    return true;
  }
  return /\b(?:build|make|create|code|program|develop|design)\b[^.!?\n]{0,60}\b(?:apps?|games?|sites?)\b/i.test(
    text,
  );
}

/** A tag counts toward a type only when no other candidate shares it. */
function distinctiveTags(types: readonly BriefRoutableType[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const type of types) {
    for (const raw of type.tags ?? []) {
      const tag = raw.trim().toLowerCase();
      if (!tag || QUERY_STOP_WORDS.has(tag)) continue;
      const set = owners.get(tag) ?? new Set<string>();
      set.add(type.id);
      owners.set(tag, set);
    }
  }
  const unique = new Map<string, string>();
  for (const [tag, ids] of owners) {
    if (ids.size === 1) unique.set(tag, [...ids][0]!);
  }
  return unique;
}

function briefTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [])
    .map((t) => t.replace(/['’]s$/, ''))
    .filter((t) => !QUERY_STOP_WORDS.has(t));
}

function tokenNamesTag(token: string, tag: string): boolean {
  if (token === tag || token === `${tag}s` || token === `${tag}es`) return true;
  // "traveling" names "travel"; short tags need the whole word.
  return tag.length >= 5 && token.startsWith(tag);
}

/** A type can carry a first run only with a lead to hand it to. */
function isRoutable(type: BriefRoutableType): boolean {
  return (type.gezels ?? []).some((g) => g.voorman === true);
}

export function matchProjectTypeForBrief(
  brief: string,
  types: readonly BriefRoutableType[],
): BriefTypeMatch | null {
  if (!brief.trim() || briefAsksForBuild(brief)) return null;
  // Distinctive across the whole catalog: "writing" is shared with a chat
  // type even though only one of the two has a lead to route to.
  const unique = distinctiveTags(types);
  const candidates = types.filter(isRoutable);
  const tokens = briefTokens(brief);
  const hitsByType = new Map<string, string[]>();
  for (const [tag, typeId] of unique) {
    if (!candidates.some((t) => t.id === typeId)) continue;
    if (!tokens.some((token) => tokenNamesTag(token, tag))) continue;
    hitsByType.set(typeId, [...(hitsByType.get(typeId) ?? []), tag]);
  }
  let best: { id: string; hits: string[] } | null = null;
  let tied = false;
  for (const [id, hits] of hitsByType) {
    if (!best || hits.length > best.hits.length) {
      best = { id, hits };
      tied = false;
    } else if (hits.length === best.hits.length) {
      tied = true;
    }
  }
  if (!best || tied) return null;
  const type = candidates.find((t) => t.id === best.id);
  if (!type) return null;
  const filled = fillProjectTypeParams(type.params, brief);
  if (!filled) return null;
  const dataFile = type.pages?.reads?.find((read) => read.source === 'workspace')?.path;
  return {
    typeId: type.id,
    hits: best.hits.sort(),
    params: filled.params,
    assumed: filled.assumed,
    ...(dataFile ? { dataFile } : {}),
  };
}

type ParamKind = 'place' | 'when' | 'occasion' | 'language' | 'party';

function paramKind(key: string, param: BriefRoutableParam): ParamKind | null {
  const label = `${key} ${param.title ?? ''}`.toLowerCase();
  if (/\b(?:destination|where|city|country|place|location)\b/.test(label)) return 'place';
  if (/\b(?:date|start|when|departure|departing)\b/.test(label)) return 'when';
  if (/\b(?:travell?ers?|who'?s\s+going|party\s+size|headcount)\b/.test(label)) return 'party';
  if (/\b(?:occasion|celebrat\w*)\b/.test(label)) return 'occasion';
  if (/\blanguage\b/.test(label)) return 'language';
  return null;
}

/**
 * Read each parameter the brief supplies. Null when a required parameter
 * cannot be read: the type would otherwise open on its schema placeholder
 * ("somewhere wonderful"), presenting a guess as the person's answer. A
 * date the brief does not name is the one exception — it becomes "soon",
 * which the type's pages read as "no date yet" rather than a made-up one.
 */
export function fillProjectTypeParams(
  schema: BriefRoutableType['params'],
  brief: string,
): { params: Record<string, string>; assumed: string[] } | null {
  const params: Record<string, string> = {};
  const assumed: string[] = [];
  const required = new Set(schema?.required ?? []);
  for (const [key, param] of Object.entries(schema?.properties ?? {})) {
    const kind = paramKind(key, param);
    const value = kind ? readParam(kind, brief) : null;
    if (value) {
      params[key] = value;
      continue;
    }
    if (kind === 'when') {
      params[key] = 'soon';
      assumed.push(key);
      continue;
    }
    if (required.has(key)) return null;
  }
  return { params, assumed };
}

function readParam(kind: ParamKind, brief: string): string | null {
  switch (kind) {
    case 'place':
      return readPlace(brief);
    case 'when':
      return readWhen(brief);
    case 'occasion':
      return readOccasion(brief);
    case 'language':
      return readLanguage(brief);
    case 'party':
      return readParty(brief);
  }
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const TIME_WORDS = new Set([
  ...MONTHS,
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'spring',
  'summer',
  'autumn',
  'fall',
  'winter',
  'next',
  'this',
  'week',
  'weekend',
  'month',
  'year',
  'today',
  'tomorrow',
  'soon',
]);

const PLACE_WORD = "[\\p{Lu}][\\p{L}'’.-]*";
const PLACE_JOIN = '(?:of|de|del|di|da|la|le|du|on|upon|am|an)';
// A place stays on one line: the brief joins the project name and its about
// with a newline, and "Portugal\nPlan a family trip" is not "Portugal Plan".
const SP = '[^\\S\\r\\n]+';
const PLACE_RE = new RegExp(
  `\\b(?:to|in|around|visit|visiting|through|across)${SP}((?:the${SP})?${PLACE_WORD}(?:${SP}(?:${PLACE_JOIN}${SP})?${PLACE_WORD}){0,3})`,
  'gu',
);
const LOWER_PLACE_RE =
  /\b(?:trip|travel|travelling|traveling|vacation|holiday|getaway|journey|visit)[^\S\r\n]+(?:to|in)[^\S\r\n]+([\p{Ll}][\p{L}'’-]+(?:[^\S\r\n]+[\p{Ll}][\p{L}'’-]+)?)/gu;

function titleCase(words: string): string {
  return words
    .split(/\s+/)
    .map((w) => (w ? `${w[0]!.toUpperCase()}${w.slice(1)}` : w))
    .join(' ');
}

function readPlace(brief: string): string | null {
  for (const match of brief.matchAll(PLACE_RE)) {
    const phrase = match[1]!.trim();
    const words = phrase.split(/\s+/);
    // Trim a trailing time word ("Portugal Next" only if capitalised mid-sentence).
    while (words.length > 0 && TIME_WORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
    const head = words.find((w) => w.toLowerCase() !== 'the');
    if (!head || TIME_WORDS.has(head.toLowerCase())) continue;
    if (QUERY_STOP_WORDS.has(head.toLowerCase())) continue;
    return words.join(' ');
  }
  for (const match of brief.matchAll(LOWER_PLACE_RE)) {
    const words = match[1]!
      .split(/\s+/)
      .filter((w) => !TIME_WORDS.has(w) && !QUERY_STOP_WORDS.has(w));
    if (words.length > 0) return titleCase(words.join(' '));
  }
  return null;
}

const MONTH_NAMES = `(?:${MONTHS.join('|')})`;
const MONTH_ABBREV = '(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';

function readWhen(brief: string): string | null {
  const iso = brief.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const dated = new RegExp(
    `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(${MONTH_NAMES}|${MONTH_ABBREV})\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:,?\\s+\\d{4})?\\b`,
    'gi',
  );
  for (const match of brief.matchAll(dated)) {
    const phrase = match[0].trim();
    const month = match[1]!;
    const bare = phrase.toLowerCase() === month.toLowerCase();
    // "may" is usually the verb, and lowercase "mar"/"sep" are words.
    if (bare && month.toLowerCase() === 'may' && month !== 'May') continue;
    if (/^[a-z]/.test(month) && month.length <= 4 && month.toLowerCase() !== 'may') continue;
    return phrase;
  }
  const season = brief.match(
    /\b(?:(?:early|late|mid)[\s-])?(?:next|this)\s+(?:spring|summer|autumn|fall|winter)\b|\b(?:spring|summer|autumn|fall|winter)\s+\d{4}\b/i,
  );
  if (season) return season[0].toLowerCase();
  const relative = brief.match(
    /\b(?:next|this)\s+(?:week|weekend|month|year)\b|\bin\s+(?:\d+|two|three|four|five|six|a\s+few|a\s+couple\s+of)\s+(?:weeks|months)\b|\btomorrow\b/i,
  );
  if (relative) return relative[0].toLowerCase();
  return null;
}

const OCCASION_NOUNS =
  '(?:wedding|party|reunion|birthday|anniversary|celebration|baby\\s+shower|graduation|retirement|gathering|dinner\\s+party)';

const OCCASION_VERBS = new Set([
  'plan',
  'planning',
  'organize',
  'organise',
  'arrange',
  'host',
  'throw',
  'prepare',
  'celebrate',
  'run',
]);

function readOccasion(brief: string): string | null {
  const match = brief.match(
    new RegExp(
      `\\b(?:(?:our|my|a|the|his|her|their|[\\p{Lu}][\\p{L}]+['’]s)\\s+)?(?:[\\p{L}\\p{N}]+\\s+)?${OCCASION_NOUNS}\\b`,
      'iu',
    ),
  );
  if (!match) return null;
  const words = match[0].trim().split(/\s+/);
  // Drop a request verb the optional word slot swallowed ("plan wedding").
  if (words.length > 1 && OCCASION_VERBS.has(words[0]!.toLowerCase())) words.shift();
  return words.join(' ');
}

const LANGUAGES = [
  'Arabic',
  'Chinese',
  'Czech',
  'Danish',
  'Dutch',
  'English',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hebrew',
  'Hindi',
  'Hungarian',
  'Indonesian',
  'Irish',
  'Italian',
  'Japanese',
  'Korean',
  'Latin',
  'Mandarin',
  'Norwegian',
  'Polish',
  'Portuguese',
  'Russian',
  'Spanish',
  'Swahili',
  'Swedish',
  'Thai',
  'Turkish',
  'Ukrainian',
  'Vietnamese',
  'Welsh',
];

function readLanguage(brief: string): string | null {
  const match = brief.match(new RegExp(`\\b(${LANGUAGES.join('|')})\\b`, 'i'));
  if (!match) return null;
  return LANGUAGES.find((l) => l.toLowerCase() === match[1]!.toLowerCase()) ?? null;
}

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const COUNT = `(\\d{1,2}|${Object.keys(COUNT_WORDS).join('|')})`;

function count(word: string): number {
  return COUNT_WORDS[word.toLowerCase()] ?? Number(word);
}

/**
 * How many are going, as a number. Only phrasings that state the whole
 * party count: "with 3 friends" is four people or three, so it reads as
 * nothing rather than a guess.
 */
function readParty(brief: string): string | null {
  const split = brief.match(
    new RegExp(
      `\\b${COUNT}\\s+adults?\\s+(?:and|&|\\+)\\s+${COUNT}\\s+(?:kids?|children|child|teens?|teenagers?|toddlers?|bab(?:y|ies))\\b`,
      'i',
    ),
  );
  if (split) return String(count(split[1]!) + count(split[2]!));
  const whole = brief.match(
    new RegExp(
      `\\b(?:the|all)\\s+${COUNT}\\s+of\\s+us\\b|\\bfamily\\s+of\\s+${COUNT}\\b|\\bfor\\s+${COUNT}\\s+(?:people|persons|adults|travell?ers)\\b`,
      'i',
    ),
  );
  const n = whole?.slice(1).find((g) => g !== undefined);
  if (n) return String(count(n));
  if (
    /\b(?:my\s+(?:wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?)\s+and\s+(?:i|me)|me\s+and\s+my\s+(?:wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?)|honeymoon)\b/i.test(
      brief,
    )
  ) {
    return '2';
  }
  if (/\b(?:just\s+me|solo\s+trip|by\s+myself|on\s+my\s+own)\b/i.test(brief)) return '1';
  return null;
}
