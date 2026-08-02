/** Reasoning effort values accepted by current Claude Code builds. */
export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number];

export function isClaudeReasoningEffort(value: string | undefined): value is ClaudeReasoningEffort {
  return CLAUDE_REASONING_EFFORTS.some((effort) => effort === value);
}
