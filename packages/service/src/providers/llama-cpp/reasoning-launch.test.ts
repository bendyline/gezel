import { describe, expect, it } from 'vitest';
import {
  applyLlamaCppReasoningBudgetOverride,
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

describe('llama.cpp reasoning request budget override', () => {
  it('keeps a resolved request budget when the experiment override is absent', () => {
    const body = { reasoning_budget_tokens: 2048 };
    applyLlamaCppReasoningBudgetOverride(body, true, '');
    expect(body.reasoning_budget_tokens).toBe(2048);
  });

  it('applies the validated experiment override over a resolved request budget', () => {
    const body = { reasoning_budget_tokens: 96 };
    applyLlamaCppReasoningBudgetOverride(body, true, ' 4096 ');
    expect(body.reasoning_budget_tokens).toBe(4096);
  });

  it('rejects an invalid experiment override instead of silently using the request budget', () => {
    expect(() => applyLlamaCppReasoningBudgetOverride({}, true, '4k')).toThrow(
      /reasoning_budget_tokens/i,
    );
  });

  it('removes llama-specific request budgets for DS4 without reading the llama experiment setting', () => {
    const body = { reasoning_budget_tokens: 2048, max_tokens: 8192 };
    applyLlamaCppReasoningBudgetOverride(body, false, '4k');
    expect(body).toEqual({ max_tokens: 8192 });
  });
});
