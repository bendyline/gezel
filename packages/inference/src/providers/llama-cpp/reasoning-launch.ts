import { parseReasoningBudgetEnv } from '@bendyline/gezel/local-loop';

// The budget parse and the per-request override run inside the shared loop.
export {
  REASONING_CHARS_PER_TOKEN,
  applyLlamaCppReasoningBudgetOverride,
  buildThinkingBudgetCorrective,
  clientThinkingBudgetForRequest,
  estimateReasoningTokens,
  parseReasoningBudgetEnv,
} from '@bendyline/gezel/local-loop';

/** Parse the opt-in llama.cpp reasoning-history preservation switch. */
export function parseReasoningPreserveEnv(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
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
