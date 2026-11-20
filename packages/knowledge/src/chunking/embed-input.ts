/**
 * The exact text an embedder sees for one chunk (the gezk spec §5): the
 * profile's passage instruction, a short context header naming the document
 * and its heading path, then the chunk itself. The compiler and every live
 * index build it here, so a passage embeds identically wherever it lives.
 */

/** `title\nheadingPath\n`, truncated to the header token budget (§5). */
export function buildContextHeader(
  title: string,
  headingPath: readonly string[],
  maxTokens: number,
  countTokens: (text: string) => number,
): string {
  const path = headingPath.filter((h) => h !== title);
  let header = path.length > 0 ? `${title}\n${path.join(' > ')}\n` : `${title}\n`;
  if (countTokens(header) > maxTokens) {
    header = `${title}\n`;
    if (countTokens(header) > maxTokens) header = '';
  }
  return header;
}

export interface PassageEmbedInput {
  /** The embedding profile's passage instruction (often empty). */
  readonly passageInstruction: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  /** The chunking profile's context-header budget, in tokens. */
  readonly headerMaxTokens: number;
  /** The embedding profile's tokenizer. */
  readonly countTokens: (text: string) => number;
}

/** The passage text to embed for one chunk. */
export function passageEmbedInput(input: PassageEmbedInput): string {
  return `${input.passageInstruction}${buildContextHeader(
    input.title,
    input.headingPath,
    input.headerMaxTokens,
    input.countTokens,
  )}${input.text}`;
}
