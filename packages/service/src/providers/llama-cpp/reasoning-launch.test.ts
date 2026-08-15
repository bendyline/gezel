import { describe, expect, it } from 'vitest';
import {
  parseReasoningBudgetEnv,
  parseReasoningPreserveEnv,
  reasoningLaunchOverridesFromEnv,
} from './reasoning-launch.js';

describe('llama.cpp reasoning launch overrides', () => {
  it.each(['1', 'true', ' TRUE '])('enables preservation for %j', (raw) => {
    expect(parseReasoningPreserveEnv(raw)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'yes'])('keeps preservation off for %j', (raw) => {
    expect(parseReasoningPreserveEnv(raw)).toBe(false);
  });

  it('parses a positive integer reasoning budget', () => {
    expect(parseReasoningBudgetEnv(' 4096 ')).toBe(4096);
    expect(parseReasoningBudgetEnv(undefined)).toBeUndefined();
  });

  it.each(['0', '-1', '4k', '1.5', '9007199254740992'])(
    'rejects invalid budget %j instead of falling back to the catalog',
    (raw) => {
      expect(() => parseReasoningBudgetEnv(raw)).toThrow(/reasoning_budget_tokens/i);
    },
  );

  it('reads both experiment levers from one env snapshot', () => {
    expect(
      reasoningLaunchOverridesFromEnv({
        GEZEL_LLAMA_REASONING_PRESERVE: '1',
        GEZEL_LLAMA_REASONING_BUDGET_TOKENS: '8192',
      }),
    ).toEqual({ preserve: true, budgetTokens: 8192 });
  });
});
