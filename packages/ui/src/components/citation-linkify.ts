/**
 * `[n]` citations in a factual-mode reply become links to the evidence they
 * name. The daemon numbered that evidence and stored it on the message
 * (`ChatMessage.grounding.evidence`); a marker whose number is not there is
 * left as plain text, so the reader never gets a link to nothing.
 */

import type { GroundingEvidence } from '@bendyline/gezel';

const MARKER = /\[(\d{1,3}(?:\s*(?:[-–]|,)\s*\d{1,3})*)\](?![(:])/g;
const CITE_HREF = '#cite:';

function numbers(inner: string): number[] {
  const out: number[] = [];
  for (const part of inner.split(',')) {
    const range = /^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 50; n++) out.push(n);
    } else if (/^\s*\d{1,3}\s*$/.test(part)) out.push(Number(part));
  }
  return out;
}

/** Code spans and fences swapped for sentinels, so `arr[1]` is never a citation. */
function withoutCode(markdown: string): { text: string; restore: (text: string) => string } {
  const fences: string[] = [];
  const text = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (block) => {
    fences.push(block);
    return `\u0000CODE${fences.length - 1}\u0000`;
  });
  return {
    text,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder sentinel
    restore: (out) => out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? ''),
  };
}

/** Each citation marker in the text, with the numbers it names. */
function eachMarker(
  text: string,
  visit: (whole: string, cited: number[]) => string | undefined,
): string {
  return text.replace(MARKER, (whole, inner: string, offset: number, all: string) => {
    if (all[offset - 1] === '[' || all[offset - 1] === ']') return whole;
    return visit(whole, numbers(inner)) ?? whole;
  });
}

/** What a reader sees on hover: the source's title, or where it came from. */
export function evidenceTitle(item: GroundingEvidence): string {
  return item.title ?? item.ref ?? (item.tool ? `Result of ${item.tool}` : 'Indexed context');
}

/** One source as the reader counts it: a place, with every excerpt of it the reply cites. */
export interface ReplySource {
  /** The number the reader sees, from 1. */
  n: number;
  items: GroundingEvidence[];
}

export interface ReplySources {
  sources: ReplySource[];
  /** The ledger's session-wide number → the number the reader sees. */
  shownAs: ReadonlyMap<number, number>;
}

/**
 * Where a piece of evidence came from: one file, page or knowledge document.
 * A passage's anchor (`#chunk=…`, `#line=4`) is a place inside it.
 */
function placeOf(item: GroundingEvidence): string {
  const ref = item.ref?.trim();
  if (!ref) return `#${item.n}`;
  if (/^[a-z][\w+.-]*:\/\//i.test(ref)) return ref.replace(/#.*$/, '');
  return ref.replace(/^\.\//, '');
}

/**
 * A reply's sources as its reader counts them. The daemon numbers evidence
 * across the whole session and stores what the turn read beside what the
 * reply cites, so a first answer that used one file read "[13]" under "13
 * sources" (2026-11-09). A reply lists only what it cites, numbered from 1 in
 * the order it first cites them, and one place is one source however many
 * excerpts of it were numbered. A reply that cites nothing lists what its turn
 * read, so a statement to check still has something to check against.
 */
export function replySources(
  markdown: string,
  evidence: readonly GroundingEvidence[] | undefined,
): ReplySources {
  if (!evidence?.length) return { sources: [], shownAs: new Map() };
  const byNumber = new Map(evidence.map((item) => [item.n, item]));
  const order: number[] = [];
  const seen = new Set<number>();
  if (markdown.includes('[')) {
    eachMarker(withoutCode(markdown).text, (_whole, cited) => {
      for (const n of cited) {
        if (byNumber.has(n) && !seen.has(n)) {
          seen.add(n);
          order.push(n);
        }
      }
      return undefined;
    });
  }
  const listed =
    order.length > 0 ? order.map((n) => byNumber.get(n)!) : [...evidence].sort((a, b) => a.n - b.n);
  const sources: ReplySource[] = [];
  const byPlace = new Map<string, ReplySource>();
  const shownAs = new Map<number, number>();
  for (const item of listed) {
    const place = placeOf(item);
    let source = byPlace.get(place);
    if (!source) {
      source = { n: sources.length + 1, items: [] };
      sources.push(source);
      byPlace.set(place, source);
    }
    source.items.push(item);
    shownAs.set(item.n, source.n);
  }
  return { sources, shownAs };
}

/**
 * Turn `[n]` markers into links. With `shownAs` (from {@link replySources})
 * each link reads the number the reader sees and still opens the ledger's
 * evidence; two markers for one place become one link.
 */
export function linkifyCitations(
  markdown: string,
  evidence: readonly GroundingEvidence[] | undefined,
  shownAs?: ReadonlyMap<number, number>,
): string {
  if (!markdown || !evidence?.length || !markdown.includes('[')) return markdown;
  const byNumber = new Map(evidence.map((item) => [item.n, item]));
  const { text, restore } = withoutCode(markdown);
  const rewritten = eachMarker(text, (_whole, numbers) => {
    const cited = numbers.filter((n) => byNumber.has(n));
    if (cited.length === 0) return undefined;
    const shown = new Set<number>();
    return cited
      .flatMap((n) => {
        const label = shownAs?.get(n) ?? n;
        if (shown.has(label)) return [];
        shown.add(label);
        const title = evidenceTitle(byNumber.get(n)!).replace(/["\\]/g, '');
        // Escaped: squisq parses `[[3]]` as a wiki link, which would eat the
        // link it opens and leave `(#cite:3 …)` as text.
        return [`[\\[${label}\\]](${CITE_HREF}${n} "${title}")`];
      })
      .join('');
  });
  return restore(rewritten);
}

/** The evidence number a clicked href names, or null. */
export function citationFromHref(href: string): number | null {
  if (!href.startsWith(CITE_HREF)) return null;
  const n = Number(href.slice(CITE_HREF.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}
