import type { CheckResult, WorkspaceLike } from './types.js';

export interface MarkdownHeadingsMatchResult extends CheckResult {
  outlineHeadings: string[];
  documentHeadings: string[];
  mismatchIndex?: number;
}

function cleanHeading(text: string): string {
  return text
    .replace(/\s+#+\s*$/, '')
    .replace(/[*_`]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

function documentH1s(markdown: string): string[] {
  return [...markdown.matchAll(/^#\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim());
}

function documentH2s(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim());
}

/**
 * Name the "document title + `##` sections" shape when we see it.
 *
 * H1-per-slide is not a style preference — the deck is converted with
 * `slideBreak: "h1"`, so a deck whose slides are H2 renders as ONE slide.
 * But models default hard to the ordinary Markdown habit of one H1 title
 * followed by H2 sections, and the bare count mismatch ("has 1, locks 8")
 * reads as "add seven slides" rather than "change the heading level" — so
 * they re-emit the same shape until the repair budget runs out. Six of
 * fifteen powerpoint-deck trials produced exactly this, two of them with an
 * H2 count already matching the outline exactly.
 */
function headingLevelHint(
  file: string,
  documentHeadings: string[],
  h2s: string[],
  expected: number,
): string | null {
  if (documentHeadings.length > 1 || h2s.length !== expected || expected === 0) return null;
  const title = documentHeadings.length === 1 ? ` and \`# ${documentHeadings[0]}\` as a title` : '';
  return `${file} puts its ${expected} slides at \`##\`${title}, but slides are split on H1 — as written this converts to a single slide. Promote each \`## Slide\` heading to \`# \` and drop the document title.`;
}

function outlineSlideHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const match of markdown.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)) {
    const raw = match[1]!.trim();
    const numbered = /^(?:slide\s+)?\d+(?:\s*[.:\-–—]\s*|\s+)(\S.*)$/i.exec(raw);
    if (numbered?.[1]) headings.push(numbered[1].trim());
  }
  return headings;
}

/**
 * Compare a Markdown deck's H1 boundaries with a locked outline whose slides
 * are authored as `## Slide N — Title` (also accepts `## N. Title`).
 */
export async function markdownHeadingsMatch(
  ws: WorkspaceLike,
  file: string,
  outlineFile: string,
  outlineWs: WorkspaceLike = ws,
): Promise<MarkdownHeadingsMatchResult> {
  const [document, outline] = await Promise.all([ws.read(file), outlineWs.read(outlineFile)]);
  if (document === null) {
    return {
      ok: false,
      detail: `${file} not found — write the Markdown document before advancing.`,
      outlineHeadings: [],
      documentHeadings: [],
    };
  }
  if (outline === null) {
    return {
      ok: false,
      detail: `${outlineFile} not found — the locked outline is required before writing ${file}.`,
      outlineHeadings: [],
      documentHeadings: documentH1s(document),
    };
  }

  const expected = outlineSlideHeadings(outline);
  const actual = documentH1s(document);
  if (expected.length === 0) {
    return {
      ok: false,
      detail: `${outlineFile} has no numbered slide headings. Use \`## Slide 1 — Title\` through the final slide so the deck can be checked mechanically.`,
      outlineHeadings: expected,
      documentHeadings: actual,
    };
  }
  if (actual.length !== expected.length) {
    const levelHint = headingLevelHint(file, actual, documentH2s(document), expected.length);
    return {
      ok: false,
      detail:
        levelHint ??
        `${file} has ${actual.length} H1 slide headings, but ${outlineFile} locks ${expected.length}. Add or remove slides without merging outline items.`,
      outlineHeadings: expected,
      documentHeadings: actual,
    };
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (cleanHeading(actual[index]!) === cleanHeading(expected[index]!)) continue;
    return {
      ok: false,
      detail: `${file} slide ${index + 1} is "${actual[index]}", but ${outlineFile} requires "${expected[index]}" in that position. Preserve the locked slide titles and order.`,
      outlineHeadings: expected,
      documentHeadings: actual,
      mismatchIndex: index,
    };
  }

  return {
    ok: true,
    detail: `${file}: ${actual.length} H1 slide headings match ${outlineFile} exactly and in order`,
    outlineHeadings: expected,
    documentHeadings: actual,
  };
}
