/**
 * Reasoning values accepted by current Codex CLI builds. Individual models
 * expose a subset of these through their model metadata (for example,
 * GPT-5.6 Luna stops at `max`, while Sol and Terra also expose `ultra`).
 */
export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export function isCodexReasoningEffort(value: string | undefined): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.some((effort) => effort === value);
}
