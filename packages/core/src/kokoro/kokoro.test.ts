import { describe, expect, it } from 'vitest';
import {
  KOKORO_MAX_PHONEMES,
  KOKORO_PAD_TOKEN,
  kokoroTokenFor,
  normalizeForSpeech,
  parseKokoroLexicon,
  phonemizeForKokoro,
  soundOutWord,
  spellNumber,
  spellOrdinal,
  splitForKokoro,
  tokenizeKokoroPhonemes,
} from './index.js';

// The voice pack's own format: a word, then its phoneme symbols, space separated.
const lexicon = parseKokoroLexicon(
  [
    'kokoro k ˈ O k ə ɹ O',
    'gezel ɡ ə z ˈ ɛ l',
    'work w ˈ ɜ ɹ k',
    'flow f l ˈ O',
    'cat k ˈ æ t',
    'dog d ˈ ɔ ɡ',
    'watch w ˈ ɑ ʧ',
    'bake b ˈ A k',
    'hello h ə l ˈ O',
  ].join('\n'),
);

describe('kokoro vocabulary', () => {
  it('matches the ids the model was published with', () => {
    expect(kokoroTokenFor('$')).toBe(KOKORO_PAD_TOKEN);
    expect(kokoroTokenFor('A')).toBe(24);
    expect(kokoroTokenFor('ˈ')).toBe(156);
    expect(kokoroTokenFor('ɾ')).toBe(125);
  });

  it('has no symbol for characters the model never saw', () => {
    // Kokoro spells /g/ with the IPA script g, so ASCII 'g' is not a symbol.
    expect(kokoroTokenFor('g')).toBeUndefined();
    expect(kokoroTokenFor('7')).toBeUndefined();
    expect(kokoroTokenFor('#')).toBeUndefined();
    expect(kokoroTokenFor(String.fromCharCode(0))).toBeUndefined();
  });
});

describe('lexicon', () => {
  it('reads the voice-pack format', () => {
    expect(lexicon.size).toBe(9);
    expect(lexicon.lookup('kokoro')).toBe('kˈOkəɹO');
    expect(lexicon.lookup('KOKORO')).toBe('kˈOkəɹO');
  });

  it('rebuilds regular inflections from a known stem', () => {
    expect(lexicon.lookup('cats')).toBe('kˈæts'); // voiceless stem takes /s/
    expect(lexicon.lookup('dogs')).toBe('dˈɔɡz'); // voiced stem takes /z/
    expect(lexicon.lookup('watches')).toBe('wˈɑʧᵻz'); // sibilant stem takes a syllable
    expect(lexicon.lookup('worked')).toBe('wˈɜɹkt'); // voiceless stem takes /t/
    expect(lexicon.lookup('working')).toBe('wˈɜɹkɪŋ');
    expect(lexicon.lookup('baking')).toBe('bˈAkɪŋ'); // silent e is dropped
  });

  it('handles possessives and compounds', () => {
    expect(lexicon.lookup("cat's")).toBe('kˈæts');
    expect(lexicon.lookup('work-flow')).toBe('wˈɜɹkflˈO');
  });

  it('reports a miss rather than guessing', () => {
    expect(lexicon.lookup('zzzz')).toBeUndefined();
  });
});

describe('normalisation', () => {
  it('spells numbers the way they are read', () => {
    expect(spellNumber(0)).toBe('zero');
    expect(spellNumber(21)).toBe('twenty one');
    expect(spellNumber(1250)).toBe('one thousand two hundred fifty');
    expect(spellOrdinal(3)).toBe('third');
    expect(spellOrdinal(20)).toBe('twentieth');
  });

  it('expands money, years and symbols', () => {
    expect(normalizeForSpeech('$3.50')).toBe('three dollars fifty cents');
    expect(normalizeForSpeech('in 1984')).toBe('in nineteen eighty four');
    expect(normalizeForSpeech('100% & up')).toBe('one hundred percent and up');
  });
});

describe('phonemize', () => {
  it('prefers the dictionary', () => {
    expect(phonemizeForKokoro('kokoro', { lexicon })).toBe('kˈOkəɹO');
  });

  it('keeps punctuation the model understands and drops the rest', () => {
    expect(phonemizeForKokoro('cat, dog.', { lexicon })).toBe('kˈæt, dˈɔɡ.');
    expect(phonemizeForKokoro('cat ^ dog', { lexicon })).toBe('kˈæt dˈɔɡ');
  });

  it('splits a coinage into known words before sounding it out', () => {
    expect(phonemizeForKokoro('workflow', { lexicon })).toBe('wˈɜɹkflˈO');
  });

  it('falls back to letter-to-sound for an unknown word', () => {
    const phonemes = phonemizeForKokoro('zzzq', { lexicon });
    expect(phonemes.length).toBeGreaterThan(0);
    for (const symbol of phonemes) expect(kokoroTokenFor(symbol)).toBeDefined();
  });

  it('never emits a symbol the model lacks', () => {
    const text = 'Pay $3.50 for 12 cats — hello, world! (really?)';
    for (const symbol of phonemizeForKokoro(text, { lexicon }))
      expect(kokoroTokenFor(symbol)).toBeDefined();
  });
});

describe('letter to sound', () => {
  it('reads common spellings', () => {
    expect(soundOutWord('phone')).toBe('fˈOn');
    expect(soundOutWord('knight')).toBe('nˈIt');
    expect(soundOutWord('church')).toBe('ʧˈɜɹʧ');
    expect(soundOutWord('yellow')).toBe('jˈɛlO');
  });

  it('returns nothing for a word with no letters', () => {
    expect(soundOutWord('123')).toBe('');
  });

  it('spells /g/ with the script g the model knows, never ASCII g', () => {
    const phonemes = soundOutWord('goggle');
    expect(phonemes).toContain('\u0261');
    expect(phonemes).not.toContain('g');
    for (const symbol of phonemes) expect(kokoroTokenFor(symbol)).toBeDefined();
  });
});

describe('tokenize', () => {
  it('pads the run the way Kokoro expects', () => {
    const { tokens, phonemeCount, truncated } = tokenizeKokoroPhonemes('kˈæt');
    expect(tokens.at(0)).toBe(KOKORO_PAD_TOKEN);
    expect(tokens.at(-1)).toBe(KOKORO_PAD_TOKEN);
    expect(phonemeCount).toBe(4);
    expect(tokens).toHaveLength(6);
    expect(truncated).toBe(false);
  });

  it('drops symbols the model lacks instead of guessing', () => {
    expect(tokenizeKokoroPhonemes('k#g7\u0261').phonemeCount).toBe(2);
  });

  it('truncates beyond the longest style vector', () => {
    const { tokens, phonemeCount, truncated } = tokenizeKokoroPhonemes('a'.repeat(600));
    expect(phonemeCount).toBe(KOKORO_MAX_PHONEMES);
    expect(truncated).toBe(true);
    // The runtime indexes 510 style vectors by phoneme count and requires the
    // count to stay below that, so the padded run must not reach it.
    expect(tokens.length - 2).toBeLessThan(510);
  });
});

describe('splitting long text', () => {
  it('keeps short text whole', () => {
    expect(splitForKokoro('kˈæt')).toEqual(['kˈæt']);
  });

  it('breaks at sentence ends and keeps every piece within the limit', () => {
    const sentence = `${'a'.repeat(40)}. `;
    const pieces = splitForKokoro(sentence.repeat(20).trim(), 100);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect([...piece].length).toBeLessThanOrEqual(100);
  });
});
