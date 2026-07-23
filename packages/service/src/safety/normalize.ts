/**
 * Text normalization that defeats hidden-text smuggling in untrusted content.
 * Prompt-injection payloads love invisible carriers: zero-width characters,
 * the Unicode Tags block (U+E0000-E007F, which renders as nothing but encodes
 * arbitrary ASCII), and bidi-override controls that reorder displayed text.
 * Normalization is applied unconditionally to every piece of untrusted content
 * — hidden carriers are *removed*, not merely detected, so a payload the
 * pattern scanner doesn't recognize still can't ride in invisibly.
 *
 * The carrier ranges are built from numeric code points (not regex literals)
 * so no invisible characters live in this source file.
 */

export interface NormalizeResult {
  text: string;
  /** Categories of carrier that were stripped — surfaced as scan flags. */
  flags: string[];
}

/** Build a global character-class RegExp from explicit code points / ranges. */
function classFrom(items: Array<number | [number, number]>): RegExp {
  const esc = (cp: number) => `\\u{${cp.toString(16)}}`;
  const body = items
    .map((it) => (typeof it === 'number' ? esc(it) : `${esc(it[0])}-${esc(it[1])}`))
    .join('');
  return new RegExp(`[${body}]`, 'gu');
}

// Zero-width / word-joiner / BOM characters with no legitimate use in body text.
const ZERO_WIDTH = classFrom([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
// Unicode Tags block — invisible, used to encode hidden instructions.
const UNICODE_TAGS = classFrom([[0xe0000, 0xe007f]]);
// Bidirectional formatting controls (overrides + isolates).
const BIDI_CONTROLS = classFrom([
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]);
// C0/C1 control characters except tab (0x09), newline (0x0A), CR (0x0D).
const CONTROLS = classFrom([[0x00, 0x08], 0x0b, 0x0c, [0x0e, 0x1f], [0x7f, 0x9f]]);

/** Strip a carrier class; record a flag when anything was actually removed. */
function strip(text: string, re: RegExp, flag: string, flags: string[]): string {
  const replaced = text.replace(re, '');
  if (replaced !== text) flags.push(flag);
  return replaced;
}

/**
 * Strip invisible carriers and apply NFKC compatibility folding (which collapses
 * fullwidth / styled homoglyphs back to plain ASCII). Returns the cleaned text
 * plus the categories of carrier that were present.
 */
export function normalizeText(input: string): NormalizeResult {
  const flags: string[] = [];
  let text = input;
  text = strip(text, ZERO_WIDTH, 'zero-width', flags);
  text = strip(text, UNICODE_TAGS, 'unicode-tags', flags);
  text = strip(text, BIDI_CONTROLS, 'bidi-controls', flags);
  text = strip(text, CONTROLS, 'control-chars', flags);

  // NFKC folds compatibility homoglyphs (fullwidth -> ascii, ligatures, etc.)
  // so pattern matching sees canonical forms and homoglyph evasion is blunted.
  const folded = text.normalize('NFKC');
  if (folded !== text) flags.push('compat-folded');
  text = folded;

  return { text, flags };
}
