/**
 * Grade a reply against the answer key: every specific claim it makes is
 * supported by the key, contradicted by it, or not covered. Only a
 * contradiction counts as an error — the key is not the whole truth, and a
 * claim it does not mention is reported as unverified so a person can look.
 */
import { stripCitations } from '@bendyline/gezel';

export type ClaimVerdict = 'supported' | 'contradicted' | 'unverified';

export interface JudgedClaim {
  claim: string;
  verdict: ClaimVerdict;
  note: string;
}

export interface JudgedExpectation {
  fact: string;
  status: 'stated' | 'wrong' | 'missing';
}

export interface Judgement {
  claims: JudgedClaim[];
  expectations: JudgedExpectation[];
  /** The reply declined, or said it could not verify, instead of answering. */
  declined: boolean;
}

export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims', 'expectations', 'declined'],
  properties: {
    claims: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'verdict', 'note'],
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['supported', 'contradicted', 'unverified'] },
          note: { type: 'string' },
        },
      },
    },
    expectations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'status'],
        properties: {
          fact: { type: 'string' },
          status: { type: 'string', enum: ['stated', 'wrong', 'missing'] },
        },
      },
    },
    declined: { type: 'boolean' },
  },
} as const;

export const JUDGE_SYSTEM =
  'You grade an answer for factual accuracy against an answer key. You are strict and literal. You never use your own knowledge: the key is the only truth you know.';

export function judgePrompt(input: {
  reference: string;
  question: string;
  answer: string;
  expects: string[];
}): string {
  return [
    'ANSWER KEY (the only facts you may trust):',
    input.reference,
    '',
    `QUESTION: ${input.question}`,
    '',
    'ANSWER TO GRADE:',
    stripCitations(input.answer),
    '',
    "TASK 1 — claims. List every specific factual claim in the answer: each name, date, year, age, number, place, and family relationship, one claim per entry, in the answer's own words. Skip opinions and general statements. For each:",
    '- "supported": the key states it, or it follows directly from the key (a stated birth year and death year give the age).',
    '- "contradicted": the key states something incompatible (a different date, a different parent, a child the key says did not exist, a wrong relationship).',
    '- "unverified": the key does not cover it either way.',
    'In "note", quote the key words that support or contradict it, or say "not in key".',
    '',
    'TASK 2 — expectations. For each expected fact below, "stated" if the answer states it correctly, "wrong" if it states it incorrectly, "missing" if it does not state it:',
    ...input.expects.map((e) => `- ${e}`),
    '',
    'TASK 3 — "declined": true only if the answer refuses or says it cannot verify the facts instead of answering.',
  ].join('\n');
}

export interface ReplyScore {
  claims: number;
  supported: number;
  contradicted: number;
  unverified: number;
  expectedStated: number;
  expectedWrong: number;
  expectedTotal: number;
  declined: boolean;
}

export function scoreJudgement(j: Judgement): ReplyScore {
  const count = (v: ClaimVerdict) => j.claims.filter((c) => c.verdict === v).length;
  return {
    claims: j.claims.length,
    supported: count('supported'),
    contradicted: count('contradicted'),
    unverified: count('unverified'),
    expectedStated: j.expectations.filter((e) => e.status === 'stated').length,
    expectedWrong: j.expectations.filter((e) => e.status === 'wrong').length,
    expectedTotal: j.expectations.length,
    declined: j.declined,
  };
}

export function summarize(scores: readonly ReplyScore[]) {
  const sum = (k: keyof Omit<ReplyScore, 'declined'>) => scores.reduce((a, s) => a + s[k], 0);
  const claims = sum('claims');
  const expected = sum('expectedTotal');
  return {
    replies: scores.length,
    claims,
    contradicted: sum('contradicted'),
    errorRate: claims ? sum('contradicted') / claims : 0,
    unverifiedRate: claims ? sum('unverified') / claims : 0,
    repliesWithError: scores.filter((s) => s.contradicted > 0).length,
    coverage: expected ? sum('expectedStated') / expected : 0,
    declined: scores.filter((s) => s.declined).length,
  };
}
