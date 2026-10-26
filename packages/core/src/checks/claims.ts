import {
  type EvidenceItem,
  type SentenceGrounding,
  describeGroundingProblems,
  groundText,
  isBlockingGroundingProblem,
  isDerivedNumber,
} from '../grounding/citations.js';
import type { CheckResult, WorkspaceLike } from './types.js';
import { cleanCitedPath } from './workspace-exists.js';

/**
 * `claimsGrounded`: the facts in a document appear in the sources it cites.
 *
 * `citationsResolve` proves a cited file exists; it says nothing about
 * whether the cited file says what the sentence claims. A research deck could
 * cite the brief and still invent its numbers, which is exactly the "cited and
 * verified" bar a research book promises. This check reads each cited source
 * and requires every number, date, month and quotation in a citing sentence to
 * appear in it, using the same engine (`groundText`) and the same counting rule
 * (`isBlockingGroundingProblem`) that refuse an unsupported document write in a
 * factual chat. It catches invention, not a wrong source copied faithfully.
 *
 * Citations it reads: `[n]` markers resolved through a Sources / References
 * list, and inline `(source: path)` notes. Cited URLs, `knowledge://`
 * references and PDF or Office files cannot be read here as text, so a
 * sentence citing only those counts as cited but unverified, never as
 * invented. `sources` adds material the facts
 * may come from without being cited (a contract's supplied brief), so a true
 * but uncited detail reads as a citation slip rather than an invention.
 */

export interface ClaimsGroundedOptions {
  /** Files or folders the facts may come from, cited or not. */
  sources?: readonly string[];
  /** Citing sentences whose details no evidence shows. Default 0. */
  maxUnsupported?: number;
  /** Citations that resolve to nothing. Default 0. */
  maxBadCitations?: number;
  /** Uncited sentences whose details no evidence shows. Default 0. */
  maxUncited?: number;
  /**
   * What the task was handed: its request, its parameters, today's date. A
   * detail found here needs no citation, as in chat, where the person's own
   * words are never an invention.
   */
  given?: string;
}

export interface ClaimsGroundedResult extends CheckResult {
  counts: {
    supported: number;
    unattributed: number;
    unverified: number;
    unsupported: number;
    uncited: number;
    badCitations: number;
  };
  sources: { read: string[]; missing: string[]; unverifiable: string[] };
  problems: string[];
}

const REFERENCES_HEADING =
  /^(#{1,6})\s*(?:sources|references|citations|bibliography|works cited|sources cited)\b/i;
const REFERENCE_LINE = /^\s*(?:[-*+]\s*)?(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s*:?\s*(.+)$/;
const INLINE_SOURCE = /\((?:source|sources|src)\s*:\s*([^)]+)\)/gi;
const HAS_INLINE_SOURCE = /\((?:source|sources|src)\s*:/i;
/** `[source/brief.md]`: a path in brackets, not a link's text (no `(` after it). */
const BRACKETED_PATH = /\[((?:[\w.-]+\/)*[\w.-]+\.[a-z][a-z0-9]{0,5})\](?!\()/gi;
const URL_LIKE = /^(?:[a-z][\w+.-]*:\/\/|mailto:)/i;
const MAX_FOLDER_FILES = 50;
const TEXT_FILE = /\.(?:md|markdown|txt|csv|tsv|json|ya?ml|html?|xml|log|rst)$/i;
/** A container this check cannot read as text; like a URL, it is cited but unchecked. */
const BINARY_DOCUMENT = /\.(?:pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|epub)$/i;

/** The single reference a Sources line names: a link target, a backticked path, a URL, or a path-like token. */
function refFromLine(text: string): string | null {
  const link = /\]\(([^)\s]+)\)/.exec(text)?.[1];
  if (link) return link;
  const ticked = /`([^`\n]+)`/.exec(text)?.[1];
  if (ticked) return ticked;
  const url = /\b(?:https?:\/\/|knowledge:\/\/)[^\s)>\]]+/i.exec(text)?.[0];
  if (url) return url;
  const path = /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[a-z][a-z0-9]{0,5})\b/i.exec(text)?.[1];
  return path ?? null;
}

/** Split the document into its body and the `n -> reference` map of its Sources section. */
function splitReferences(markdown: string): { body: string; refs: Map<number, string> } {
  const lines = markdown.split('\n');
  const refs = new Map<number, string>();
  const body: string[] = [];
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (level > 0 && heading && heading[1]!.length <= level) level = 0;
    const references = REFERENCES_HEADING.exec(line);
    if (references) {
      level = references[1]!.length;
      continue;
    }
    if (level > 0) {
      // Several references can share a line: "[1] tasks/1/menu.md [2] tasks/1/scope.md".
      const inline = [...line.matchAll(/\[(\d{1,3})\]\s*:?\s*/g)];
      if (inline.length > 1) {
        inline.forEach((m, i) => {
          const end = inline[i + 1]?.index ?? line.length;
          const ref = refFromLine(line.slice(m.index! + m[0].length, end));
          const n = Number(m[1]);
          if (ref && !refs.has(n)) refs.set(n, ref);
        });
        continue;
      }
      const m = REFERENCE_LINE.exec(line);
      if (m) {
        const n = Number(m[1] ?? m[2]);
        const ref = refFromLine(m[3]!);
        if (ref && !refs.has(n)) refs.set(n, ref);
      }
      continue;
    }
    body.push(line);
  }
  return { body: body.join('\n'), refs };
}

/**
 * Turn inline `(source: a, b)` notes, and bracketed paths like
 * `[source/brief.md]`, into `[n]` markers that share numbers with the Sources
 * list.
 */
function numberInlineSources(body: string, refs: Map<number, string>): string {
  const byRef = new Map([...refs].map(([n, ref]) => [ref.toLowerCase(), n]));
  let next = Math.max(0, ...refs.keys()) + 1;
  const bracketed = body.replace(BRACKETED_PATH, (_whole, path: string) => `(source: ${path})`);
  return bracketed.replace(INLINE_SOURCE, (_whole, list: string) => {
    const numbers: number[] = [];
    for (const raw of list.split(/[,;]/)) {
      const ref = refFromLine(raw) ?? raw.trim().replace(/^`+|`+$/g, '');
      if (!ref) continue;
      const key = ref.toLowerCase();
      let n = byRef.get(key);
      if (n === undefined) {
        n = next++;
        refs.set(n, ref);
        byRef.set(key, n);
      }
      numbers.push(n);
    }
    return numbers.length > 0 ? `[${numbers.join(', ')}]` : '';
  });
}

/**
 * Sources a document declares for itself on a "Source: `brief.md`" line rather
 * than citing sentence by sentence. Their facts count as found, not cited: a
 * true detail reads as a citation slip, and one found nowhere is still an
 * invention.
 */
function declaredSources(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const declared = /\b(?:sources?|data sourced from|based on)\s*:?\**\s*(.+)$/i.exec(line);
    if (!declared || HAS_INLINE_SOURCE.test(line)) continue;
    for (const m of declared[1]!.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)/g)) {
      const ref = (m[1] ?? m[2] ?? '').trim();
      if (ref && !URL_LIKE.test(ref)) out.push(ref);
    }
  }
  return [...new Set(out)];
}

/** How far a deck's arithmetic may reach for the figures it works from. */
const DERIVATION_WINDOW = 3;

/**
 * A sentence whose only unsupported details are numbers worked out from
 * sourced figures nearby: "a 5.3-point drop" on the slide after "14.2% → 8.9%".
 * Write-time grounding accepts this only within one sentence; a finished
 * document states its figures and their arithmetic across neighboring lines.
 */
function derivedFromNeighbors(sentences: readonly SentenceGrounding[], i: number): boolean {
  const sentence = sentences[i]!;
  if (sentence.status === 'bad-citation') return false;
  const unfound = sentence.checks.filter((c) => !c.found && c.kind !== 'name');
  if (unfound.length === 0 || unfound.some((c) => c.kind !== 'number')) return false;
  const sourced = sentences
    .slice(Math.max(0, i - DERIVATION_WINDOW), i + DERIVATION_WINDOW + 1)
    .flatMap((s) => s.checks.filter((c) => c.kind === 'number' && c.found))
    .map((c) => Number(c.value))
    .filter(Number.isFinite);
  return unfound.every((c) => isDerivedNumber(c.value, sourced));
}

/** A source's text: the file itself, or the readable files under a folder. */
async function readSource(ws: WorkspaceLike, ref: string): Promise<string | null> {
  const path = cleanCitedPath(ref);
  if (!path) return null;
  const text = await ws.read(path).catch(() => null);
  if (text !== null) return text;
  const prefix = `${path.replace(/\/+$/, '')}/`;
  const files = (await ws.list().catch(() => [] as string[]))
    .filter((f) => cleanCitedPath(f).startsWith(prefix) && TEXT_FILE.test(f))
    .slice(0, MAX_FOLDER_FILES);
  if (files.length === 0) return null;
  const parts = await Promise.all(files.map((f) => ws.read(f).catch(() => null)));
  const joined = parts.filter((p): p is string => p !== null).join('\n\n');
  return joined.length > 0 ? joined : null;
}

export async function claimsGrounded(
  ws: WorkspaceLike,
  file: string,
  opts: ClaimsGroundedOptions = {},
): Promise<ClaimsGroundedResult> {
  const empty = {
    counts: {
      supported: 0,
      unattributed: 0,
      unverified: 0,
      unsupported: 0,
      uncited: 0,
      badCitations: 0,
    },
    sources: { read: [], missing: [], unverifiable: [] },
    problems: [],
  };
  const content = await ws.read(file);
  if (content === null) {
    return { ...empty, ok: false, detail: `${file} not found — write the deliverable first.` };
  }

  const { body, refs } = splitReferences(content);
  const text = numberInlineSources(body, refs);

  const evidence: EvidenceItem[] = [];
  const opaque = new Set<number>();
  const read: string[] = [];
  const missing: string[] = [];
  const unverifiable: string[] = [];
  for (const [n, ref] of refs) {
    if (URL_LIKE.test(ref) || BINARY_DOCUMENT.test(ref)) {
      opaque.add(n);
      unverifiable.push(ref);
      continue;
    }
    const source = await readSource(ws, ref);
    if (source === null) {
      missing.push(ref);
      continue;
    }
    evidence.push({ n, text: source, ref });
    read.push(ref);
  }
  let extra = Math.max(0, ...refs.keys()) + 1;
  for (const ref of [...(opts.sources ?? []), ...declaredSources(body)]) {
    if (refs.size > 0 && [...refs.values()].some((r) => r.toLowerCase() === ref.toLowerCase())) {
      continue;
    }
    const source = await readSource(ws, ref);
    if (source === null) continue;
    evidence.push({ n: extra++, text: source, ref });
    read.push(ref);
  }

  const grounding = groundText(text, evidence, {
    opaque: (n) => opaque.has(n),
    ...(opts.given ? { given: opts.given } : {}),
  });
  const blocking = grounding.sentences.filter(
    (s, i) =>
      (s.status === 'unsupported' || s.status === 'uncited' || s.status === 'bad-citation') &&
      isBlockingGroundingProblem(s) &&
      !derivedFromNeighbors(grounding.sentences, i),
  );
  const count = (status: SentenceGrounding['status']) =>
    blocking.filter((s) => s.status === status).length;
  const counts = {
    supported: grounding.counts.supported,
    unattributed: grounding.counts.unattributed,
    unverified: grounding.counts.cited,
    unsupported: count('unsupported'),
    uncited: count('uncited'),
    badCitations: count('bad-citation'),
  };
  const ok =
    counts.unsupported <= (opts.maxUnsupported ?? 0) &&
    counts.badCitations <= (opts.maxBadCitations ?? 0) &&
    counts.uncited <= (opts.maxUncited ?? 0);
  const problems = describeGroundingProblems(blocking).split('\n').filter(Boolean);
  const sources = { read, missing, unverifiable };
  if (ok) {
    const unchecked =
      unverifiable.length > 0 ? ` (+${unverifiable.length} URL source(s) not checked offline)` : '';
    return {
      ok,
      detail: `${file}: ${counts.supported} sentence(s) with checkable facts are supported by their sources${unchecked}.`,
      counts,
      sources,
      problems,
    };
  }
  const missingNote =
    missing.length > 0
      ? ` Cited sources that do not exist: ${missing
          .slice(0, 5)
          .map((m) => `\`${m}\``)
          .join(', ')}.`
      : '';
  return {
    ok,
    detail: `${file} states facts its sources do not show — look each one up in the cited source, correct it, or remove it:\n${problems.join('\n')}${missingNote}`,
    counts,
    sources,
    problems,
  };
}
