import { describe, expect, it } from 'vitest';
import {
  kokoroTokenFor,
  parseKokoroLexicon,
  phonemizeForKokoro,
  planKokoroSpeech,
  soundOutWord,
} from './index.js';
import { KOKORO_SENSES_GB, KOKORO_SENSES_US, KOKORO_SPELLED_CAPITALS } from './senses-data.js';

// Entries copied from the pinned American dictionary. The readings that depend
// on a word's use come from the built-in sense table, not from here.
const AMERICAN = [
  'a A',
  'about ə b ˈ W t',
  'am æ m',
  'an æ n',
  'apple ˈ æ p ᵊ l',
  'can k æ n',
  'case k ˈ A s',
  'content k ə n t ˈ ɛ n t',
  'contents k ə n t ˈ ɛ n t s',
  'd d ˈ i',
  'deck d ˈ ɛ k',
  'f ˈ ɛ f',
  'have h æ v',
  'here h ˈ ɪ ɹ',
  'i ˈ I',
  'in ɪ n',
  'it ɪ t',
  'jason ʤ ˈ A s ᵊ n',
  'live l ˈ I v',
  'm ˈ ɛ m',
  'mac m ˈ æ k',
  'n ˈ ɛ n',
  'nasa n ˈ æ s ə',
  'o ˈ O',
  'of ʌ v',
  'p p ˈ i',
  'present p ɹ ˈ ɛ z ᵊ n t',
  'read ɹ ˈ i d',
  's ˈ ɛ s',
  'table t ˈ A b ᵊ l',
  't t ˈ i',
  'team t ˈ i m',
  'the ð i',
  'to t u',
  'u j ˈ u',
  'us ˌ ʌ s',
  'use j ˈ u z',
  'used j ˈ u z d',
  'we w i',
  'x ˈ ɛ k s',
  'yes j ˈ ɛ s',
].join('\n');

const lexicon = parseKokoroLexicon(AMERICAN, { language: 'us' });
const say = (text: string) => phonemizeForKokoro(text, { lexicon });

describe('readings chosen by the neighbouring words', () => {
  it('reads a verb after a subject or "to" and a noun after a determiner', () => {
    expect(say('We present the deck.')).toBe('wi pɹizˈɛnt ðə dˈɛk.');
    expect(say('to present')).toBe('tə pɹizˈɛnt');
    expect(say('the present')).toBe('ðə pɹˈɛzᵊnt');
  });

  it('reads "content" as the noun unless something describes with it', () => {
    expect(say('the content')).toBe('ðə kˈɑntɛnt');
    expect(say('table of contents')).toBe('tˈAbᵊl ʌv kˈɑntɛnts');
    expect(say('I am content')).toBe('ˌI ɐm kəntˈɛnt');
  });

  it('reads tense and participles from their auxiliaries', () => {
    expect(say('we live here')).toBe('wi lˈɪv hˈɪɹ');
    expect(say('we have read it')).toBe('wi hæv ɹˈɛd ɪt');
    expect(say('we read it')).toBe('wi ɹˈid ɪt');
  });

  it('tells the habit "used to" from the passive', () => {
    expect(say('we used to')).toBe('wi jˈust tu');
    expect(say('it is used to')).not.toContain('jˈust');
    expect(say('the use case')).toBe('ðə jˈus kˈAs');
  });

  it('stresses a function word that ends a phrase', () => {
    expect(say('Yes, we can.')).toBe('jˈɛs, wi kˈæn.');
    expect(say('we can present')).toBe('wi kæn pɹizˈɛnt');
  });

  it('keeps one reading per word without a language', () => {
    const plain = parseKokoroLexicon(AMERICAN);
    expect(phonemizeForKokoro('we present', { lexicon: plain })).toBe('wi pɹˈɛzᵊnt');
  });
});

describe('reduced function words', () => {
  it('says "the" and "to" by the sound that follows', () => {
    expect(say('the team')).toBe('ðə tˈim');
    expect(say('the apple')).toBe('ði ˈæpᵊl');
    expect(say('to the apple')).toBe('tə ði ˈæpᵊl');
    expect(say('to apple')).toBe('tʊ ˈæpᵊl');
  });

  it('reduces articles and keeps a lone letter A stressed', () => {
    expect(say('a deck')).toBe('ɐ dˈɛk');
    expect(say('an apple')).toBe('ɐn ˈæpᵊl');
    expect(say('A deck')).toBe('ɐ dˈɛk');
    expect(say('deck A')).toBe('dˈɛk ˈA');
  });

  it('stresses "in" only at the end of a phrase', () => {
    expect(say('in the deck')).toBe('ɪn ðə dˈɛk');
    expect(say('deck in.')).toBe('dˈɛk ˈɪn.');
  });
});

describe('abbreviations', () => {
  it('spells capitals the dictionary does not know, stressing the last letter', () => {
    expect(say('PDF')).toBe('pˌidˌiˈɛf');
    expect(say('UX')).toBe('jˌuˈɛks');
    expect(say('PDFs')).toBe('pˌidˌiˈɛfs');
  });

  it('reads known capitals as words, unless they name something', () => {
    expect(say('NASA')).toBe('nˈæsə');
    expect(say('the US')).toBe('ðə jˌuˈɛs');
    expect(say('ABOUT US')).toBe('əbˈWt ˌʌs');
  });

  it('spells words with no vowel and reads mixed-case names by their parts', () => {
    expect(say('npm')).toBe('ˌɛnpˌiˈɛm');
    expect(say('macOS')).toBe('mˈækˌOˈɛs');
  });

  it('says acronyms read as words', () => {
    expect(say('JSON')).toBe('ʤˈAsᵊn');
    expect(say('YAML')).toBe(soundOutWord('yaml'));
  });

  it('maps a spelled word back to its source text', () => {
    const [chunk] = planKokoroSpeech('A PDF.', { lexicon });
    const words = chunk!.words.map((word) => 'A PDF.'.slice(word.textStart, word.textEnd));
    expect(words).toEqual(['A', 'PDF']);
  });

  it('falls back to letter-to-sound when the dictionary has no letter names', () => {
    const tiny = parseKokoroLexicon('deck d ˈ ɛ k');
    const phonemes = phonemizeForKokoro('PDF', { lexicon: tiny });
    expect(phonemes.length).toBeGreaterThan(0);
  });
});

describe('sense data', () => {
  it('uses only symbols the model knows', () => {
    for (const table of [KOKORO_SENSES_US, KOKORO_SENSES_GB]) {
      for (const line of table.split('\n').filter(Boolean)) {
        const [word, ...pairs] = line.split(' ');
        expect(pairs.length, word).toBeGreaterThan(0);
        for (const pair of pairs) {
          const [sense, phonemes] = pair.split('=') as [string, string];
          expect(['NOUN', 'VERB', 'ADJ', 'ADV', 'VBD', 'VBN', 'FINAL', 'DEFAULT']).toContain(sense);
          for (const symbol of phonemes)
            expect(kokoroTokenFor(symbol), `${word} ${pair}`).toBeDefined();
        }
      }
    }
  });

  it('lists spelled capitals as plain capital letters', () => {
    for (const word of KOKORO_SPELLED_CAPITALS.split(/\s+/).filter(Boolean))
      expect(word).toMatch(/^[A-Z]{2,}$/);
  });
});
