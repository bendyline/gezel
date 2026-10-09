import { createLogger } from '@bendyline/gezel';
import { ANTHROPIC_TUNING_MAP, type ResolvedTuning, applyTuning } from '../model-profile/tuning.js';

const log = createLogger('anthropic');
const LEGACY_EFFORTS = ['low', 'medium', 'high'];
const SONNET_5_EFFORTS = [...LEGACY_EFFORTS, 'xhigh', 'max'];
const REASONING_BUDGET_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

function isSonnet5(model: string): boolean {
  return model === 'claude-sonnet-5' || isSonnet55(model);
}

function isSonnet55(model: string): boolean {
  return /^claude-sonnet-5-5(?:-|$)/.test(model);
}

export function anthropicReasoningEfforts(model: string): string[] | undefined {
  if (isSonnet5(model)) return [...SONNET_5_EFFORTS];
  if (['claude-opus-4', 'claude-sonnet-4', 'claude-mythos'].some((p) => model.startsWith(p))) {
    return [...LEGACY_EFFORTS];
  }
  return undefined;
}

export function anthropicDefaultReasoningEffort(model: string): string | undefined {
  if (isSonnet5(model)) return 'high';
  return anthropicReasoningEfforts(model) ? 'medium' : undefined;
}

/** Model-specific constraints are applied after tuning so older saved settings remain usable. */
export function buildAnthropicGenerationOptions(
  model: string,
  reasoningEffort?: string,
  tuning?: ResolvedTuning,
): Record<string, unknown> {
  const request: Record<string, unknown> = { model, max_tokens: 16384 };
  if (reasoningEffort && anthropicReasoningEfforts(model) && !isSonnet5(model)) {
    request.thinking = {
      type: 'enabled',
      budget_tokens: REASONING_BUDGET_TOKENS[reasoningEffort] ?? REASONING_BUDGET_TOKENS.medium,
    };
  }
  if (tuning) applyTuning(request, tuning, ANTHROPIC_TUNING_MAP);

  if (isSonnet5(model)) {
    // Sonnet 5.x rejects manual budgets and non-default sampling. Its signed
    // thinking blocks are required even when their visible summaries are empty.
    // https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
    delete request.temperature;
    delete request.top_p;
    delete request.top_k;
    const effort = tuning?.reasoning.effort ?? reasoningEffort ?? 'high';
    if (!anthropicReasoningEfforts(model)?.includes(effort)) {
      throw new Error(`[anthropic] ${model} does not support reasoning effort "${effort}"`);
    }
    const disabled = tuning?.reasoning.enableThinking === false;
    if (disabled && isSonnet55(model) && (effort === 'xhigh' || effort === 'max')) {
      throw new Error(`[anthropic] ${model} requires adaptive thinking at ${effort} effort`);
    }
    request.thinking = disabled
      ? { type: isSonnet55(model) ? 'between_tools' : 'disabled' }
      : { type: 'adaptive', display: 'summarized' };
    request.output_config = { effort };
  }

  if (tuning?.toolChoice) {
    let type: string = tuning.toolChoice === 'required' ? 'any' : tuning.toolChoice;
    if (isSonnet55(model) && type === 'any') {
      log.warn(`${model} does not support forced tool use; using automatic tool selection`);
      type = 'auto';
    }
    request.tool_choice = { type };
  }
  return request;
}
