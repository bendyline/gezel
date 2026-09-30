const POSITIVE_INTEGER = /^[1-9]\d*$/;

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

/**
 * Keep launch-time experiment overrides authoritative on request budgets too.
 *
 * Returns the resolved budget the engine cannot enforce itself, so the turn
 * loop can enforce it client-side (see {@link clientThinkingBudgetForRequest});
 * `undefined` when the engine enforces its own budget or none was resolved.
 */
export function applyLlamaCppReasoningBudgetOverride(
  body: Record<string, unknown>,
  supportsReasoningBudget: boolean,
  rawBudget: string | undefined,
): number | undefined {
  // DS4 shares the llama.cpp turn loop but does not accept this budget field.
  if (!supportsReasoningBudget) {
    const unenforced = body.reasoning_budget_tokens;
    delete body.reasoning_budget_tokens;
    return typeof unenforced === 'number' && Number.isSafeInteger(unenforced) && unenforced > 0
      ? unenforced
      : undefined;
  }
  const budgetTokens = parseReasoningBudgetEnv(rawBudget);
  if (budgetTokens !== undefined) body.reasoning_budget_tokens = budgetTokens;
  return undefined;
}

/**
 * Streamed reasoning chars per token, for engines that report no live decode
 * count (ds4-server sends usage only at the end of the stream). Measured on
 * deepseek-v4-flash-284b-q2 in the 2026-09-29 sweep: a 16,384-token
 * reasoning-only turn streamed 65,384 chars of `reasoning_content` (3.99).
 */
export const REASONING_CHARS_PER_TOKEN = 4;

function thinkingDisabledOnRequest(body: Record<string, unknown>): boolean {
  const kwargs = body.chat_template_kwargs;
  if (
    kwargs &&
    typeof kwargs === 'object' &&
    !Array.isArray(kwargs) &&
    (kwargs as Record<string, unknown>).enable_thinking === false
  ) {
    return true;
  }
  if (body.think === false) return true;
  const thinking = body.thinking;
  return (
    !!thinking &&
    typeof thinking === 'object' &&
    (thinking as Record<string, unknown>).type === 'disabled'
  );
}

/**
 * The thinking budget the turn loop must enforce for this exact request, or
 * null when there is nothing to enforce: the engine honors its own budget,
 * none was resolved, or the request already runs with thinking off (a
 * constrained turn, or the retry this enforcement issues — which is what keeps
 * that retry from re-triggering it).
 */
export function clientThinkingBudgetForRequest(
  body: Record<string, unknown>,
  unenforcedBudget: number | undefined,
): number | null {
  if (unenforcedBudget === undefined) return null;
  return thinkingDisabledOnRequest(body) ? null : unenforcedBudget;
}

/** Prefer the engine's live decode count; fall back to the char estimate. */
export function estimateReasoningTokens(
  reasoningChars: number,
  engineDecodedTokens?: number,
): number {
  if (typeof engineDecodedTokens === 'number' && engineDecodedTokens > 0) {
    return engineDecodedTokens;
  }
  return Math.ceil(reasoningChars / REASONING_CHARS_PER_TOKEN);
}

/** User-channel corrective for the thinking-off retry. */
export function buildThinkingBudgetCorrective(hasTools: boolean): string {
  return hasTools
    ? '[runtime] Your thinking ran past its budget and was cut off. Thinking is off for this reply. Do not plan again: make your next tool call now, or give your answer if the work is done.'
    : '[runtime] Your thinking ran past its budget and was cut off. Thinking is off for this reply. Do not plan again: give your answer now.';
}
