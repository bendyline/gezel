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
    // A line that is all bold is a heading by another name ("**What the dry
    // run proved**"), not a sentence to check.
    if (
      inFence ||
      /^\s*(?:#{1,6}\s|\||<!--|---\s*$|\*\*\*\s*$)/.test(line) ||
      /^\s*(?:[-*+]\s+)?\*\*[^*]+\*\*:?\s*$/.test(line)
    )
      continue;
    const body = line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, '').trim();
    if (body) units.push(body);
  }
  const out: Array<{ text: string; cites: number[] }> = [];
  for (const unit of units) {
    // A marker written after the full stop belongs to the sentence before it.
    const normalized = unit.replace(/([.!?])((?:\s*\[\d[\d,\s–-]*\])+)/g, '$2$1');
    // A bold or italic lead opens a sentence too, and so does the word after
    // one that ends in a full stop: unsplit, "… on timing. **Winner:** …" and
    // "**Error rate.** Baseline was …" read "Winner" and "Baseline" as names.
    const pieces = normalized.split(
      /(?<=[.!?](?:\*\*|__|\*|_)?["”’)]?)\s+(?=(?:\*\*|__|\*|_|["“‘(])?[A-Z0-9])/,
    );
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
/**
 * Technical acronyms are vocabulary, not names a source must state: "HTTP
 * 504" was refused because the chat log said only "504s" (2026-10-07,
 * incident-postmortem).
 */
const TECHNICAL_ACRONYMS = new Set(
  'http https api url uri utc gmt json csv xml html css sql cpu gpu ram ssd dns tls ssl sdk cli ci cd pr id ui ux os vm qa sla slo sli rps qps eur usd gbp kb mb gb tb ms pdf faq'.split(
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
  // So does the first word of a list item or quote line: "- **Caveat:** …"
  // and "1. Salivary amylase …" named "Caveat" and "Salivary" until the
  // marker counted as the start of the line (2026-10-06 review).
  const opensClause = (i: number) =>
    i === 0 ||
    /[:;—–]\**$/.test(raw[i - 1] ?? '') ||
    /^(?:[-*+>•]|\d{1,3}[.)])$/.test(raw[i - 1] ?? '');
  // "CO₂", "CO2": a formula, not a name called "CO".
  const isFormula = (i: number) => /\p{Lu}\p{L}*[0-9₀-₉]/u.test(raw[i] ?? '');
  let run: string[] = [];
  let runStart = -1;
  const flush = () => {
    const words = run.filter((w) => !NAME_JOINERS.has(w.toLowerCase()));
    const startsSentence = runStart >= 0 && opensClause(runStart);
    // A sentence opener is a name only when another real name runs with it:
    // "Mira Chen assumed IC" names Mira, "Clean IC handoff" does not name Clean.
    const named =
      startsSentence && words.filter((w) => isEntityName(w)).length < 2 ? words.slice(1) : words;
    for (const word of named) {
      const bare = word.replace(/['’]s$/, '');
      if (
        bare.length > 1 &&
        !COMMON_CAPITALIZED.has(bare.toLowerCase()) &&
        !TECHNICAL_ACRONYMS.has(bare.toLowerCase()) &&
        !MONTHS.includes(bare.toLowerCase())
      )
        add('name', bare);
    }
    run = [];
    runStart = -1;
  };
  tokens.forEach((token, i) => {
    if (
      /^\p{Lu}[\p{L}'’-]*$/u.test(token) &&
      // All capitals is emphasis or an acronym ("NOT APPLICABLE", "PASS"),
      // not a name a source has to state.
      !/^\p{Lu}{2,}$/u.test(token) &&
      !isFormula(i) &&
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

/**
 * "1,426" and "240,000" lose their separators so they match "1426"; a CSV
 * row does not. Folding every digit-comma-three-digits ran the columns of
 * `14:25:00,1240,0.3,218,42` together into `0.3218`, and every p99 a
 * postmortem quoted from metrics.csv read as invented (2026-10-07,
 * incident-postmortem).
 */
const THOUSANDS = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d|,\d)/g;

const normalizeEvidence = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(THOUSANDS, (n) => n.replace(/,/g, ''))
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
  // A name matches its plural and possessive: "the Tuesday sync" against
  // "syncs on Tuesdays" was refused (2026-10-07, conflict-synthesis).
  return new RegExp(
    `(?<![\\p{L}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:['’]?s)?(?![\\p{L}])`,
    'gu',
  );
}

const QUOTE_EDGE_PUNCTUATION = /^[\s,.;:!?…]+|[\s,.;:!?…]+$/g;

/**
 * A quote is normalized exactly like the evidence it is looked up in, or
 * "The launch budget is 240,000 EUR" never matches the source's own words
 * (the evidence side drops the thousands comma). Punctuation at its edges is
 * the writer's ("Weekly syncs on Tuesdays," for a source ending in a period),
 * and an elided quote must match each of its pieces (2026-10-07,
 * conflict-synthesis: three verbatim quotes refused).
 */
function quoteFound(value: string, evidence: string): boolean {
  const pieces = normalizeEvidence(value)
    .split(/…|\.\.\./)
    .map((piece) => piece.replace(QUOTE_EDGE_PUNCTUATION, ''))
    .filter(Boolean);
  return pieces.length > 0 && pieces.every((piece) => evidence.includes(piece));
}

function claimFound(kind: ClaimKind, value: string, evidence: string): boolean {
  if (kind === 'quote') return quoteFound(value, evidence);
  if (claimPattern(kind, value).test(evidence)) return true;
  // "5.18 s", "~5.1 s" and "0.8 s" restate 5180, 5090 and 800 ms: a decimal
  // also counts when the source states it a thousandfold (ms, KB, mm),
  // rounded to the places the writer kept.
  if (kind === 'number' && value.includes('.')) {
    const target = Number(value);
    const tolerance = 0.5 * 10 ** -(value.split('.')[1]?.length ?? 0) + 1e-9;
    for (const m of evidence.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d]|\.\d)/g)) {
      if (Math.abs(Number(m[0]) / 1000 - target) <= tolerance) return true;
    }
  }
  return false;
}

/**
 * Whether a capitalized word can be what a number belongs to. Acronyms and
 * code identifiers ("UTC", "READY", "PaymentGateway") are still checked for
 * presence, but as anchors they read "pipeline 8147 at 14:30 UTC" as 8147
 * detached from UTC.
 */
function isEntityName(word: string): boolean {
  return !/^\p{Lu}[\p{Lu}\d]+$/u.test(word) && !/\p{Ll}\p{Lu}/u.test(word);
}

const ATTRIBUTION_PARENTHETICAL =
  /\([^()]*\b[\w.-]+\.(?:md|csv|txt|log|json|diff|ya?ml|tsv|html?)\b[^()]*\)/gi;

/** How far apart a number and the name it belongs to may sit in a source. */
const NEAR_CHARS = 160;

/**
 * Years and numbers the evidence states, but never near any name the
 * sentence attaches them to. "Mildred Washington: Born 1737 [7]" passed a
 * presence check because [7] mentioned a Mildred and, elsewhere, 1737; the
 * wrong year for the right relative is the commonest family-tree error.
 *
 * Judged per source: a number is detached only when a source naming the
 * anchor also states the number, and never near it. A number that comes
 * from another source is a synthesis this check cannot judge; joined, the
 * sources made "Skylark launches on 2026-09-01 … Marcus as launch DRI" read
 * as a date detached from Marcus, because the org chart named Marcus and
 * the engineering memo the date (2026-10-07, conflict-synthesis).
 */
function detachedNumbers(
  claims: ReadonlyArray<{ kind: ClaimKind; value: string }>,
  sources: readonly string[],
  sentence = '',
): string[] {
  const occurrences = (kind: ClaimKind, value: string, text: string) => [
    ...text.matchAll(claimPattern(kind, value)),
  ];
  const count = (value: string) =>
    sources.reduce((sum, text) => sum + occurrences('name', value, text).length, 0);
  // The anchor is the rarest name in the sources: in an article about George
  // Washington, "Washington" sits near every year it states, while "Mildred"
  // sits only near hers. Each number takes it from the name nearest it in
  // the sentence, so "(Allen, 2022) and … (Dunn, 2023)" pairs 2023 with Dunn
  // rather than with the rarer Allen (2026-10-07, annotated-bibliography).
  // A name inside a parenthetical that cites a file is the attribution, not
  // the subject: "(timeline.md, Notes)" made a section heading the anchor.
  const subject = sentence.replace(ATTRIBUTION_PARENTHETICAL, ' ');
  const names = claims.filter(
    (c) =>
      c.kind === 'name' &&
      isEntityName(c.value) &&
      count(c.value) > 0 &&
      (!sentence || claimPattern('name', c.value).test(normalizeEvidence(subject))),
  );
  if (names.length === 0) return [];
  const rarest = (values: readonly string[]) =>
    values.reduce((best, v) => (count(v) < count(best) ? v : best));
  const runs = nameRuns(
    names.map((c) => c.value),
    subject,
  );
  const out: string[] = [];
  for (const claim of claims) {
    if (claim.kind !== 'year' && claim.kind !== 'number') continue;
    const run = nearestRun(runs, claim, subject);
    const anchor = rarest(run ?? names.map((c) => c.value));
    const near = new RegExp(claimPattern('name', anchor).source, 'u');
    const stated = sources
      .filter((text) => near.test(text))
      .map((text) => ({ text, at: occurrences(claim.kind, claim.value, text) }))
      .filter((source) => source.at.length > 0);
    if (stated.length === 0) continue;
    const placed = stated.some(({ text, at }) =>
      at.some((m) => {
        const i = m.index ?? 0;
        return near.test(text.slice(Math.max(0, i - NEAR_CHARS), i + NEAR_CHARS));
      }),
    );
    if (!placed) out.push(`${claim.value} next to ${anchor}`);
  }
  return out;
}

interface NameRun {
  words: string[];
  start: number;
  end: number;
}

/** Where each name sits in the sentence, adjacent names joined into one run ("Mildred Washington"). */
function nameRuns(values: readonly string[], sentence: string): NameRun[] {
  const text = normalizeEvidence(sentence);
  const spots = values
    .flatMap((value) =>
      [...text.matchAll(claimPattern('name', value))].map((m) => ({
        value,
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
      })),
    )
    .sort((a, b) => a.start - b.start);
  const runs: NameRun[] = [];
  for (const spot of spots) {
    const last = runs.at(-1);
    if (last && /^[\s'’.-]*$/.test(text.slice(last.end, spot.start))) {
      if (!last.words.includes(spot.value)) last.words.push(spot.value);
      last.end = spot.end;
    } else runs.push({ words: [spot.value], start: spot.start, end: spot.end });
  }
  return runs;
}

function nearestRun(
  runs: readonly NameRun[],
  claim: { kind: ClaimKind; value: string },
  sentence: string,
): string[] | undefined {
  if (runs.length === 0) return undefined;
  const at = claimPattern(claim.kind, claim.value).exec(normalizeEvidence(sentence))?.index;
  if (at === undefined) return undefined;
  const distance = (run: NameRun) =>
    at < run.start ? run.start - at : at > run.end ? at - run.end : 0;
  return runs.reduce((best, run) => (distance(run) < distance(best) ? run : best)).words;
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
  /** The same texts kept apart, for checks that must not read across sources. */
  sources: string[];
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
    sources: [...normalized.values(), ...(given ? [given] : [])],
    given,
    ...(options.opaque ? { opaque: options.opaque } : {}),
  };
}

function checkAgainst(
  claims: Array<{ kind: ClaimKind; value: string }>,
  text: string,
): ClaimCheck[] {
  return withShownArithmetic(
    claims.map((claim) => ({ ...claim, found: claimFound(claim.kind, claim.value, text) })),
  );
}

/**
 * A number the sentence derives from two of its own sourced numbers: "the
 * 30,000 EUR gap between 240,000 and 210,000" shows its working, so the gap
 * is not an invention even though no source states it (2026-10-07,
 * conflict-synthesis). Only a sum or difference of two numbers the same
 * sentence states and the evidence holds counts.
 */
function withShownArithmetic(checks: ClaimCheck[]): ClaimCheck[] {
  const sourced = checks.filter((c) => c.kind === 'number' && c.found).map((c) => Number(c.value));
  if (sourced.length < 2) return checks;
  const derived = (value: number) =>
    sourced.some((a, i) =>
      sourced.some((b, j) => j > i && a !== b && (a + b === value || Math.abs(a - b) === value)),
    );
  return checks.map((c) =>
    c.kind === 'number' && !c.found && derived(Number(c.value)) ? { ...c, found: true } : c,
  );
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
  const holds = (sources: string[]) => {
    const checks = checkAgainst(claims, sources.join('\n'));
    return checks.every((c) => c.found) &&
      detachedNumbers(claims, sources, sentence.text).length === 0
      ? checks
      : null;
  };
  const given = ctx.given ? [ctx.given] : [];
  if (sentence.cites.length > 0) {
    const checks = holds([...sentence.cites.map((n) => ctx.normalized.get(n) ?? ''), ...given]);
    if (checks) return { ...sentence, status: 'supported', checks, missing: [] };
  } else if (ctx.given) {
    const checks = holds(given);
    if (checks) return { ...sentence, status: 'supported', checks, missing: [] };
  }
  const checks = checkAgainst(claims, ctx.everything);
  const absent = checks.filter((c) => !c.found).map((c) => c.value);
  const missing = absent.length > 0 ? absent : detachedNumbers(claims, ctx.sources, sentence.text);
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
