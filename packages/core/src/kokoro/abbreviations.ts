/**
 * Abbreviations a reader spells out: "PDF" is "pee dee eff", never a word.
 *
 * misaki spells an all-capital word it does not know, and one it knows only as
 * a different word when the capitals name something ("US", "IT"). A word with
 * no vowel letter ("npm", "pdf") cannot be read as a word either. Without these
 * rules such words fell through to letter-to-sound, which read "PDF" as one
 * syllable. Letter names come from the dictionary, so each voice uses its own.
 */

import { soundOutWord } from './letter-to-sound.js';
import { type KokoroLexicon, pluralSuffix } from './lexicon.js';
import { KOKORO_SPELLED_CAPITALS } from './senses-data.js';

const SPELLED_CAPITALS: ReadonlySet<string> = new Set(
  KOKORO_SPELLED_CAPITALS.split(/\s+/u).filter(Boolean),
);
const VOWEL_LETTER = /[aeiouy]/iu;

/** Acronyms read as words the dictionary lacks, respelled as words it has. */
const RESPELLED: Readonly<Record<string, string>> = { json: 'jason' };

/** File formats said as words the dictionary lacks; letter-to-sound reads them well. */
const SOUNDED_OUT: ReadonlySet<string> = new Set(['epub', 'toml', 'wasm', 'yaml']);

/** The dictionary's own entry, without rebuilt inflections when the lexicon can say. */
function entry(lexicon: KokoroLexicon, word: string): string | undefined {
  return lexicon.lookupEntry ? lexicon.lookupEntry(word) : lexicon.lookup(word);
}

/**
 * Letter names joined the way misaki joins them: every letter keeps secondary
 * stress and the last takes the primary. Undefined when a letter is missing.
 */
export function spellLetters(letters: string, lexicon: KokoroLexicon): string | undefined {
  let phonemes = '';
  for (const letter of letters.toLowerCase()) {
    // The dictionary's "a" is the unstressed article; the letter is stressed.
    const name = letter === 'a' ? 'ˈA' : entry(lexicon, letter);
    if (!name) return undefined;
    phonemes += name.replaceAll('ˈ', 'ˌ');
  }
  const last = phonemes.lastIndexOf('ˌ');
  return last < 0 ? phonemes : `${phonemes.slice(0, last)}ˈ${phonemes.slice(last + 1)}`;
}

/** An acronym said as a word that the dictionary spells differently: "JSON". */
export function respelledAcronym(word: string, lexicon: KokoroLexicon): string | undefined {
  const respelling = RESPELLED[word.toLowerCase()];
  return respelling === undefined ? undefined : entry(lexicon, respelling);
}

/**
 * Phonemes for a word written in capitals ("PDF", "UX", "PDFs", "IT"), or
 * undefined when it should be read as a word ("NASA", "OK"). When the whole
 * phrase is in capitals ("ABOUT US"), capitals that are also words read as words.
 */
export function spellCapitals(
  word: string,
  lexicon: KokoroLexicon,
  phraseInCapitals = false,
): string | undefined {
  const match = /^([A-Z]{2,})(['’]?s)?$/u.exec(word);
  if (!match) return undefined;
  const letters = match[1]!;
  const plural = match[2] !== undefined;
  const lower = letters.toLowerCase();
  const asWord = SOUNDED_OUT.has(lower)
    ? soundOutWord(lower)
    : VOWEL_LETTER.test(letters) && (phraseInCapitals || !SPELLED_CAPITALS.has(letters))
      ? entry(lexicon, lower)
      : undefined;
  // A known word reads in context like any other; only its plural is built here.
  if (asWord !== undefined && !plural) return undefined;
  const base = asWord ?? spellLetters(letters, lexicon);
  if (base === undefined) return undefined;
  return plural ? base + pluralSuffix(base) : base;
}

/** Phonemes for a word with no vowel letter ("npm"), which can only be letters. */
export function spellVowelless(word: string, lexicon: KokoroLexicon): string | undefined {
  if (word.length < 2 || !/^[a-z]+$/iu.test(word) || VOWEL_LETTER.test(word)) return undefined;
  return spellLetters(word, lexicon);
}
