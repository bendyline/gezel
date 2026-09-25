/**
 * Letter-to-sound rules for words the lexicon does not know.
 *
 * The voice pack's dictionary covers ordinary English, and regular inflections
 * are rebuilt from their stems, so this runs only for names, coinages and
 * typos. It replaces the eSpeak NG fallback, which cannot ship in a store
 * build: eSpeak NG is GPL-3 and Gezel is MIT. These rules are deliberately
 * plain, context-sensitive spelling rules in the same tradition, emitting the
 * phoneme symbols Kokoro was trained on.
 *
 * Accuracy is lower than a dictionary hit. Callers should prefer the lexicon
 * and treat this as the last resort before spelling a word out.
 */

interface Rule {
  /** Letters consumed when the rule fires. */
  readonly letters: string;
  /** Phonemes emitted, possibly empty for a silent letter. */
  readonly phonemes: string;
  /** Text to the left must end with this. */
  readonly before?: RegExp;
  /** Text after the consumed letters must start with this. */
  readonly after?: RegExp;
}

const VOWEL_LETTER = 'aeiouy';
const CONSONANT = '[^aeiouy]';
/** A single consonant then the end of the word: the "magic e" frame. */
const MAGIC_E = new RegExp(`^${CONSONANT}e$`);
const FINAL = /^$/;
const START = /(?:^|[^a-z])$/;

/**
 * Ordered rules. The first rule that matches at a position wins, so longer
 * spellings are listed before the single letters they begin with.
 */
const RULES: readonly Rule[] = [
  { letters: 'tion', phonemes: 'ʃən' },
  { letters: 'sion', phonemes: 'ʒən' },
  { letters: 'ture', phonemes: 'ʧəɹ' },
  { letters: 'ough', phonemes: 'ʌf' },
  { letters: 'augh', phonemes: 'ɔ' },
  { letters: 'eigh', phonemes: 'A' },
  { letters: 'igh', phonemes: 'I' },
  { letters: 'tch', phonemes: 'ʧ' },
  { letters: 'dge', phonemes: 'ʤ' },
  { letters: 'kn', phonemes: 'n', before: START },
  { letters: 'wr', phonemes: 'ɹ', before: START },
  { letters: 'mb', phonemes: 'm', after: FINAL },
  { letters: 'ck', phonemes: 'k' },
  { letters: 'ch', phonemes: 'ʧ' },
  { letters: 'sh', phonemes: 'ʃ' },
  { letters: 'th', phonemes: 'θ' },
  { letters: 'ph', phonemes: 'f' },
  { letters: 'wh', phonemes: 'w' },
  { letters: 'nge', phonemes: 'nʤ', after: FINAL },
  { letters: 'ng', phonemes: 'ŋ' },
  { letters: 'qu', phonemes: 'kw' },
  { letters: 'gh', phonemes: '' },
  { letters: 'ai', phonemes: 'A' },
  { letters: 'ay', phonemes: 'A' },
  { letters: 'ea', phonemes: 'i' },
  { letters: 'ee', phonemes: 'i' },
  { letters: 'ei', phonemes: 'i' },
  { letters: 'ey', phonemes: 'A' },
  { letters: 'ie', phonemes: 'i' },
  { letters: 'oa', phonemes: 'O' },
  { letters: 'oe', phonemes: 'O' },
  { letters: 'oo', phonemes: 'u' },
  { letters: 'ou', phonemes: 'W' },
  { letters: 'ow', phonemes: 'O', after: FINAL },
  { letters: 'ow', phonemes: 'W' },
  { letters: 'oi', phonemes: 'Y' },
  { letters: 'oy', phonemes: 'Y' },
  { letters: 'ue', phonemes: 'u' },
  { letters: 'ui', phonemes: 'u' },
  { letters: 'au', phonemes: 'ɔ' },
  { letters: 'aw', phonemes: 'ɔ' },
  { letters: 'ar', phonemes: 'ɑɹ' },
  { letters: 'er', phonemes: 'ɜɹ' },
  { letters: 'ir', phonemes: 'ɜɹ' },
  { letters: 'ur', phonemes: 'ɜɹ' },
  { letters: 'or', phonemes: 'ɔɹ' },
  // Magic e: the vowel says its name and the final e is silent.
  { letters: 'a', phonemes: 'A', after: MAGIC_E },
  { letters: 'e', phonemes: 'i', after: MAGIC_E },
  { letters: 'i', phonemes: 'I', after: MAGIC_E },
  { letters: 'o', phonemes: 'O', after: MAGIC_E },
  { letters: 'u', phonemes: 'u', after: MAGIC_E },
  { letters: 'c', phonemes: 's', after: /^[eiy]/ },
  { letters: 'c', phonemes: 'k' },
  { letters: 'g', phonemes: 'ʤ', after: /^[eiy]/ },
  { letters: 'g', phonemes: 'ɡ' },
  { letters: 'x', phonemes: 'ks' },
  { letters: 'j', phonemes: 'ʤ' },
  { letters: 'y', phonemes: 'j', before: START },
  { letters: 'y', phonemes: 'I', after: FINAL, before: new RegExp(`${CONSONANT}$`) },
  { letters: 'y', phonemes: 'i', after: FINAL },
  { letters: 'y', phonemes: 'ɪ' },
  {
    letters: 'e',
    phonemes: '',
    after: FINAL,
    before: new RegExp(`[${VOWEL_LETTER}]${CONSONANT}+$`),
  },
  { letters: 'a', phonemes: 'æ' },
  { letters: 'e', phonemes: 'ɛ' },
  { letters: 'i', phonemes: 'ɪ' },
  { letters: 'o', phonemes: 'ɑ' },
  { letters: 'u', phonemes: 'ʌ' },
  { letters: 'b', phonemes: 'b' },
  { letters: 'd', phonemes: 'd' },
  { letters: 'f', phonemes: 'f' },
  { letters: 'h', phonemes: 'h' },
  { letters: 'k', phonemes: 'k' },
  { letters: 'l', phonemes: 'l' },
  { letters: 'm', phonemes: 'm' },
  { letters: 'n', phonemes: 'n' },
  { letters: 'p', phonemes: 'p' },
  { letters: 'r', phonemes: 'ɹ' },
  { letters: 's', phonemes: 'z', after: FINAL, before: /[aeiouylmnrbdgvwz]$/ },
  { letters: 's', phonemes: 's' },
  { letters: 't', phonemes: 't' },
  { letters: 'v', phonemes: 'v' },
  { letters: 'w', phonemes: 'w' },
  { letters: 'z', phonemes: 'z' },
];

const OUTPUT_VOWELS = new Set([...'AIWYOQaæɑɒɔəɛɜiɪuʊʌᵻ']);

/**
 * Place primary stress on the first syllable, which is the usual English
 * default and the safer guess for the names and coinages that reach these
 * rules. Words whose first syllable is genuinely unstressed are the common
 * case in the dictionary, so they rarely arrive here.
 */
function stress(phonemes: string): string {
  const symbols = [...phonemes];
  const first = symbols.findIndex((symbol) => OUTPUT_VOWELS.has(symbol));
  if (first < 0) return phonemes;
  symbols.splice(first, 0, 'ˈ');
  return symbols.join('');
}

/**
 * Sound out a word from its spelling. Returns an empty string when the word
 * holds no letters, which tells the caller to spell it out instead.
 */
export function soundOutWord(word: string): string {
  // English doubles consonants for spelling, never for sound: "yellow" has one l.
  const letters = word
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/([^aeiouy])\1/g, '$1');
  if (!letters) return '';
  let phonemes = '';
  let index = 0;
  while (index < letters.length) {
    const rule = RULES.find((candidate) => {
      if (!letters.startsWith(candidate.letters, index)) return false;
      const after = letters.slice(index + candidate.letters.length);
      if (candidate.after && !candidate.after.test(after)) return false;
      if (candidate.before && !candidate.before.test(letters.slice(0, index))) return false;
      return true;
    });
    if (!rule) {
      index += 1;
      continue;
    }
    phonemes += rule.phonemes;
    index += rule.letters.length;
  }
  return stress(phonemes);
}
