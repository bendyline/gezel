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
import { normalizeForSpeech } from './normalize.js';
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
function phonemesForHan(run: string, lexicon: KokoroLexicon): string {
  const parts: string[] = [];
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
    parts.push(matched);
    index += width;
  }
  return parts.join(' ');
}

/**
 * Convert text to a phoneme string the tokenizer accepts. Punctuation the
 * model knows is preserved, because it carries the phrasing; anything else is
 * dropped rather than spoken.
 */
export function phonemizeForKokoro(text: string, options: KokoroPhonemizeOptions): string {
  const prepared = options.normalize === false ? text : normalizeForSpeech(text);
  const pieces: string[] = [];
  // Words, Han runs, and single other characters, in document order.
  const pattern = /([\p{Script=Han}]+)|([\p{L}\p{M}'’-]+)|(\s+)|([^\s])/gu;
  for (const match of prepared.matchAll(pattern)) {
    const [, han, word, space, other] = match;
    if (han) {
      const lexicon = options.hanLexicon;
      if (lexicon) pieces.push(phonemesForHan(han, lexicon));
      continue;
    }
    if (word) {
      const phonemes = phonemesForWord(word, options.lexicon);
      if (phonemes) pieces.push(phonemes);
      continue;
    }
    if (space) {
      if (pieces.at(-1) !== ' ') pieces.push(' ');
      continue;
    }
    // Keep only punctuation the model has a symbol for.
    if (other && kokoroTokenFor(other) !== undefined) pieces.push(other);
  }
  return pieces.join('').replace(/\s+/g, ' ').trim();
}
