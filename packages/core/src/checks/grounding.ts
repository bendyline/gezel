import type { CheckResult, WorkspaceLike } from './types.js';
import { createCitedPathChecker } from './workspace-exists.js';

/**
 * Grounding + citation checks — the anti-fabrication vocabulary.
 *
 * Ported from the eval graders (evals/src/scenarios/decoy-research.ts) so
 * the gate that fires in production is byte-identical to the one the eval
 * suite proved out:
 *
 *   - `valueGrounding` generalizes decoy-research's `checkBriefing`:
 *     required facts must be present, forbidden (decoy) values must be
 *     absent anywhere — even to contrast them.
 *   - `citationsResolve` is the squisq lesson as a mechanical gate: every
 *     source a deliverable cites must resolve to a real file (no
 *     fabricated paths). URLs can't be fetched offline, so they fail
 *     open unless an explicit corpus allowlist is supplied.
 */

/**
 * Collapse digit-grouping separators so "$4,217,300", "4 217 300", and
 * "4217300" all compare equal. Only separators between a digit and a
 * 3-digit group are touched, so list punctuation ("1, 2, 3") and prose
 * spacing survive. (Ported verbatim from decoy-research.)
 */
export function normalizeDigitGroups(text: string): string {
  return text.replace(/(\d)[,\s](?=\d{3}(?:\D|$))/g, '$1');
}

/** A single grounded fact: at least one `required` form must appear and no
 *  `forbidden` (decoy) form may. Values are regex sources, matched
 *  case-insensitively against the (optionally digit-normalized) text. */
export interface GroundingFact {
  /** Stable id, surfaced in the failure message. */
  id: string;
  /** Short human label ("Q3 revenue"); falls back to `id`. */
  label?: string;
  /** Value(s) that MUST appear — the fact passes when ANY one matches. */
  required: string[];
  /** Value(s) that must NOT appear anywhere (the decoy twins). */
  forbidden?: string[];
}

export interface GroundingResult extends CheckResult {
  /** Ids of facts that passed. */
  signals: string[];
  /** Forbidden (decoy) values that were detected, for logs/facts.json. */
  decoysDetected: string[];
}

function safeRegExp(src: string, flags: string): RegExp | null {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

/**
 * Behavioral fact-check over a deliverable's text: for each fact an
 * authorized value must be present and every forbidden twin absent.
 * Pure (string in, verdict out) so it drives gate scripts and the eval
 * grader from one codebase. Reports the FIRST failing fact concretely
 * (Law 3: name the gap, not the rule).
 */
export function valueGrounding(
  text: string,
  facts: readonly GroundingFact[],
  opts: { normalizeDigits?: boolean } = {},
): GroundingResult {
  const haystack = opts.normalizeDigits === false ? text : normalizeDigitGroups(text);
  const signals: string[] = [];
  const decoysDetected: string[] = [];
  let firstFailure: string | null = null;

  if (facts.length === 0) {
    return { ok: false, detail: 'no grounding facts configured', signals, decoysDetected };
  }

  for (const fact of facts) {
    const label = fact.label ?? fact.id;
    const hasRequired = fact.required.some((src) => safeRegExp(src, 'i')?.test(haystack) ?? false);
    const hitForbidden = (fact.forbidden ?? []).filter(
      (src) => safeRegExp(src, 'i')?.test(haystack) ?? false,
    );
    decoysDetected.push(...hitForbidden);

    if (hasRequired && hitForbidden.length === 0) {
      signals.push(fact.id);
      continue;
    }
    if (firstFailure === null) {
      firstFailure =
        hitForbidden.length > 0
          ? `${label}: forbidden value /${hitForbidden[0]}/ appears — that figure comes from an unauthorized source and must not appear at all (not even to contrast it).`
          : `${label}: no authorized value found — quote the exact value from an authorized source (expected one of: ${fact.required.map((r) => `/${r}/`).join(', ')}).`;
    }
  }

  return {
    ok: firstFailure === null,
    detail: firstFailure ?? `all ${facts.length} facts grounded (no forbidden values present)`,
    signals,
    decoysDetected,
  };
}

/**
 * Default citation extractor — conservative on purpose, so a bare filename
 * mentioned in prose isn't mistaken for a citation. Captures three
 * explicit forms (first non-empty group wins):
 *   1. `(source: path/to/file.md)` — tolerates trailing bracketed labels
 *      like `(Source: path/to/file.md [Citation 1])`, which previously
 *      zeroed the citation count; free prose after the path still
 *      disqualifies the match so `(source: see the notes)` isn't counted
 *   2. a Markdown link target `](path)` (skips pure `#anchor` links)
 *   3. a backticked path containing a slash `` `dir/file.ext` ``
 */
const DEFAULT_CITATION_RE =
  /\(source:\s*([^)\s]+)(?:\s+\[[^\]]*\])*\s*\)|\]\(\s*(?!#)([^)\s]+?)\s*\)|`([^`]*\/[^`]+)`/gi;

function extractCitations(text: string, re: RegExp): string[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  const out: string[] = [];
  for (const m of text.matchAll(global)) {
    const cap = m.slice(1).find((x) => x !== undefined) ?? m[0];
    if (cap) out.push(cap);
  }
  return out;
}

function cleanCitation(raw: string): string {
  return raw
    .trim()
    .replace(/^[<'"`(]+/, '')
    .replace(/[>'"`).,;:]+$/, '');
}

export interface CitationsResult extends CheckResult {
  /** Cited paths that resolved to a real workspace file. */
  resolved: string[];
  /** Cited paths/URLs that did NOT resolve. */
  unresolved: string[];
  /** Cited URLs (not checked offline unless a corpus allowlist is given). */
  urls: string[];
}

/**
 * Every source `file` cites must exist. File-path citations are resolved
 * against the workspace listing (tolerant of leading `./`, `/`, and
 * `workspace/`, case-insensitive), with a per-path read probe for listing
 * misses — the listing is capped and dotfile-blind, see
 * `createCitedPathChecker`. URLs cannot be fetched offline, so
 * they pass unless `corpus` is supplied, in which case every cited path
 * AND URL must be a member of the allowlist. The anti-fabrication gate.
 */
export async function citationsResolve(
  ws: WorkspaceLike,
  file: string,
  opts: { pattern?: string; flags?: string; minCitations?: number; corpus?: string[] } = {},
): Promise<CitationsResult> {
  const content = await ws.read(file);
  if (content === null) {
    return {
      ok: false,
      detail: `${file} not found — write the deliverable before advancing.`,
      resolved: [],
      unresolved: [],
      urls: [],
    };
  }

  const re = opts.pattern
    ? safeRegExp(opts.pattern, opts.flags ?? 'gi')
    : new RegExp(DEFAULT_CITATION_RE.source, 'gi');
  if (!re) {
    return {
      ok: false,
      detail: `invalid citation pattern /${opts.pattern}/`,
      resolved: [],
      unresolved: [],
      urls: [],
    };
  }

  const cites = [...new Set(extractCitations(content, re).map(cleanCitation).filter(Boolean))];
  const min = opts.minCitations ?? 1;
  const citedPathExists = createCitedPathChecker(ws);
  const corpus = opts.corpus ? new Set(opts.corpus.map((c) => c.toLowerCase())) : null;

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const urls: string[] = [];

  for (const c of cites) {
    if (/^[a-z][\w+.-]*:\/\//i.test(c) || c.startsWith('mailto:')) {
      urls.push(c);
      if (corpus && !corpus.has(c.toLowerCase())) unresolved.push(c);
      continue;
    }
    if (corpus?.has(c.toLowerCase()) || (await citedPathExists(c))) resolved.push(c);
    else unresolved.push(c);
  }

  if (cites.length < min) {
    return {
      ok: false,
      detail: `${file} has ${cites.length} citation(s), need ≥ ${min} — cite the source path/URL for each claim.`,
      resolved,
      unresolved,
      urls,
    };
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      detail: `${file} cites ${unresolved.length} source(s) that do not exist: ${unresolved.slice(0, 5).join(', ')} — every cited path must resolve to a real file in the workspace${corpus ? '/corpus' : ''} (no fabricated citations).`,
      resolved,
      unresolved,
      urls,
    };
  }
  return {
    ok: true,
    detail: `${file} cites ${resolved.length} resolvable source(s)${urls.length ? ` (+${urls.length} URL(s) not checked offline)` : ''}`,
    resolved,
    unresolved,
    urls,
  };
}

/** Spec for {@link valuesSubsetOf}. */
export interface ValuesSubsetSpec {
  /**
   * Regex source with ONE capture group; every match's group 1 in the
   * output and in each source is a "value". Matched with `g` plus any
   * extra `flags`.
   */
  pattern: string;
  flags?: string;
  /**
   * Presence floor: the output must contain at least this many values
   * (default 0 — a subset check alone passes an output with no values;
   * pair with a shape check, or set a floor here, when values are
   * mandatory).
   */
  minMatches?: number;
}

export interface ValuesSubsetResult extends CheckResult {
  /** Distinct values found in the output. */
  checked: number;
  /** Output values that appear in NO source (dedup, output order). */
  invented: string[];
}

/**
 * Value-conservation check for transform/ETL deliverables: every value the
 * output carries (per `pattern`) must appear verbatim in at least one
 * source text. Catches the classic integrity failure where a model
 * regenerates identifiers instead of preserving them — renumbered record
 * ids, invented ticket refs, made-up SKUs — which survives every
 * shape/schema check because the output LOOKS right. Wild-caught
 * core sweep: 7 of 8 local models failed precision ETL solely
 * by renumbering source ids. Pure (strings in, verdict out) so it drives
 * gate checks, gate scripts, and eval graders from one codebase.
 */
export function valuesSubsetOf(
  outputText: string,
  sourceTexts: readonly string[],
  spec: ValuesSubsetSpec,
): ValuesSubsetResult {
  const flags = (spec.flags ?? '').includes('g') ? (spec.flags ?? '') : `${spec.flags ?? ''}g`;
  const re = safeRegExp(spec.pattern, flags);
  if (!re) {
    return { ok: false, detail: `invalid pattern /${spec.pattern}/`, checked: 0, invented: [] };
  }
  const extract = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(new RegExp(re.source, flags))) {
      const v = (m[1] ?? m[0]).trim();
      if (v) out.push(v);
    }
    return out;
  };
  // Membership is VALUE-level, not pattern-level. The pattern's job is to
  // find the claims in the OUTPUT; the sources only need to CONTAIN each
  // value verbatim. Running the output-shaped pattern over the sources
  // (the old behavior) silently produced an empty allowed-set whenever
  // the source encodes values differently — `"id": "c01-intro"` vs the
  // output's `"clip": "c01-intro"`, `[00:02:10]` vs `"00:02:10"`, a name
  // roster with no `Dear` — and then flagged every genuinely-grounded
  // value as invented (wild-caught across 4 craftbook evals, 2026-07-24).
  const caseInsensitive = flags.includes('i');
  const sourceHaystacks = sourceTexts.map((t) => (caseInsensitive ? t.toLowerCase() : t));
  const appearsInSources = (value: string): boolean => {
    const needle = caseInsensitive ? value.toLowerCase() : value;
    return sourceHaystacks.some((t) => t.includes(needle));
  };
  const seen = new Set<string>();
  const invented: string[] = [];
  let checked = 0;
  for (const v of extract(outputText)) {
    if (seen.has(v)) continue;
    seen.add(v);
    checked += 1;
    if (!appearsInSources(v)) invented.push(v);
  }
  const min = spec.minMatches ?? 0;
  if (checked < min) {
    return {
      ok: false,
      detail: `output carries ${checked} value(s) matching /${spec.pattern}/, need ≥ ${min} — the transform must preserve the source values, not drop them.`,
      checked,
      invented,
    };
  }
  if (invented.length > 0) {
    return {
      ok: false,
      detail: `${invented.length} value(s) in the output appear in no source: ${invented.slice(0, 3).join(', ')}${invented.length > 3 ? ', …' : ''} — copy identifiers verbatim from the source data; never renumber or invent them.`,
      checked,
      invented,
    };
  }
  return {
    ok: true,
    detail: `all ${checked} output value(s) trace back to the sources`,
    checked,
    invented,
  };
}
