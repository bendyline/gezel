/**
 * `[n]` citations: parse them out of model text and check, without a model,
 * that the facts a sentence states appear in the evidence it cites.
 *
 * The runtime numbers the evidence a model sees ([1] a catalog passage, [2] a
 * Wikipedia article, ...). Short numbers rather than `knowledge://` URIs
 * because small models mangle long identifiers and invent plausible ones; a
 * number the runtime assigned either exists or it does not.
 *
 * The checks are deliberately literal. Every number, year, month, quotation
 * and proper name in a cited sentence must appear in the text of the evidence
 * it cites. That catches the errors local models make most when they write
 * from memory or embellish a source — a wrong birth year, an invented
 * child, a "temporarily" turned into "permanently" is beyond it — and costs
 * microseconds, so it can run before every document write. A sentence with no
 * checkable detail is "cited" or "non-factual", never "supported": only a
 * model can judge it, and this module does not pretend to.
 */

export interface EvidenceItem {
  /** The number the model cites, `[n]`. */
  n: number;
  /** The evidence text the model was shown. */
  text: string;
  title?: string;
  /** `knowledge://…`, a workspace path, or a web URL. */
  ref?: string;
}

export type ClaimKind = 'year' | 'number' | 'month' | 'quote' | 'name';

export interface ClaimCheck {
  kind: ClaimKind;
  value: string;
  found: boolean;
}

export type SentenceStatus =
  /** No checkable detail and no citation: connective prose or opinion. */
  | 'non-factual'
  /** Cited, but nothing in it is checkable without a model. */
  | 'cited'
  /** Every checkable detail appears in the cited evidence. */
  | 'supported'
  /**
   * Every detail appears in the evidence, just not in what the sentence
   * cites (or it cites nothing): a citation slip, not an invention.
   */
  | 'unattributed'
  /** States details no evidence shows, and cites nothing. */
  | 'uncited'
  /** Cites a number that is not in the evidence list. */
  | 'bad-citation'
  /** States details that neither the cited evidence nor any other shows. */
  | 'unsupported';

export interface SentenceGrounding {
  /** The sentence without its citation markers. */
  text: string;
  cites: number[];
  status: SentenceStatus;
  checks: ClaimCheck[];
  /** Details no evidence shows (unsupported, uncited) or cites absent from the list (bad-citation). */
  missing: string[];
}

export interface TextGrounding {
  sentences: SentenceGrounding[];
  counts: Record<SentenceStatus, number>;
}

/** `[3]`, `[1, 4]`, `[2-5]`, `[2–5]`. */
const MARKER = /\[(\d{1,3}(?:\s*(?:[-–]|,)\s*\d{1,3})*)\]/g;

export function parseCitationNumbers(inner: string): number[] {
  const out: number[] = [];
  for (const part of inner.split(',')) {
    const range = /^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 50; n++) out.push(n);
    } else if (/^\s*\d{1,3}\s*$/.test(part)) out.push(Number(part));
  }
  return [...new Set(out)];
}

/** The text without `[n]` markers, spacing tidied. */
export function stripCitations(text: string): string {
  return text
    .replace(MARKER, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const ABBREVIATION =
  /(?:^|\s)(?:Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|Gen|Col|Lt|Capt|Rev|Gov|Sen|Rep|Pres|Prof|Fr|Sgt|Maj|Adm|Cpl|Hon|vs|etc|No|Vol|ca|approx|e\.g|i\.e|U\.S|U\.K)\.$|(?:^|\s)[A-Z]\.$/;

/** Prose sentences of a Markdown text, each with the markers that belong to it. */
export function citedSentences(markdown: string): Array<{ text: string; cites: number[] }> {
  const units: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*(?:#{1,6}\s|\||<!--|---\s*$|\*\*\*\s*$)/.test(line)) continue;
    const body = line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, '').trim();
    if (body) units.push(body);
  }
  const out: Array<{ text: string; cites: number[] }> = [];
  for (const unit of units) {
    // A marker written after the full stop belongs to the sentence before it.
    const normalized = unit.replace(/([.!?])((?:\s*\[\d[\d,\s–-]*\])+)/g, '$2$1');
    const pieces = normalized.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/);
    const sentences: string[] = [];
    for (const piece of pieces) {
      const previous = sentences.at(-1);
      if (previous !== undefined && ABBREVIATION.test(previous))
        sentences[sentences.length - 1] = `${previous} ${piece}`;
      else sentences.push(piece);
    }
    for (const sentence of sentences) {
      const cites: number[] = [];
      for (const m of sentence.matchAll(MARKER)) cites.push(...parseCitationNumbers(m[1] ?? ''));
      const text = stripCitations(sentence);
      if (text) out.push({ text, cites: [...new Set(cites)] });
    }
  }
  return out;
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
const SMALL_NUMBERS = [
  'zero',
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
  'eleven',
  'twelve',
];

/** Capitalized words that open clauses rather than name anything. */
const COMMON_CAPITALIZED = new Set(
  'a an the and but or nor so yet for if when while after before during although though because since until unless as at by from in into of on onto to with without within he she it they we you i his her its their our your my this that these those there here then today tonight yesterday tomorrow later earlier meanwhile however instead still also each every both either neither many most some few all one two three no not yes later once soon now who what where which why how'.split(
    ' ',
  ),
);
const NAME_JOINERS = new Set([
  'of',
  'de',
  'da',
  'del',
  'van',
  'von',
  'der',
  'la',
  'le',
  'du',
  'the',
  'and',
]);

/** The checkable details a sentence states. */
export function extractClaims(text: string): Array<{ kind: ClaimKind; value: string }> {
  // Code spans and link targets name things in a workspace or on the web,
  // not facts about the world; their digits and identifiers are not claims.
  const sentence = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/\bhttps?:\/\/\S+/g, ' ');
  const claims: Array<{ kind: ClaimKind; value: string }> = [];
  const seen = new Set<string>();
  const add = (kind: ClaimKind, value: string) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push({ kind, value });
    }
  };
  for (const m of sentence.matchAll(/["“]([^"”]{8,}?)["”]/g)) {
    if ((m[1] ?? '').trim().split(/\s+/).length >= 3) add('quote', (m[1] ?? '').trim());
  }
  const unquoted = sentence.replace(/["“][^"”]*["”]/g, ' ');
  for (const m of unquoted.matchAll(
    /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:st|nd|rd|th|s)?(?![\w.]*\d)/g,
  )) {
    const digits = (m[1] ?? '').replace(/,/g, '');
    const value = Number(digits);
    if (/^(1[0-9]{3}|20[0-9]{2})$/.test(digits)) add('year', digits);
    else if (Number.isFinite(value)) add('number', digits);
  }
  for (const m of unquoted.matchAll(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g,
  )) {
    // "May" as a modal verb is lowercase; capitalized mid-sentence it is the month.
    if (m.index !== 0 || m[1] !== 'May') add('month', m[1] ?? '');
  }
  const raw = unquoted.split(/\s+/);
  const tokens = raw.map((t) => t.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, ''));
  // A word after a colon or dash opens a clause, like the first word of a
  // sentence: "**Augustine Jr.**: Survived to adulthood" names no "Survived".
  const opensClause = (i: number) => i === 0 || /[:;—–]\**$/.test(raw[i - 1] ?? '');
  let run: string[] = [];
  let runStart = -1;
  const flush = () => {
    const words = run.filter((w) => !NAME_JOINERS.has(w.toLowerCase()));
    const startsSentence = runStart >= 0 && opensClause(runStart);
    if (words.length >= 2 || (words.length === 1 && !startsSentence)) {
      for (const word of words) {
        const bare = word.replace(/['’]s$/, '');
        if (
          bare.length > 1 &&
          !COMMON_CAPITALIZED.has(bare.toLowerCase()) &&
          !MONTHS.includes(bare.toLowerCase())
        )
          add('name', bare);
      }
    }
    run = [];
    runStart = -1;
  };
  tokens.forEach((token, i) => {
    if (
      /^\p{Lu}[\p{L}'’-]*$/u.test(token) &&
      !(opensClause(i) && COMMON_CAPITALIZED.has(token.toLowerCase()))
    ) {
      if (run.length === 0) runStart = i;
      run.push(token);
      // Punctuation ends a name: "Jr.**: Survived" is two runs, not one.
      if (/[:;,.!?)\]—–]\**$/.test(raw[i] ?? '')) flush();
    } else if (run.length > 0 && NAME_JOINERS.has(token.toLowerCase())) run.push(token);
    else flush();
  });
  flush();
  return claims;
}

const normalizeEvidence = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')} `;

/** Where a number or name occurs in normalized evidence. */
function claimPattern(kind: ClaimKind, value: string): RegExp {
  const v = value.toLowerCase();
  if (kind === 'year' || kind === 'number') {
    const n = Number(v);
    const digits = `(?<![\\d.])${v.replace('.', '\\.')}(?![\\d]|\\.\\d)`;
    return new RegExp(
      Number.isInteger(n) && n <= 12 ? `${digits}|\\b${SMALL_NUMBERS[n]}\\b` : digits,
      'g',
    );
  }
  return new RegExp(`(?<![\\p{L}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'gu');
}

function claimFound(kind: ClaimKind, value: string, evidence: string): boolean {
  if (kind === 'quote') {
    return evidence.includes(
      value.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' '),
    );
  }
  return claimPattern(kind, value).test(evidence);
}

/** How far apart a number and the name it belongs to may sit in a source. */
const NEAR_CHARS = 160;

/**
 * Years and numbers the evidence states, but never near any name the
 * sentence attaches them to. "Mildred Washington: Born 1737 [7]" passed a
 * presence check because [7] mentioned a Mildred and, elsewhere, 1737; the
 * wrong year for the right relative is the commonest family-tree error.
 */
function detachedNumbers(
  claims: ReadonlyArray<{ kind: ClaimKind; value: string }>,
  text: string,
): string[] {
  // The anchor is the sentence's rarest name in the source: in an article
  // about George Washington, "Washington" sits near every year it states,
  // while "Mildred" sits only near hers.
  let anchor: { value: string; count: number } | null = null;
  for (const claim of claims) {
    if (claim.kind !== 'name') continue;
    const count = [...text.matchAll(claimPattern('name', claim.value))].length;
    if (count > 0 && (!anchor || count < anchor.count)) anchor = { value: claim.value, count };
  }
  if (!anchor) return [];
  const near = new RegExp(claimPattern('name', anchor.value).source, 'u');
  const out: string[] = [];
  for (const claim of claims) {
    if (claim.kind !== 'year' && claim.kind !== 'number') continue;
    const placed = [...text.matchAll(claimPattern(claim.kind, claim.value))].some((m) => {
      const at = m.index ?? 0;
      return near.test(text.slice(Math.max(0, at - NEAR_CHARS), at + NEAR_CHARS));
    });
    if (!placed) out.push(`${claim.value} next to ${anchor.value}`);
  }
  return out;
}

export interface GroundOptions {
  /**
   * Numbers that were issued but whose text is no longer at hand (evidence
   * from before a restart). A sentence citing one is `cited`, never
   * `bad-citation`: the number was real, it just cannot be checked.
   */
  opaque?: (n: number) => boolean;
  /**
   * What the person said themselves. A detail found here needs no citation:
   * restating someone's own facts back to them is not invention.
   */
  given?: string;
}

interface GroundContext {
  evidence: ReadonlyMap<number, EvidenceItem>;
  normalized: Map<number, string>;
  /** Every evidence text plus what the person said, normalized once. */
  everything: string;
  given: string;
  opaque?: (n: number) => boolean;
}

function groundContext(
  evidence: ReadonlyMap<number, EvidenceItem>,
  options: GroundOptions,
): GroundContext {
  const given = options.given ? normalizeEvidence(options.given) : '';
  const normalized = new Map([...evidence].map(([n, item]) => [n, normalizeEvidence(item.text)]));
  return {
    evidence,
    normalized,
    everything: [...normalized.values()].join('\n') + given,
    given,
    ...(options.opaque ? { opaque: options.opaque } : {}),
  };
}

function checkAgainst(
  claims: Array<{ kind: ClaimKind; value: string }>,
  text: string,
): ClaimCheck[] {
  return claims.map((claim) => ({ ...claim, found: claimFound(claim.kind, claim.value, text) }));
}

/** "I could not verify…", "…is unconfirmed": the honest answer the rule asks for. */
const DISCLAIMS =
  /\b(?:could ?n[o']t|cannot|can't|was unable to|unable to|did ?n[o']t)\s+(?:be\s+)?(?:verif|confirm|find|locate)|\b(?:unverified|unconfirmed|not (?:been )?(?:verified|confirmed))\b|\bno (?:source|record)s?\b/i;

function groundWith(
  ctx: GroundContext,
  sentence: { text: string; cites: number[] },
): SentenceGrounding {
  if (sentence.cites.length === 0 && DISCLAIMS.test(sentence.text)) {
    return { ...sentence, status: 'non-factual', checks: [], missing: [] };
  }
  const claims = extractClaims(sentence.text);
  const opaque = sentence.cites.filter((n) => !ctx.evidence.has(n) && ctx.opaque?.(n));
  const badCites = sentence.cites.filter((n) => !ctx.evidence.has(n) && !opaque.includes(n));
  if (badCites.length > 0) {
    return {
      ...sentence,
      status: 'bad-citation',
      checks: [],
      missing: badCites.map((n) => `[${n}]`),
    };
  }
  if (claims.length === 0) {
    return {
      ...sentence,
      status: sentence.cites.length > 0 ? 'cited' : 'non-factual',
      checks: [],
      missing: [],
    };
  }
  if (opaque.length > 0) return { ...sentence, status: 'cited', checks: [], missing: [] };
  const holds = (text: string) => {
    const checks = checkAgainst(claims, text);
    return checks.every((c) => c.found) && detachedNumbers(claims, text).length === 0
      ? checks
      : null;
  };
  if (sentence.cites.length > 0) {
    const cited = sentence.cites.map((n) => ctx.normalized.get(n) ?? '').join('\n') + ctx.given;
    const checks = holds(cited);
    if (checks) return { ...sentence, status: 'supported', checks, missing: [] };
  } else if (ctx.given) {
    const checks = holds(ctx.given);
    if (checks) return { ...sentence, status: 'supported', checks, missing: [] };
  }
  const checks = checkAgainst(claims, ctx.everything);
  const absent = checks.filter((c) => !c.found).map((c) => c.value);
  const missing = absent.length > 0 ? absent : detachedNumbers(claims, ctx.everything);
  if (missing.length === 0) return { ...sentence, status: 'unattributed', checks, missing };
  return {
    ...sentence,
    status: sentence.cites.length > 0 ? 'unsupported' : 'uncited',
    checks,
    missing,
  };
}

/** Ground one sentence against the numbered evidence. */
export function groundSentence(
  sentence: { text: string; cites: number[] },
  evidence: ReadonlyMap<number, EvidenceItem>,
  options: GroundOptions = {},
): SentenceGrounding {
  return groundWith(groundContext(evidence, options), sentence);
}

/** Ground every prose sentence of a Markdown text against the numbered evidence. */
export function groundText(
  markdown: string,
  evidence: readonly EvidenceItem[],
  options: GroundOptions = {},
): TextGrounding {
  const ctx = groundContext(new Map(evidence.map((item) => [item.n, item])), options);
  const sentences = citedSentences(markdown).map((s) => groundWith(ctx, s));
  const counts: Record<SentenceStatus, number> = {
    'non-factual': 0,
    cited: 0,
    supported: 0,
    unattributed: 0,
    uncited: 0,
    'bad-citation': 0,
    unsupported: 0,
  };
  for (const s of sentences) counts[s.status]++;
  return { sentences, counts };
}

/** The sentences a writer must fix before the text may be written, worst first. */
export function groundingProblems(grounding: TextGrounding): SentenceGrounding[] {
  const rank: Partial<Record<SentenceStatus, number>> = {
    'bad-citation': 0,
    unsupported: 1,
    uncited: 2,
  };
  return grounding.sentences
    .filter((s) => rank[s.status] !== undefined)
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
}

/** One line per problem sentence, for a tool error or a repair prompt. */
export function describeGroundingProblems(problems: readonly SentenceGrounding[], max = 8): string {
  const lines = problems.slice(0, max).map((s) => {
    const quoted = `"${s.text.length > 160 ? `${s.text.slice(0, 157)}…` : s.text}"`;
    if (s.status === 'bad-citation')
      return `- ${quoted} cites ${s.missing.join(', ')}, which is not in the evidence list.`;
    const details = s.missing.map((m) => `"${m}"`).join(', ');
    if (s.status === 'uncited')
      return `- ${quoted} cites nothing, and no evidence shows ${details}.`;
    return `- ${quoted}: ${details} not found in ${s.cites.map((n) => `[${n}]`).join(', ')} or any other evidence.`;
  });
  if (problems.length > max) lines.push(`- …and ${problems.length - max} more.`);
  return lines.join('\n');
}
