/**
 * The canonical markdown chunker, parameterized over the two frozen
 * profiles (the gezk spec §7):
 *
 *   - `markdown-chunks@1` — unit 'chars', 4000/400: byte-for-byte the
 *     algorithm lifted from the project indexer
 *     (packages/service/src/index-store/docs.ts `chunkMarkdown` /
 *     `chunkLineRange`), so the service can later re-point here with zero
 *     behavior change.
 *   - `markdown-chunks@2` — unit 'tokens', 420/64: the knowledge
 *     profile. Token counting is injected (`countTokens` — the embedding
 *     profile's own tokenizer), packing is per-line with sentence-level
 *     splitting for oversized lines, and every chunk carries a structural
 *     `headingPath` (root→nearest, the section's own heading last).
 *
 * Pure functions, no I/O, no dependencies — importable by the compiler, the
 * service indexer, and tests alike.
 */

export interface MarkdownChunk {
  kind: 'doc' | 'preamble' | 'section';
  /** 1-based inclusive source line span. */
  lineStart: number;
  lineEnd: number;
  text: string;
  /** Raw heading texts, root → nearest (empty for preamble/doc chunks). */
  headingPath: string[];
}

export interface CharChunkerOptions {
  unit: 'chars';
  /** Max chunk size in characters (profile @1: 4000). */
  target: number;
  /** Overlap replayed between adjacent chunks, in characters (@1: 400). */
  overlap: number;
}

export interface TokenChunkerOptions {
  unit: 'tokens';
  /** Target chunk size in tokens (profile @2: 420). */
  target: number;
  /** Overlap in tokens (@2: 64). */
  overlap: number;
  /** The embedding profile's tokenizer — deterministic given its pinned digest. */
  countTokens: (text: string) => number;
}

export type ChunkerOptions = CharChunkerOptions | TokenChunkerOptions;

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Split markdown into heading-aware, bounded, overlapping chunks. */
export function chunkMarkdownProfile(md: string, opts: ChunkerOptions): MarkdownChunk[] {
  const lines = md.split(/\r?\n/);
  const headIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING.test(lines[i] as string)) headIdx.push(i);
  }

  const out: MarkdownChunk[] = [];
  if (headIdx.length === 0) {
    return chunkRange(lines, 0, lines.length - 1, 'doc', [], opts);
  }
  if ((headIdx[0] as number) > 0) {
    out.push(...chunkRange(lines, 0, (headIdx[0] as number) - 1, 'preamble', [], opts));
  }
  // Heading stack tracks the path; each section's chunks carry the stack
  // including the section's own heading (root → nearest).
  const stack: Array<{ depth: number; text: string }> = [];
  for (let h = 0; h < headIdx.length; h++) {
    const start = headIdx[h] as number;
    const end = h + 1 < headIdx.length ? (headIdx[h + 1] as number) - 1 : lines.length - 1;
    const m = HEADING.exec(lines[start] as string);
    const depth = m ? (m[1]?.length ?? 1) : 1;
    const text = m ? (m[2] ?? '').trim() : '';
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) {
      stack.pop();
    }
    stack.push({ depth, text });
    const headingPath = stack.map((s) => s.text).filter((t) => t.length > 0);
    out.push(...chunkRange(lines, start, end, 'section', headingPath, opts));
  }
  return out;
}

function measure(text: string, opts: ChunkerOptions): number {
  return opts.unit === 'chars' ? text.length : opts.countTokens(text);
}

/** Split a line range into bounded, slightly-overlapping chunks without losing tails. */
function chunkRange(
  lines: readonly string[],
  start: number,
  end: number,
  kind: MarkdownChunk['kind'],
  headingPath: string[],
  opts: ChunkerOptions,
): MarkdownChunk[] {
  const out: MarkdownChunk[] = [];
  // Per-line size cache — token counting is the expensive path.
  const lineSize = new Map<number, number>();
  const sizeOf = (i: number): number => {
    let s = lineSize.get(i);
    if (s === undefined) {
      s = measure(lines[i] ?? '', opts);
      lineSize.set(i, s);
    }
    return s;
  };
  // Cost of a newline joining two lines: 1 char, or 0 tokens (tokenizers
  // absorb whitespace; counting it would double-count against the target).
  const joinCost = opts.unit === 'chars' ? 1 : 0;

  let cursor = start;
  while (cursor <= end) {
    const first = lines[cursor] ?? '';
    // One enormous physical line (minified/generated data): preserve it as
    // overlapping windows; the source span stays that one line.
    if (sizeOf(cursor) > opts.target) {
      for (const text of splitOversizeLine(first, opts)) {
        if (text) out.push({ kind, lineStart: cursor + 1, lineEnd: cursor + 1, text, headingPath });
      }
      cursor++;
      continue;
    }

    let chunkEnd = cursor;
    let size = sizeOf(cursor);
    while (chunkEnd + 1 <= end) {
      const nextSize = sizeOf(chunkEnd + 1) + joinCost;
      if (size + nextSize > opts.target) break;
      size += nextSize;
      chunkEnd++;
    }
    const text = lines
      .slice(cursor, chunkEnd + 1)
      .join('\n')
      .trim();
    if (text) {
      out.push({ kind, lineStart: cursor + 1, lineEnd: chunkEnd + 1, text, headingPath });
    }
    if (chunkEnd >= end) break;

    // Replay a few trailing lines so facts on a boundary keep local context.
    // Always advance at least one line so the loop progresses.
    let nextCursor = chunkEnd + 1;
    let overlap = 0;
    for (let i = chunkEnd; i > cursor; i--) {
      const length = sizeOf(i) + joinCost;
      if (overlap + length > opts.overlap) break;
      overlap += length;
      nextCursor = i;
    }
    cursor = Math.max(cursor + 1, nextCursor);
  }
  return out;
}

/**
 * Oversized single line: chars mode windows by characters (the lifted @1
 * behavior); tokens mode splits at sentence boundaries first, then hard
 * character windows sized from the measured chars-per-token ratio.
 */
function splitOversizeLine(line: string, opts: ChunkerOptions): string[] {
  if (opts.unit === 'chars') {
    const out: string[] = [];
    let offset = 0;
    while (offset < line.length) {
      out.push(line.slice(offset, offset + opts.target).trim());
      if (offset + opts.target >= line.length) break;
      offset += opts.target - opts.overlap;
    }
    return out;
  }

  const sentences = line.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length > 0) {
      const text = current.join(' ').trim();
      if (text) out.push(text);
      current = [];
      currentTokens = 0;
    }
  };
  for (const sentence of sentences) {
    const tokens = opts.countTokens(sentence);
    if (tokens > opts.target) {
      // A single sentence past the target: hard character windows scaled by
      // the measured density. Deterministic given a deterministic tokenizer.
      flush();
      const charsPerToken = Math.max(1, sentence.length / tokens);
      const window = Math.max(1, Math.floor(opts.target * charsPerToken));
      const step = Math.max(1, window - Math.floor(opts.overlap * charsPerToken));
      for (let offset = 0; offset < sentence.length; offset += step) {
        const piece = sentence.slice(offset, offset + window).trim();
        if (piece) out.push(piece);
        if (offset + window >= sentence.length) break;
      }
      continue;
    }
    if (currentTokens + tokens > opts.target) flush();
    current.push(sentence);
    currentTokens += tokens;
  }
  flush();
  return out;
}
