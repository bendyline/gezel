import type { CheckResult, WorkspaceLike } from './types.js';

/**
 * Prose checks — for comms, marketing copy, and long documents.
 *
 *   - `wordBand` enforces a word-count floor AND ceiling (verbosity is a
 *     failure mode too — the constrained-comms lesson).
 *   - `readingLevel` bands Flesch-Kincaid grade / Flesch reading-ease.
 *   - `namedEntitiesConsistent` catches spelling/number drift across a
 *     long doc (the thing named in §1 must match §5).
 *
 * Heuristic by nature (English syllable estimation, Markdown stripping);
 * intended as advisory-first gates, consistent with the judge-gate rules.
 */

/** Strip Markdown markup that shouldn't count toward prose length. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, ' ')
    .replace(/[*_~]/g, ' ');
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

export interface WordBandResult extends CheckResult {
  words: number;
}

/** Word count within `[min, max]` (either bound optional). */
export function wordBand(
  text: string,
  opts: { min?: number; max?: number; stripMarkdown?: boolean } = {},
): WordBandResult {
  const cleaned = opts.stripMarkdown === false ? text : stripMarkdown(text);
  const words = countWords(cleaned);
  if (opts.min !== undefined && words < opts.min) {
    return { ok: false, detail: `${words} words, need ≥ ${opts.min}`, words };
  }
  if (opts.max !== undefined && words > opts.max) {
    return {
      ok: false,
      detail: `${words} words, need ≤ ${opts.max} — trim it (verbosity is a failure mode too)`,
      words,
    };
  }
  const band =
    opts.min !== undefined && opts.max !== undefined ? ` (band ${opts.min}–${opts.max})` : '';
  return { ok: true, detail: `${words} words${band}`, words };
}

/** Heuristic English syllable count (vowel-group method). */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface ReadingLevelResult extends CheckResult {
  /** Flesch-Kincaid grade level. */
  grade: number;
  /** Flesch reading-ease (higher = easier). */
  ease: number;
  words: number;
  sentences: number;
}

/**
 * Flesch-Kincaid grade level and Flesch reading-ease, banded by any of
 * `minGrade`/`maxGrade`/`minEase`/`maxEase`. Reports the first band the
 * text falls outside of.
 */
export function readingLevel(
  text: string,
  opts: {
    minGrade?: number;
    maxGrade?: number;
    minEase?: number;
    maxEase?: number;
    stripMarkdown?: boolean;
  } = {},
): ReadingLevelResult {
  const cleaned = opts.stripMarkdown === false ? text : stripMarkdown(text);
  const sentences = Math.max(1, (cleaned.match(/[.!?]+(?=\s|$)/g) ?? []).length);
  const wordTokens = cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const words = wordTokens.length;
  if (words === 0) {
    return { ok: false, detail: 'no words to score', grade: 0, ease: 0, words: 0, sentences };
  }
  const syllables = wordTokens.reduce((s, w) => s + countSyllables(w), 0);
  const wps = words / sentences;
  const spw = syllables / words;
  const grade = round1(0.39 * wps + 11.8 * spw - 15.59);
  const ease = round1(206.835 - 1.015 * wps - 84.6 * spw);

  let fail: string | null = null;
  if (opts.maxGrade !== undefined && grade > opts.maxGrade) {
    fail = `grade ${grade} > max ${opts.maxGrade} — simplify sentences and word choice`;
  } else if (opts.minGrade !== undefined && grade < opts.minGrade) {
    fail = `grade ${grade} < min ${opts.minGrade}`;
  } else if (opts.minEase !== undefined && ease < opts.minEase) {
    fail = `reading-ease ${ease} < min ${opts.minEase} — too dense, shorten sentences`;
  } else if (opts.maxEase !== undefined && ease > opts.maxEase) {
    fail = `reading-ease ${ease} > max ${opts.maxEase}`;
  }

  return {
    ok: fail === null,
    detail: fail ?? `grade ${grade}, reading-ease ${ease}`,
    grade,
    ease,
    words,
    sentences,
  };
}

/** A canonical term plus the spellings/numberings that should NOT appear. */
export interface EntitySpec {
  canonical: string;
  /** Forbidden variants (drifted spellings, wrong numbers). */
  variants: string[];
}

export interface EntitiesResult extends CheckResult {
  violations: Array<{ canonical: string; variant: string }>;
}

export interface UnsupportedClaimPattern {
  /** Regex for a high-risk claim phrase whose wording must be source-grounded. */
  pattern: string;
  /** Repair guidance shown when this pattern matches unsupported prose. */
  label?: string;
}

export interface UnsupportedClaimViolation {
  pattern: string;
  label?: string;
  match: string;
}

export interface UnsupportedClaimsResult extends CheckResult {
  violations: UnsupportedClaimViolation[];
  missingSources: string[];
}

function literalWordRegExp(s: string): RegExp | null {
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(?<!\\w)${esc}(?!\\w)`);
  } catch {
    return null;
  }
}

/**
 * Fail if any declared `variant` of an entity appears in `text` — i.e.
 * the document drifted from the canonical spelling/number somewhere.
 * Case-sensitive (so "ACME" vs "Acme" is caught). Reports the first
 * inconsistency.
 */
export function namedEntitiesConsistent(
  text: string,
  entities: readonly EntitySpec[],
): EntitiesResult {
  const violations: Array<{ canonical: string; variant: string }> = [];
  for (const e of entities) {
    for (const variant of e.variants) {
      if (variant === e.canonical) continue;
      const re = literalWordRegExp(variant);
      if (re?.test(text)) violations.push({ canonical: e.canonical, variant });
    }
  }
  if (violations.length > 0) {
    const v = violations[0] as { canonical: string; variant: string };
    return {
      ok: false,
      detail: `inconsistent reference: "${v.variant}" appears — use the canonical form "${v.canonical}" consistently throughout.`,
      violations,
    };
  }
  return {
    ok: true,
    detail: `all ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} referenced consistently`,
    violations,
  };
}

function normalizedProse(text: string): string {
  return stripMarkdown(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function regexFlags(flags: string | undefined): string {
  const base = flags === undefined ? 'i' : flags;
  const seen = new Set<string>();
  let out = '';
  for (const flag of `${base}g`) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    out += flag;
  }
  return out;
}

function shortList(paths: readonly string[]): string {
  if (paths.length <= 3) return paths.join(', ');
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
}

/**
 * Fail when high-risk claim wording appears in `file` but the exact
 * matched phrase is absent from the declared source files. This is a
 * deterministic middle ground for factual comms gates: it catches common
 * overclaim/tone drift while still allowing loaded phrases that the source
 * brief explicitly authorized.
 */
export async function unsupportedClaims(
  ws: WorkspaceLike,
  file: string,
  sourceFiles: readonly string[],
  patterns: readonly UnsupportedClaimPattern[],
  opts: { flags?: string; maxViolations?: number } = {},
): Promise<UnsupportedClaimsResult> {
  const content = await ws.read(file);
  if (content === null) {
    return {
      ok: false,
      detail: `${file} not found`,
      violations: [],
      missingSources: [],
    };
  }
  if (sourceFiles.length === 0) {
    return {
      ok: false,
      detail: `${file} has no source files to ground claim wording against`,
      violations: [],
      missingSources: [],
    };
  }

  const missingSources: string[] = [];
  const sourceParts: string[] = [];
  for (const sourceFile of sourceFiles) {
    const source = await ws.read(sourceFile);
    if (source === null) {
      missingSources.push(sourceFile);
    } else {
      sourceParts.push(source);
    }
  }
  if (missingSources.length > 0) {
    return {
      ok: false,
      detail: `${shortList(missingSources)} not found (needed to ground claim wording in ${file})`,
      violations: [],
      missingSources,
    };
  }

  const sourceText = normalizedProse(sourceParts.join('\n'));
  const violations: UnsupportedClaimViolation[] = [];
  const maxViolations = opts.maxViolations ?? 5;
  for (const candidate of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(candidate.pattern, regexFlags(opts.flags));
    } catch {
      return {
        ok: false,
        detail: `invalid unsupported-claims pattern /${candidate.pattern}/`,
        violations: [],
        missingSources: [],
      };
    }

    for (const match of content.matchAll(re)) {
      const rawMatch = match[0]?.replace(/\s+/g, ' ').trim();
      if (!rawMatch) continue;
      const grounded = sourceText.includes(normalizedProse(rawMatch));
      if (!grounded) {
        violations.push({
          pattern: candidate.pattern,
          ...(candidate.label ? { label: candidate.label } : {}),
          match: rawMatch.slice(0, 120),
        });
        if (violations.length >= maxViolations) break;
      }
    }
    if (violations.length >= maxViolations) break;
  }

  if (violations.length > 0) {
    const first = violations[0] as UnsupportedClaimViolation;
    const guidance = first.label ? `: ${first.label}` : '';
    return {
      ok: false,
      detail: `${file} has unsupported claim wording${guidance} (matched "${first.match}") — rewrite it using only source facts from ${shortList(sourceFiles)} or remove it.`,
      violations,
      missingSources: [],
    };
  }

  return {
    ok: true,
    detail: `${file} claim wording is grounded in ${shortList(sourceFiles)}`,
    violations: [],
    missingSources: [],
  };
}
