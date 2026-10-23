/**
 * Text to Kokoro phonemes, shared by every host.
 *
 * Order of resort per word: capitals spelled as letters ("PDF"), a reading
 * chosen by the neighbouring words ("to present" against "the present"), the
 * voice pack's dictionary, then a regular inflection of a known stem, then a
 * mixed-case name read by its parts ("macOS"), then a split into two known
 * words, then letters for a word with no vowel ("npm"), then letter-to-sound
 * rules. Short function words take their reduced forms last, once the word
 * after them is known. Mandarin runs longest-match segmentation over the Han
 * dictionary instead.
 */

import { respelledAcronym, spellCapitals, spellVowelless } from './abbreviations.js';
import { type KokoroNeighbours, reducedFunctionWord, senseCues } from './context.js';
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

/** Read a mixed-case name by its parts: "macOS" is "mac" and "OS". */
function splitCamelCase(word: string, lexicon: KokoroLexicon): string | undefined {
  if (!/\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}/u.test(word)) return undefined;
  const parts = word.match(/\p{Lu}{2,}(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}/gu);
  if (!parts || parts.join('') !== word) return undefined;
  return parts
    .map((part) => spellCapitals(part, lexicon) ?? phonemesForWord(part, lexicon))
    .join('');
}

function phonemesForWord(word: string, lexicon: KokoroLexicon): string {
  return (
    lexicon.lookup(word) ??
    splitCamelCase(word, lexicon) ??
    splitCompound(word.toLowerCase(), lexicon) ??
    spellVowelless(word, lexicon) ??
    soundOutWord(word)
  );
}

function phonemesInContext(
  word: string,
  around: KokoroNeighbours,
  lexicon: KokoroLexicon,
  phraseInCapitals: boolean,
): string {
  return (
    respelledAcronym(word, lexicon) ??
    spellCapitals(word, lexicon, phraseInCapitals) ??
    lexicon.lookupSense?.(word, senseCues(word.toLowerCase(), around)) ??
    phonemesForWord(word, lexicon)
  );
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

interface Piece {
  readonly kind: 'han' | 'word' | 'space' | 'other';
  readonly text: string;
  readonly index: number;
}

/** The nearest word before or after `index`; spaces are skipped, anything else ends the phrase. */
function wordBeside(pieces: readonly Piece[], index: number, step: 1 | -1): number | undefined {
  for (let at = index + step; at >= 0 && at < pieces.length; at += step) {
    const { kind } = pieces[at]!;
    if (kind === 'word') return at;
    if (kind !== 'space') return undefined;
  }
  return undefined;
}

export function phonemizeForKokoroWithMapping(
  text: string,
  options: KokoroPhonemizeOptions,
): KokoroMappedPhonemes {
  const prepared =
    options.normalize === false
      ? MappedSpeechText.from(text, false)
      : normalizeForSpeechWithMapping(text);
  const pattern = /([\p{Script=Han}]+)|([\p{L}\p{M}'’-]+)|(\s+)|([^\s])/gu;
  const pieces: Piece[] = [...prepared.text.matchAll(pattern)].map((match) => ({
    kind: match[1] ? 'han' : match[2] ? 'word' : match[3] ? 'space' : 'other',
    text: match[0],
    index: match.index,
  }));

  // A phrase written entirely in capitals reads its words as words ("ABOUT US").
  const words = pieces.filter((piece) => piece.kind === 'word').map((piece) => piece.text);
  const phraseInCapitals =
    words.filter((word) => /\p{Lu}{2}/u.test(word)).length >= 2 &&
    !words.some((word) => /\p{Ll}/u.test(word));

  const neighbours = pieces.map((_, index) => {
    const previous = wordBeside(pieces, index, -1);
    const next = wordBeside(pieces, index, 1);
    return { previous, next };
  });
  const lower = (index: number | undefined) =>
    index === undefined ? undefined : pieces[index]!.text.toLowerCase();
  const spoken = pieces.map((piece, index) => {
    if (piece.kind !== 'word') return '';
    const { previous, next } = neighbours[index]!;
    return phonemesInContext(
      piece.text,
      {
        previous: lower(previous),
        beforePrevious: lower(previous === undefined ? undefined : neighbours[previous]!.previous),
        next: lower(next),
        afterNext: lower(next === undefined ? undefined : neighbours[next]!.next),
      },
      options.lexicon,
      phraseInCapitals,
    );
  });
  // Function words depend on how the next word sounds, so they come last.
  for (const [index, piece] of pieces.entries()) {
    if (piece.kind !== 'word') continue;
    const { previous, next } = neighbours[index]!;
    const reduced = reducedFunctionWord(
      piece.text,
      next === undefined ? undefined : spoken[next],
      previous === undefined,
    );
    if (reduced !== undefined) spoken[index] = reduced;
  }

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
  for (const [index, piece] of pieces.entries()) {
    const range = prepared.range(piece.index, piece.index + piece.text.length);
    if (piece.kind === 'han') {
      if (options.hanLexicon) {
        for (const [part, found] of phonemesForHan(piece.text, options.hanLexicon).entries()) {
          const source = prepared.range(piece.index + found.start, piece.index + found.end);
          if (part) append(' ', source);
          append(found.phonemes, source, wordIndex++);
        }
      }
    } else if (piece.kind === 'word') append(spoken[index]!, range, wordIndex++);
    else if (piece.kind === 'space') append(' ', range);
    else if (kokoroTokenFor(piece.text) !== undefined) append(piece.text, range);
  }
  const trimmed = phonemes.trimEnd();
  return { phonemes: trimmed, ranges: ranges.slice(0, trimmed.length) };
}
