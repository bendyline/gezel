/**
 * Collapse gratuitous intra-paragraph line breaks in markdown produced by LLMs.
 *
 * Models love to hard-wrap prose at ~80 columns. CommonMark treats those
 * newlines as spaces, but any renderer with `breaks: true` — or a plain-text
 * view, or the raw markdown editor — surfaces them as real line breaks, which
 * makes generated about.md / documents look jagged.
 *
 * Rules:
 *   • Fenced code blocks (``` or ~~~) are preserved verbatim.
 *   • Blank lines (paragraph breaks) are preserved.
 *   • Lines whose first non-space character is a block-level marker
 *     (#, -, *, +, >, ordered-list N., |, ---/===) start a new line.
 *   • Every other single newline inside a paragraph collapses to one space.
 *   • A trailing "  \n" (markdown hard break) is preserved.
 */
export function normalizeMarkdown(input: string): string {
  if (!input) return input;

  const segments = splitByFences(input);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.fenced) {
      out.push(seg.text);
    } else {
      out.push(collapseParagraphs(seg.text));
    }
  }
  return out.join('');
}

interface Segment {
  fenced: boolean;
  text: string;
}

function splitByFences(input: string): Segment[] {
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
  const segments: Segment[] = [];
  let last = 0;
  for (const m of input.matchAll(fenceRe)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      segments.push({ fenced: false, text: input.slice(last, idx) });
    }
    segments.push({ fenced: true, text: m[0] });
    last = idx + m[0].length;
  }
  if (last < input.length) {
    segments.push({ fenced: false, text: input.slice(last) });
  }
  return segments;
}

function collapseParagraphs(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length) {
      result.push(buf.join(' '));
      buf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      result.push('');
      continue;
    }

    if (line.endsWith('  ')) {
      if (buf.length) buf.push(trimmed);
      else buf.push(line);
      flush();
      continue;
    }

    if (isStandaloneBlock(trimmed)) {
      flush();
      result.push(line.replace(/\s+$/, ''));
      continue;
    }

    if (isContinuableBlock(trimmed)) {
      flush();
      buf.push(line.replace(/\s+$/, ''));
      continue;
    }

    buf.push(trimmed);
  }
  flush();

  return result.join('\n');
}

function isStandaloneBlock(trimmed: string): boolean {
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^-{3,}$|^={3,}$|^\*{3,}$|^_{3,}$/.test(trimmed)) return true;
  return false;
}

function isContinuableBlock(trimmed: string): boolean {
  if (/^(?:[-*+])\s/.test(trimmed)) return true;
  if (/^\d+[.)]\s/.test(trimmed)) return true;
  if (/^>/.test(trimmed)) return true;
  if (/^\|/.test(trimmed)) return true;
  return false;
}
