import { describe, expect, it } from 'vitest';
import { judgePrompt, scoreJudgement, summarize } from './judge.ts';
import { REFERENCE, WASHINGTON_PROMPTS } from './washington.ts';

describe('factuality judge', () => {
  it('grades the answer without its citation markers, against the key alone', () => {
    const prompt = judgePrompt({
      reference: REFERENCE,
      question: 'Q?',
      answer: 'Born in 1732 [1].',
      expects: ['born 1732'],
    });
    expect(prompt).toContain('Born in 1732.');
    expect(prompt).not.toContain('[1]');
    expect(prompt).toContain('- born 1732');
  });

  it('counts only contradictions as errors', () => {
    const score = scoreJudgement({
      claims: [
        { claim: 'born 1732', verdict: 'supported', note: '' },
        { claim: 'a son named Samuel', verdict: 'contradicted', note: 'no children together' },
        { claim: 'liked horses', verdict: 'unverified', note: 'not in key' },
      ],
      expectations: [{ fact: 'born 1732', status: 'stated' }],
      declined: false,
    });
    expect(score).toMatchObject({ claims: 3, contradicted: 1, unverified: 1, expectedStated: 1 });
    expect(summarize([score])).toMatchObject({
      errorRate: 1 / 3,
      repliesWithError: 1,
      coverage: 1,
    });
  });

  it('has a unique id and at least one expected fact per question', () => {
    expect(new Set(WASHINGTON_PROMPTS.map((p) => p.id)).size).toBe(WASHINGTON_PROMPTS.length);
    expect(WASHINGTON_PROMPTS.every((p) => p.expects.length > 0)).toBe(true);
  });
});
