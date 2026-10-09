/**
 * Text to Kokoro phonemes, shared by every host.
 *
 * Order of resort per word: the voice pack's dictionary, then a regular
 * inflection of a known stem, then a split into two known words, then
 * letter-to-sound rules. Mandarin runs longest-match segmentation over the
 * Han dictionary instead.
 */

import { soundOutWord } from './letter-to-sound.js';
import type { KokoroLexicon } from './lexicon.js';
import { normalizeForSpeechWithMapping } from './normalize.js';
import { type KokoroSourceRange, MappedSpeechText } from './source-map.js';
import { kokoroTokenFor } from './vocab.js';

/** Longest Han run tried as a single dictionary word. */
const MAX_HAN_WORD = 6;
/** Shortest half of a compound worth trusting. */
const MIN_COMPOUND_PART = 3;

export interface KokoroPhonemizeOptions {
  /** Dictionary for the voice's language, from the pinned voice pack. */
  readonly lexicon: KokoroLexicon;
  /** Han dictionary, required only for Mandarin voices. */
  readonly hanLexicon?: KokoroLexicon;
  /** Skip normalisation when the caller has already expanded the text. */
  readonly normalize?: boolean;
}

/** Split a coinage into two dictionary words, as in "bendyline" or "workflow". */
function splitCompound(word: string, lexicon: KokoroLexicon): string | undefined {
  for (let cut = MIN_COMPOUND_PART; cut <= word.length - MIN_COMPOUND_PART; cut++) {
    const head = lexicon.lookup(word.slice(0, cut));
    if (!head) continue;
    const tail = lexicon.lookup(word.slice(cut));
    if (tail) return head + tail;
  }
  return undefined;
}

function phonemesForWord(word: string, lexicon: KokoroLexicon): string {
  return lexicon.lookup(word) ?? splitCompound(word.toLowerCase(), lexicon) ?? soundOutWord(word);
}

/** Longest-match segmentation for Han text, which is written without spaces. */
function phonemesForHan(
  run: string,
  lexicon: KokoroLexicon,
): Array<{ phonemes: string; start: number; end: number }> {
  const parts: Array<{ phonemes: string; start: number; end: number }> = [];
  let index = 0;
  while (index < run.length) {
    let matched = '';
    let width = 0;
    for (let size = Math.min(MAX_HAN_WORD, run.length - index); size > 0; size--) {
      const found = lexicon.lookup(run.slice(index, index + size));
      if (found !== undefined) {
        matched = found;
        width = size;
        break;
      }
    }
    if (width === 0) {
      index += 1;
      continue;
    }
    parts.push({ phonemes: matched, start: index, end: index + width });
    index += width;
  }
  return parts;
}

/** Phonemes and their original-source ranges before token filtering. */
export interface KokoroMappedPhonemes {
  readonly phonemes: string;
  /** One entry per UTF-16 code unit in phonemes. */
  readonly ranges: readonly (KokoroSourceRange & { readonly word?: number })[];
}

/** Preserve known punctuation for prosody; omit unsupported symbols. */
export function phonemizeForKokoro(text: string, options: KokoroPhonemizeOptions): string {
  return phonemizeForKokoroWithMapping(text, options).phonemes;
}

export function phonemizeForKokoroWithMapping(
  text: string,
  options: KokoroPhonemizeOptions,
): KokoroMappedPhonemes {
  const prepared =
    options.normalize === false
      ? MappedSpeechText.from(text, false)
      : normalizeForSpeechWithMapping(text);
  let phonemes = '';
  const ranges: Array<KokoroSourceRange & { readonly word?: number }> = [];
  let wordIndex = 0;
  const append = (value: string, range: KokoroSourceRange, word?: number) => {
    for (const symbol of value) {
      const normalized = /\s/u.test(symbol) ? ' ' : symbol;
      if (normalized === ' ' && (!phonemes || phonemes.endsWith(' '))) continue;
      phonemes += normalized;
      for (let i = 0; i < normalized.length; i++)
        ranges.push({ ...range, ...(word !== undefined ? { word } : {}) });
    }
  };
  const pattern = /([\p{Script=Han}]+)|([\p{L}\p{M}'’-]+)|(\s+)|([^\s])/gu;
  for (const match of prepared.text.matchAll(pattern)) {
    const [, han, word, space, other] = match;
    const range = prepared.range(match.index, match.index + match[0].length);
    if (han) {
      if (options.hanLexicon) {
        for (const [index, part] of phonemesForHan(han, options.hanLexicon).entries()) {
          const source = prepared.range(match.index + part.start, match.index + part.end);
          if (index) append(' ', source);
          append(part.phonemes, source, wordIndex++);
        }
      }
    } else if (word) append(phonemesForWord(word, options.lexicon), range, wordIndex++);
    else if (space) append(' ', range);
    else if (other && kokoroTokenFor(other) !== undefined) append(other, range);
  }
  const trimmed = phonemes.trimEnd();
  return { phonemes: trimmed, ranges: ranges.slice(0, trimmed.length) };
}
