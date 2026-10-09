import { describe, expect, it } from 'vitest';
import { AppChatProgressSchema } from './app-chat.js';

describe('app chat progress', () => {
  const progress = { phase: 'prefill', percent: 37.5, outputTokens: null, tokensPerSecond: null };
  it('accepts measured prefill and nullable counters', () => {
    expect(AppChatProgressSchema.parse(progress)).toEqual(progress);
  });
  it('rejects invented percentages, invalid counts and extra private fields', () => {
    for (const patch of [
      { percent: -1 },
      { percent: 101 },
      { percent: Number.NaN },
      { phase: 'reasoning' },
      { phase: 'unknown' },
      { outputTokens: 1.2 },
      { outputTokens: -1 },
      { tokensPerSecond: Number.POSITIVE_INFINITY },
      { detail: 'private engine data' },
    ])
      expect(AppChatProgressSchema.safeParse({ ...progress, ...patch }).success).toBe(false);
  });
});
