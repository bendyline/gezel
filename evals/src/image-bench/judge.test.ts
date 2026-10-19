import { describe, expect, it } from 'vitest';
import { parseJudgeReply, requiredTextPresent } from './judge.ts';
import { IMAGE_BENCH_PROMPTS } from './prompts.ts';

const poster = IMAGE_BENCH_PROMPTS.find((p) => p.id === 'poster')!;
const apple = IMAGE_BENCH_PROMPTS.find((p) => p.id === 'apple')!;

describe('requiredTextPresent', () => {
  it('accepts the words in any case and around punctuation', () => {
    expect(requiredTextPresent(['GARDEN PARTY', 'JUNE 14'], 'Garden Party!\nJune 14, 2026')).toBe(
      true,
    );
    expect(requiredTextPresent(['72°F'], 'Sunny 72°F')).toBe(true);
  });

  it('refuses a misspelling or a merged word', () => {
    expect(requiredTextPresent(['OPEN'], 'OPENN')).toBe(false);
    expect(requiredTextPresent(['GARDEN PARTY'], 'GARDEN PARTTY')).toBe(false);
    expect(requiredTextPresent(['JUNE 14'], 'JUNE 1 4')).toBe(false);
  });
});

describe('parseJudgeReply', () => {
  it('reads JSON inside a code fence and checks the required text', () => {
    const verdict = parseJudgeReply(
      '```json\n{"matches": true, "text": "GARDN PARTY June 14", "defects": ["garbled text"], "score": 3}\n```',
      poster,
    );
    expect(verdict).toEqual({
      matches: true,
      text: 'GARDN PARTY June 14',
      textCorrect: false,
      defects: ['garbled text'],
      score: 3,
    });
  });

  it('leaves textCorrect out when the prompt requires no text, and clamps the score', () => {
    expect(
      parseJudgeReply('{"matches": false, "text": "", "defects": [], "score": 9}', apple),
    ).toEqual({
      matches: false,
      text: '',
      defects: [],
      score: 5,
    });
  });

  it('throws on a reply without JSON', () => {
    expect(() => parseJudgeReply('The image shows an apple.', apple)).toThrow(/no JSON/);
  });
});
