/**
 * Collapse hard-wrapped paragraphs into one logical line per block.
 *
 * The squisq markdown parser keeps a single newline inside a paragraph
 * as literal text, and the doc renderer honors it — so prose wrapped at
 * 80 columns renders with a visible break after every source line. The
 * Handboek pulls prose from places this repo does not control (gilde
 * gezel-template `about.md`, craftbook and project-type descriptions),
 * so normalization happens at render time rather than only in the
 * shipped `docs/handboek/` sources.
 *
 * Structure is left alone: fenced code, tables, headings, list markers,
 * blockquotes, indented code, and macro directives all stay on their
 * own lines. Only continuation lines of a paragraph or of a list item
 * fold upward.
 */

const LIST_ITEM = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/;
const STRUCTURAL = /^\s*(?:#{1,6}\s|\||>|(?:---|\*\*\*|___)\s*$|::|<)/;
const FENCE = /^\s*(?:```|~~~)/;
const INDENTED_CODE = /^(?: {4,}|\t)/;

export function unwrapSoftBreaks(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let pending: string | null = null;
  let inFence = false;

  const flush = () => {
    if (pending !== null) out.push(pending);
    pending = null;
  };

  for (const line of lines) {
    if (FENCE.test(line)) {
      flush();
      out.push(line);
      inFence = !inFence;
      continue;
    }
    if (inFence || line.trim() === '' || STRUCTURAL.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      pending = line.trimEnd();
      continue;
    }
    if (pending === null) {
      // Only at block start: mid-paragraph indentation is a wrapped
      // continuation, not a code block.
      if (INDENTED_CODE.test(line)) {
        out.push(line);
        continue;
      }
      pending = line.trimEnd();
      continue;
    }
    pending = `${pending} ${line.trim()}`;
  }
  flush();
  return out.join('\n');
}
