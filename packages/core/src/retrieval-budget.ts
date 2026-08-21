/**
 * Shared retrieval token-budget helpers.
 *
 * One ladder, two consumers: the per-turn indexed-context injector
 * (service/search/project-retrieval.ts) and the model-facing `search` tool's
 * output renderer (packages/mcp). Both shape text that lands in the same
 * context window, so they must agree on what "room" means — a tool response
 * that ignores the ladder can evict the very conversation the injector was
 * budgeting around (measured worst case pre-budget: ~24KB from one `search`
 * call against a 4K-context local model).
 */

/** Rough chars-per-token estimate; deliberately conservative and cheap. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Leave output/tool/history space on small context windows automatically.
 * Values are the per-turn indexed-context ceilings; callers may scale (the
 * `search` tool allows itself 2× — the model explicitly asked for results).
 */
export function contextBudgetCeiling(contextWindow: number | undefined): number {
  if (!contextWindow) return Number.POSITIVE_INFINITY;
  if (contextWindow <= 4_096) return 160;
  if (contextWindow <= 8_192) return 320;
  if (contextWindow <= 16_384) return 700;
  if (contextWindow <= 32_768) return 1_400;
  return 4_000;
}
