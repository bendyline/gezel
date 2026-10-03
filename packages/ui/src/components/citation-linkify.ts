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

/** What a reader sees on hover: the source's title, or where it came from. */
export function evidenceTitle(item: GroundingEvidence): string {
  return item.title ?? item.ref ?? (item.tool ? `Result of ${item.tool}` : 'Indexed context');
}

export function linkifyCitations(
  markdown: string,
  evidence: readonly GroundingEvidence[] | undefined,
): string {
  if (!markdown || !evidence?.length || !markdown.includes('[')) return markdown;
  const byNumber = new Map(evidence.map((item) => [item.n, item]));
  const fences: string[] = [];
  const withoutCode = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (block) => {
    fences.push(block);
    return `\u0000CODE${fences.length - 1}\u0000`;
  });
  const rewritten = withoutCode.replace(
    MARKER,
    (whole, inner: string, offset: number, all: string) => {
      if (all[offset - 1] === '[' || all[offset - 1] === ']') return whole;
      const cited = numbers(inner).filter((n) => byNumber.has(n));
      if (cited.length === 0) return whole;
      return cited
        .map((n) => {
          const title = evidenceTitle(byNumber.get(n)!).replace(/["\\]/g, '');
          return `[[${n}]](${CITE_HREF}${n} "${title}")`;
        })
        .join('');
    },
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder sentinel
  return rewritten.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? '');
}

/** The evidence number a clicked href names, or null. */
export function citationFromHref(href: string): number | null {
  if (!href.startsWith(CITE_HREF)) return null;
  const n = Number(href.slice(CITE_HREF.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}
