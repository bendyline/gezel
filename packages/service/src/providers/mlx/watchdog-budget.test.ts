import { describe, expect, it } from 'vitest';
import { computePreFirstByteBudgetMs, estimatePromptTokens } from './provider.js';

// The qwen3.6-27b voorman stall: a 37K-token prompt produced no first token
// in the old flat 300s pre-first-byte budget and aborted at 343s. These guard
// the size-scaled budget that replaced the flat value.
describe('computePreFirstByteBudgetMs', () => {
  it('floors at 300s for small prompts (never tighter than the prior flat value)', () => {
    expect(computePreFirstByteBudgetMs(0)).toBe(300_000);
    expect(computePreFirstByteBudgetMs(2_000)).toBe(300_000);
    expect(computePreFirstByteBudgetMs(8_000)).toBe(300_000); // baseline — no growth yet
  });

  it('grows past the 8K baseline so a big-context turn gets real headroom', () => {
    // 37K tokens ≈ the repro. 300s + (37-8)*12s = 648s — comfortably past the
    // 343s the engine was still grinding at when the flat budget killed it.
    expect(computePreFirstByteBudgetMs(37_000)).toBe(648_000);
    expect(computePreFirstByteBudgetMs(37_000)).toBeGreaterThan(343_000);
    // Monotonic in prompt size.
    expect(computePreFirstByteBudgetMs(20_000)).toBeGreaterThan(
      computePreFirstByteBudgetMs(10_000),
    );
  });

  it('caps at 15 min so a pathological prompt still bounds under the 30-min hard deadline', () => {
    expect(computePreFirstByteBudgetMs(1_000_000)).toBe(900_000);
  });
});

describe('estimatePromptTokens', () => {
  it('counts the tool schemas, not just the messages (they dominate for coordinators)', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const withoutTools = estimatePromptTokens(messages, undefined);
    const withTools = estimatePromptTokens(messages, [
      { type: 'function', function: { name: 'x', description: 'y'.repeat(4_000) } },
    ]);
    // The ~4K-char tool description should add ~1K tokens to the estimate.
    expect(withTools).toBeGreaterThan(withoutTools + 800);
  });

  it('survives unstringifiable input without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => estimatePromptTokens(circular, undefined)).not.toThrow();
    expect(estimatePromptTokens(circular, undefined)).toBe(0);
  });
});
