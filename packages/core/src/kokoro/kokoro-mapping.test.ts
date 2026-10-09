import { describe, expect, it } from 'vitest';
import { parseKokoroLexicon } from './lexicon.js';
import { normalizeForSpeech, normalizeForSpeechWithMapping } from './normalize.js';
import { phonemizeForKokoro } from './phonemize.js';
import { planKokoroSpeech } from './plan.js';
import { tokenizeKokoroPhonemes } from './tokenize.js';

const lexicon = parseKokoroLexicon('cat k æ t\ndog d ɑ ɡ\nhello h ə l oʊ\nworld w ɜ ɹ l d');

describe('Kokoro source mappings', () => {
  it('retains UTF-16 ranges through Unicode normalization and spoken expansions', () => {
    const source = '  Cafe\u0301 👋 costs $3.50 & 25%. Dr. Cat is 21st. ';
    const mapped = normalizeForSpeechWithMapping(source);
    expect(mapped.text).toBe(normalizeForSpeech(source));
    expect(mapped.text).toContain(
      'Café 👋 costs three dollars fifty cents and twenty five percent . doctor Cat is twenty first.',
    );
    for (const [spoken, original] of [
      ['é', 'e\u0301'],
      ['three dollars fifty cents', '$3.50'],
      ['doctor', 'Dr.'],
      ['twenty first', '21st'],
      ['percent', '%'],
    ]) {
      const start = mapped.text.indexOf(spoken!);
      expect(start).toBeGreaterThanOrEqual(0);
      const range = mapped.range(start, start + spoken!.length);
      expect(source.slice(range.textStart, range.textEnd)).toBe(original);
    }
  });

  it('preserves the padded model input and maps repeated and expanded words without search', () => {
    const source = 'Cat, cat! $3.50 🦊 dog.';
    const [chunk] = planKokoroSpeech(source, { lexicon });
    expect(chunk!.phonemes).toBe(phonemizeForKokoro(source, { lexicon }));
    expect(chunk!.tokens).toEqual(tokenizeKokoroPhonemes(chunk!.phonemes).tokens);
    const words = chunk!.words.map((word) => source.slice(word.textStart, word.textEnd));
    expect(words).toEqual(['Cat', 'cat', '$3.50', '$3.50', '$3.50', '$3.50', 'dog']);
    expect(chunk!.words[0]!.textStart).toBe(0);
    expect(chunk!.words[1]!.textStart).toBe(5);
    for (const word of chunk!.words) {
      expect(word.tokenStart).toBeGreaterThan(0);
      expect(word.tokenEnd).toBeLessThan(chunk!.tokens.length);
      expect(word.tokenEnd).toBeGreaterThan(word.tokenStart);
    }
  });

  it('splits long sentences with distinct source ranges and retains an overlong word', () => {
    const source = Array.from({ length: 500 }, () => 'cat dog').join(' ');
    const chunks = planKokoroSpeech(source, { lexicon });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.flatMap((chunk) => chunk.words)).toHaveLength(1000);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.tokens.length).toBeLessThanOrEqual(511);
      if (i) expect(chunks[i]!.textStart).toBeGreaterThan(chunks[i - 1]!.textEnd);
    }
    const hugeLexicon = parseKokoroLexicon(`enormous ${'k '.repeat(1200).trim()}`);
    const huge = planKokoroSpeech('enormous', { lexicon: hugeLexicon });
    expect(huge.reduce((sum, chunk) => sum + chunk.tokens.length - 2, 0)).toBe(1200);
    expect(
      huge
        .flatMap((chunk) => chunk.words)
        .every((word) => word.textStart === 0 && word.textEnd === 8),
    ).toBe(true);
  });

  it('drops unsupported symbols without shifting word token indices', () => {
    const unusual = parseKokoroLexicon('cat k 🦊 æ t');
    const [chunk] = planKokoroSpeech('🦊 cat.', { lexicon: unusual });
    expect(chunk!.tokens.length).toBe(6);
    expect(chunk!.words).toEqual([{ textStart: 3, textEnd: 6, tokenStart: 1, tokenEnd: 4 }]);
    expect(planKokoroSpeech('🦊', { lexicon })).toEqual([]);
  });
  it('preserves Han dictionary word boundaries without changing phonemes', () => {
    const hanLexicon = parseKokoroLexicon('你好 n i\n世界 s ɜ');
    const [chunk] = planKokoroSpeech('你好世界', { lexicon, hanLexicon });
    expect(chunk!.phonemes).toBe('ni sɜ');
    expect(chunk!.words.map(({ textStart, textEnd }) => [textStart, textEnd])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});
