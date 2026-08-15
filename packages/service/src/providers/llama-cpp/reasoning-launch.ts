const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Parse the opt-in llama.cpp reasoning-history preservation switch. */
export function parseReasoningPreserveEnv(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Parse the launch-time reasoning-budget override used by controlled evals.
 * Invalid authored values fail loudly instead of silently collapsing an A/B
 * arm back onto the catalog default.
 */
export function parseReasoningBudgetEnv(raw: string | undefined): number | undefined {
  const normalized = raw?.trim();
  if (!normalized) return undefined;
  if (!POSITIVE_INTEGER.test(normalized)) {
    throw new Error('GEZEL_LLAMA_REASONING_BUDGET_TOKENS must be a positive integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('GEZEL_LLAMA_REASONING_BUDGET_TOKENS exceeds the safe integer range');
  }
  return parsed;
}

export function reasoningLaunchOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): {
  preserve: boolean;
  budgetTokens: number | undefined;
} {
  return {
    preserve: parseReasoningPreserveEnv(env.GEZEL_LLAMA_REASONING_PRESERVE),
    budgetTokens: parseReasoningBudgetEnv(env.GEZEL_LLAMA_REASONING_BUDGET_TOKENS),
  };
}
