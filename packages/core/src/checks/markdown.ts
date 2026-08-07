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
): Promise<MarkdownHeadingsMatchResult> {
  const [document, outline] = await Promise.all([ws.read(file), ws.read(outlineFile)]);
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
    return {
      ok: false,
      detail: `${file} has ${actual.length} H1 slide headings, but ${outlineFile} locks ${expected.length}. Add or remove slides without merging outline items.`,
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
