import {
  type ChunkerOptions,
  MARKDOWN_CHUNKS_2,
  type MarkdownChunk,
  chunkMarkdownProfile,
} from '@bendyline/gezel-knowledge/browser';

/** How a live index splits documents. A different `id` re-chunks every document. */
export interface LiveChunking {
  readonly id: string;
  readonly options: ChunkerOptions;
}

/**
 * `markdown-chunks@1` (gezk spec §7): 4,000-character sections with 400 of
 * overlap. Needs no tokenizer, so an app can index before any model exists.
 */
export function markdownChunksByCharacters(): LiveChunking {
  return { id: 'markdown-chunks@1', options: { unit: 'chars', target: 4000, overlap: 400 } };
}

/**
 * `markdown-chunks@2`, counted with an embedding profile's tokenizer: the
 * chunking knowledge catalogs use. `tokenizer` names that tokenizer (an
 * embedding profile id, say) so switching it re-chunks.
 */
export function markdownChunksByTokens(
  countTokens: (text: string) => number,
  tokenizer: string,
): LiveChunking {
  return {
    id: `${MARKDOWN_CHUNKS_2.id}/${tokenizer}`,
    options: {
      unit: 'tokens',
      target: MARKDOWN_CHUNKS_2.target,
      overlap: MARKDOWN_CHUNKS_2.overlap,
      countTokens,
    },
  };
}

/** A chunk and where its text sits in the document body. */
export interface PlacedChunk {
  readonly kind: MarkdownChunk['kind'];
  readonly headingPath: readonly string[];
  /** 1-based inclusive line span in the body. */
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  /** Code-point offset and length in the body; null when the text is not a slice of it. */
  readonly start: number | null;
  readonly length: number | null;
}

/** snippet() marks matches with these; a body must not contain them. */
export const MATCH_OPEN = '\u0002';
export const MATCH_CLOSE = '\u0003';

/**
 * The body as the index stores and chunks it: LF line endings (line numbers
 * are the source's), well-formed UTF-16 so code-point offsets agree with
 * SQLite's, and without the two control characters snippets use as markers.
 */
export function normalizeBody(body: string): string {
  const lf = body.replace(/\r\n?/g, '\n').replaceAll(MATCH_OPEN, '').replaceAll(MATCH_CLOSE, '');
  return (lf as string & { toWellFormed?: () => string }).toWellFormed?.() ?? lf;
}

function codePointLength(text: string, from = 0, to = text.length): number {
  let count = 0;
  for (let index = from; index < to; index++) {
    const unit = text.charCodeAt(index);
    // A well-formed high surrogate always has its low half next.
    if (unit >= 0xd800 && unit <= 0xdbff) index++;
    count++;
  }
  return count;
}

/** Chunk a normalized body and locate each chunk's text in it. */
export function placeChunks(body: string, chunking: LiveChunking): PlacedChunk[] {
  const chunks = chunkMarkdownProfile(body, chunking.options);
  const lineStarts = [0];
  for (let index = body.indexOf('\n'); index !== -1; index = body.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1);
  }
  const astral = /[\uD800-\uDBFF]/.test(body);
  // Code points before each line start, computed only when they differ from UTF-16 units.
  const pointsAtLine: number[] = [];
  if (astral) {
    let points = 0;
    let previous = 0;
    for (const start of lineStarts) {
      points += codePointLength(body, previous, start);
      pointsAtLine.push(points);
      previous = start;
    }
  }
  return chunks.map((chunk) => {
    const line = chunk.lineStart - 1;
    const from = lineStarts[line] ?? 0;
    const until = lineStarts[chunk.lineEnd] ?? body.length;
    const at = body.indexOf(chunk.text, from);
    const sliced = at !== -1 && at + chunk.text.length <= until;
    let start: number | null = null;
    let length: number | null = null;
    if (sliced && chunk.text.length > 0) {
      start = astral ? (pointsAtLine[line] ?? 0) + codePointLength(body, from, at) : at;
      length = astral ? codePointLength(chunk.text) : chunk.text.length;
    }
    return {
      kind: chunk.kind,
      headingPath: chunk.headingPath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      text: chunk.text,
      start,
      length,
    };
  });
}
