/**
 * Kokoro's text frontend, shared by the desktop daemon and the mobile host.
 *
 * Kokoro reads phoneme ids rather than text, so something must turn a sentence
 * into phonemes. That job used to belong to eSpeak NG, which is GPL-3 and
 * therefore cannot ship inside an MIT app on the app stores. This module does
 * it instead, from the dictionary in the pinned voice pack plus plain
 * letter-to-sound rules, and both hosts run this same code so a sentence is
 * pronounced the same way on a phone and on a laptop.
 */

export { parseKokoroLexicon, type KokoroLexicon } from './lexicon.js';
export { soundOutWord } from './letter-to-sound.js';
export { normalizeForSpeech, spellNumber, spellOrdinal } from './normalize.js';
export { phonemizeForKokoro, type KokoroPhonemizeOptions } from './phonemize.js';
export { splitForKokoro, tokenizeKokoroPhonemes, type KokoroTokens } from './tokenize.js';
export {
  KOKORO_MAX_PHONEMES,
  KOKORO_PAD_TOKEN,
  kokoroSymbols,
  kokoroTokenFor,
} from './vocab.js';
