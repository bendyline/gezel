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
  enum?: readonly unknown[];
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

/**
 * Words a goal is phrased in rather than what it is about, never a type's
 * signature even when only one type carries them. Event Planner's "planning"
 * tied a meester's "planning healthy, mostly vegetarian meals" with Meal
 * Planner, so the brief routed nowhere and a build crew got the week of meals
 * (2026-10-14). "go", "words" and "home" read "let's go to Lisbon", "500
 * words on…" and "at home" as a board game, a word game and a house manual.
 */
const GENERIC_TAGS = new Set([
  'planning',
  'go',
  'words',
  'home',
  'business',
  'design',
  'study',
  'training',
  'documents',
  'development',
  'community',
  'drive',
  'offer',
  'drafting',
]);

/** A tag counts toward a type only when no other candidate shares it. */
function distinctiveTags(types: readonly BriefRoutableType[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const type of types) {
    for (const raw of type.tags ?? []) {
      const tag = raw.trim().toLowerCase();
      if (!tag || QUERY_STOP_WORDS.has(tag) || GENERIC_TAGS.has(tag)) continue;
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
  // A plural tag names its singular too: a meester brief that said only
  // "meal plan" never reached Meal Planner's "meals" (2026-10-14).
  if (tag.length >= 4 && tag.endsWith('s') && token === tag.slice(0, -1)) return true;
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
  const named = namedProjectType(brief, types);
  if (!named) return null;
  const { type, hits } = named;
  const filled = fillProjectTypeParams(type.params, brief);
  if (!filled) return null;
  const dataFile = type.pages?.reads?.find((read) => read.source === 'workspace')?.path;
  return {
    typeId: type.id,
    hits,
    params: filled.params,
    assumed: filled.assumed,
    ...(dataFile ? { dataFile } : {}),
  };
}

/**
 * The project type a brief's words name, whether or not they also carry
 * its required details. A kickoff reads the person's own sentence for those
 * details only when the brief names the same type, so a message with two
 * goals in it never lends one goal's type to the other's brief.
 */
export function projectTypeNamedByBrief(
  brief: string,
  types: readonly BriefRoutableType[],
): string | null {
  return namedProjectType(brief, types)?.type.id ?? null;
}

/**
 * Every routable type the brief's distinctive tags touch, ties included. A
 * kickoff uses it to let the person's own sentence settle a brief the meester
 * worded more loosely: "planning healthy meals" touches two types, and the
 * person's "plan a week of meals" names which one they meant.
 */
export function projectTypesMentionedByBrief(
  brief: string,
  types: readonly BriefRoutableType[],
): string[] {
  if (!brief.trim() || briefAsksForBuild(brief)) return [];
  return [...typeHits(brief, types).keys()];
}

function typeHits(brief: string, types: readonly BriefRoutableType[]): Map<string, string[]> {
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
  return hitsByType;
}

function namedProjectType(
  brief: string,
  types: readonly BriefRoutableType[],
): { type: BriefRoutableType; hits: string[] } | null {
  if (!brief.trim() || briefAsksForBuild(brief)) return null;
  const candidates = types.filter(isRoutable);
  const hitsByType = typeHits(brief, types);
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
  return type ? { type, hits: best.hits.sort() } : null;
}

type ParamKind =
  | 'place'
  | 'when'
  | 'occasion'
  | 'language'
  | 'party'
  | 'household'
  | 'subject'
  | 'role'
  | 'business'
  | 'brand';

function paramKind(key: string, param: BriefRoutableParam): ParamKind | null {
  const label = `${key} ${param.title ?? ''}`.toLowerCase();
  if (/\b(?:destination|where|city|country|place|location)\b/.test(label)) return 'place';
  if (/\b(?:date|start|when|departure|departing)\b/.test(label)) return 'when';
  if (/\b(?:travell?ers?|who'?s\s+going|party\s+size|headcount)\b/.test(label)) return 'party';
  if (/\b(?:occasion|celebrat\w*)\b/.test(label)) return 'occasion';
  if (/\blanguage\b/.test(label)) return 'language';
  if (/\b(?:household|who eats)\b/.test(label)) return 'household';
  if (/\b(?:subject|topic|learning|studying)\b/.test(label)) return 'subject';
  if (/\brole\b/.test(label)) return 'role';
  if (key === 'business' || /\b(?:what do you do|occupation|profession)\b/.test(label)) {
    return 'business';
  }
  if (/\b(?:brand|speak for)\b/.test(label)) return 'brand';
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
    // A required choice from a fixed list (a chess opponent's table talk) is
    // a style, not a fact the person left out: its default is a fair start.
    if (
      required.has(key) &&
      Array.isArray(param.enum) &&
      typeof param.default === 'string' &&
      param.enum.includes(param.default)
    ) {
      params[key] = param.default;
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
    case 'household':
      return readHousehold(brief);
    case 'subject':
      return readSubject(brief);
    case 'role':
      return readRole(brief);
    case 'business':
      return readBusiness(brief);
    case 'brand':
      return readBrand(brief);
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

// A period belongs to a place word only as an abbreviation ("St. Louis") or
// an initialism ("D.C."). Allowing it anywhere kept a sentence's full stop
// ("Lisbon.") and ran across sentences ("Rome. I want…" read as "Rome. I").
const PLACE_WORD = "(?:(?:St|Ste|Mt|Ft|Pt)\\.|\\p{Lu}(?:\\.\\p{Lu})+\\.?|[\\p{Lu}][\\p{L}'’-]*)";
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

/**
 * Words that open "trip to …" without naming a place: an infinitive ("trip to
 * see my grandparents"), a count ("trip in two weeks"), or a plural span.
 */
const NOT_A_PLACE = new Set([
  'a',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'few',
  'couple',
  'several',
  'days',
  'weeks',
  'weekends',
  'months',
  'years',
  'see',
  'visit',
  'meet',
  'celebrate',
  'attend',
  'explore',
  'discover',
  'find',
  'go',
  'get',
  'do',
  'make',
  'watch',
  'play',
  'hike',
  'ski',
  'surf',
  'relax',
  'unwind',
  'rest',
  'stay',
  'spend',
  'enjoy',
  'catch',
  'learn',
  'shop',
  'eat',
  'try',
  'take',
  'bring',
  'show',
  'help',
  'escape',
  'reconnect',
  'recharge',
]);

function readPlace(brief: string): string | null {
  for (const match of brief.matchAll(PLACE_RE)) {
    const phrase = match[1]!.trim();
    const words = phrase.split(/\s+/);
    // Trim a trailing time word ("Portugal Next" only if capitalised mid-sentence),
    // and the pronoun that opens the next sentence after an initialism ("D.C. I").
    while (
      words.length > 0 &&
      (TIME_WORDS.has(words[words.length - 1]!.toLowerCase()) || words[words.length - 1] === 'I')
    )
      words.pop();
    const head = words.find((w) => w.toLowerCase() !== 'the');
    if (!head || TIME_WORDS.has(head.toLowerCase())) continue;
    if (QUERY_STOP_WORDS.has(head.toLowerCase())) continue;
    return words.join(' ');
  }
  for (const match of brief.matchAll(LOWER_PLACE_RE)) {
    const words = match[1]!.split(/\s+/);
    if (words[0] === 'the') words.shift();
    // Judged by its first word: dropping only the offending word turned
    // "trip to visit grandma" into "Grandma" and "trip to my parents" into
    // "Parents". "new" is a search stop word but opens real places.
    const [first, second] = words;
    if (
      !first ||
      TIME_WORDS.has(first) ||
      NOT_A_PLACE.has(first) ||
      (QUERY_STOP_WORDS.has(first) && first !== 'new')
    )
      continue;
    const keepSecond =
      second !== undefined &&
      !TIME_WORDS.has(second) &&
      !NOT_A_PLACE.has(second) &&
      !QUERY_STOP_WORDS.has(second);
    return titleCase(keepSecond ? `${first} ${second}` : first);
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
    const bare = phrase.replace(/\.$/, '').toLowerCase() === month.toLowerCase();
    // Alone, "may" is usually the verb, lowercase "mar"/"sep"/"june" are words,
    // and a capitalised abbreviation is as often a name ("with Jan"). Beside a
    // day or a year ("june 12", "Jan 2027") each is a date.
    if (bare && month.toLowerCase() === 'may' && month !== 'May') continue;
    if (bare && /^[a-z]/.test(month) && month.length <= 4) continue;
    if (bare && month !== 'May' && new RegExp(`^${MONTH_ABBREV}$`).test(month)) continue;
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

const MEMBER =
  '(?:adults?|people|grown-ups|kids?|children|child|toddlers?|teens?|teenagers?|bab(?:y|ies))';

/** Who a household is, in the person's own words: "two adults and a toddler". */
function readHousehold(brief: string): string | null {
  const counted = brief.match(
    new RegExp(
      `\\b${COUNT}\\s+${MEMBER}(?:\\s*(?:,|and|&|\\+)\\s*(?:a|an|${COUNT})\\s+${MEMBER})*`,
      'i',
    ),
  );
  if (counted) return counted[0].trim();
  const us = brief.match(
    new RegExp(`\\b(?:the\\s+)?${COUNT}\\s+of\\s+us\\b|\\bfamily\\s+of\\s+${COUNT}\\b`, 'i'),
  );
  return us ? us[0].trim() : null;
}

/** What is being learned: "flashcards for the capitals of Europe", "learn Italian verbs". */
function readSubject(brief: string): string | null {
  const patterns = [
    /\bflash\s?cards?\s+(?:for|on|about|of)\s+([^.,;!?\n]{3,60})/i,
    /\b(?:learn|learning|study|studying|revise|revising|memori[sz]e)\s+([^.,;!?\n]{3,60})/i,
  ];
  for (const pattern of patterns) {
    const match = brief.match(pattern);
    if (!match) continue;
    const words = match[1]!
      .replace(/\s+(?:with|using|by|before|so|because)\b.*$/i, '')
      .replace(/^(?:about|how to)\s+/i, '')
      .trim();
    if (words.length >= 3) return words;
  }
  return null;
}

/** The job being hunted: "an interview as a product designer" → "product designer". */
function readRole(brief: string): string | null {
  if (!/\b(?:job|role|position|interview|hiring|career)\b/i.test(brief)) return null;
  const match = brief.match(
    /\bas\s+(?:a|an)\s+((?:[\p{L}-]+\s+){0,3}?[\p{L}-]+?)(?=\s+(?:role|job|position|next|this|at|in|for|with)\b|[.,;!?\n]|$)/iu,
  );
  return match ? match[1]!.trim() : null;
}

/** What someone does for a living: "I'm a freelance logo designer". */
function readBusiness(brief: string): string | null {
  const match = brief.match(
    /\bI(?:'|’)?m\s+(?:a|an)\s+((?:[\p{L}-]+\s+){0,3}?[\p{L}-]+?)(?=\s+(?:and|who|based|from|in|for|with)\b|[.,;!?\n]|$)/iu,
  );
  if (match) return match[1]!.trim();
  const own = brief.match(BUSINESS_RE);
  return own ? own[1]!.trim() : null;
}

const VENTURE =
  '(?:studio|shop|bakery|business|brand|company|caf[eé]|band|podcast|channel|restaurant|store|agency|practice|club|school|salon|gallery|roastery|brewery|winery|distillery|farm|bistro|bar|pub|firm|startup|nonprofit|charity|clinic|gym|boutique|label|blog|newsletter)';
const BUSINESS_RE = new RegExp(`\\b(?:my|our)\\s+((?:[\\p{L}'’-]+\\s+){0,3}${VENTURE})\\b`, 'iu');

/** Who a feed speaks for: "posts for my pottery studio" → "pottery studio". */
function readBrand(brief: string): string | null {
  const match = brief.match(BUSINESS_RE);
  return match ? match[1]!.trim() : null;
}
