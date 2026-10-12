import { createLogger } from '@bendyline/gezel';
import { ANTHROPIC_TUNING_MAP, type ResolvedTuning, applyTuning } from '../model-profile/tuning.js';

const log = createLogger('anthropic');
const LEGACY_EFFORTS = ['low', 'medium', 'high'];
const ADAPTIVE_EFFORTS = [...LEGACY_EFFORTS, 'xhigh', 'max'];
const DEFAULT_MAX_TOKENS = 16384;
/** Room left for the answer when a thinking budget forces max_tokens up; fits Opus 4's 32K output cap. */
const ANSWER_HEADROOM_TOKENS = 8192;
const REASONING_BUDGET_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/**
 * Request contract for models that think adaptively and take
 * `output_config.effort` instead of a token budget. Every one of them rejects
 * `budget_tokens` and non-default sampling.
 * https://platform.claude.com/docs/en/about-claude/models/migration-guide
 */
interface AdaptiveContract {
  defaultEffort: string;
  /**
   * How the model takes "thinking off", and the highest effort it accepts it
   * at. `null` means thinking cannot be turned off at all.
   */
  thinkingOff: { type: 'disabled' | 'between_tools'; maxEffort?: 'high' } | null;
  /** `tool_choice` `any` / `tool` is a 400 on the newest models. */
  forcedToolChoice: boolean;
}

/**
 * First match wins, so a point release precedes its base id. A dated snapshot
 * (`-YYYYMMDD`) shares its family's contract. An id that matches nothing here
 * and is not a legacy budget model gets no thinking or effort fields, which
 * the API answers with that model's own defaults.
 */
const ADAPTIVE_CONTRACTS: ReadonlyArray<readonly [RegExp, AdaptiveContract]> = [
  [
    /^claude-(?:fable|mythos)-5-1(?:-|$)/,
    { defaultEffort: 'high', thinkingOff: null, forcedToolChoice: false },
  ],
  [
    /^claude-(?:fable|mythos)-5(?:-\d{8})?$/,
    { defaultEffort: 'high', thinkingOff: null, forcedToolChoice: true },
  ],
  [
    /^claude-opus-5-5(?:-|$)/,
    { defaultEffort: 'medium', thinkingOff: null, forcedToolChoice: false },
  ],
  [
    /^claude-opus-5(?:-\d{8})?$/,
    {
      defaultEffort: 'high',
      thinkingOff: { type: 'disabled', maxEffort: 'high' },
      forcedToolChoice: true,
    },
  ],
  [
    /^claude-opus-4-[78](?:-|$)/,
    { defaultEffort: 'high', thinkingOff: { type: 'disabled' }, forcedToolChoice: true },
  ],
  [
    /^claude-sonnet-5-5(?:-|$)/,
    {
      defaultEffort: 'high',
      thinkingOff: { type: 'between_tools', maxEffort: 'high' },
      forcedToolChoice: false,
    },
  ],
  [
    /^claude-sonnet-5(?:-\d{8})?$/,
    { defaultEffort: 'high', thinkingOff: { type: 'disabled' }, forcedToolChoice: true },
  ],
  [
    /^claude-haiku-5-5(?:-|$)/,
    {
      defaultEffort: 'medium',
      thinkingOff: { type: 'disabled', maxEffort: 'high' },
      forcedToolChoice: true,
    },
  ],
];

/** Models that still think on a manual `budget_tokens`. */
const LEGACY_BUDGET_PREFIXES = ['claude-opus-4', 'claude-sonnet-4', 'claude-mythos'];

function adaptiveContract(model: string): AdaptiveContract | undefined {
  return ADAPTIVE_CONTRACTS.find(([pattern]) => pattern.test(model))?.[1];
}

function usesLegacyBudget(model: string): boolean {
  return (
    adaptiveContract(model) === undefined &&
    LEGACY_BUDGET_PREFIXES.some((prefix) => model.startsWith(prefix))
  );
}

export function anthropicReasoningEfforts(model: string): string[] | undefined {
  if (adaptiveContract(model)) return [...ADAPTIVE_EFFORTS];
  if (usesLegacyBudget(model)) return [...LEGACY_EFFORTS];
  return undefined;
}

export function anthropicDefaultReasoningEffort(model: string): string | undefined {
  const contract = adaptiveContract(model);
  if (contract) return contract.defaultEffort;
  return usesLegacyBudget(model) ? 'medium' : undefined;
}

/** Model-specific constraints are applied after tuning so older saved settings remain usable. */
export function buildAnthropicGenerationOptions(
  model: string,
  reasoningEffort?: string,
  tuning?: ResolvedTuning,
): Record<string, unknown> {
  const request: Record<string, unknown> = { model, max_tokens: DEFAULT_MAX_TOKENS };
  const contract = adaptiveContract(model);
  if (reasoningEffort && !contract && usesLegacyBudget(model)) {
    request.thinking = {
      type: 'enabled',
      budget_tokens: REASONING_BUDGET_TOKENS[reasoningEffort] ?? REASONING_BUDGET_TOKENS.medium,
    };
  }
  if (tuning) applyTuning(request, tuning, ANTHROPIC_TUNING_MAP);

  if (contract) {
    // Adaptive models reject manual budgets and non-default sampling. Their
    // signed thinking blocks are required even when their visible summaries
    // are empty.
    delete request.temperature;
    delete request.top_p;
    delete request.top_k;
    const effort = tuning?.reasoning.effort ?? reasoningEffort ?? contract.defaultEffort;
    if (!ADAPTIVE_EFFORTS.includes(effort)) {
      throw new Error(`[anthropic] ${model} does not support reasoning effort "${effort}"`);
    }
    request.thinking = { type: 'adaptive', display: 'summarized' };
    if (tuning?.reasoning.enableThinking === false) {
      const off = contract.thinkingOff;
      if (!off) {
        log.warn(`${model} cannot run without thinking; using adaptive thinking`);
      } else if (off.maxEffort && (effort === 'xhigh' || effort === 'max')) {
        throw new Error(`[anthropic] ${model} requires adaptive thinking at ${effort} effort`);
      } else {
        request.thinking = { type: off.type };
      }
    }
    request.output_config = { effort };
  } else {
    const thinking = request.thinking as { type?: string; budget_tokens?: number } | undefined;
    const maxTokens = request.max_tokens;
    // The API rejects a thinking budget that is not below max_tokens, and the
    // `high` budget equals the default cap.
    if (
      thinking?.type === 'enabled' &&
      typeof thinking.budget_tokens === 'number' &&
      typeof maxTokens === 'number' &&
      thinking.budget_tokens >= maxTokens
    ) {
      request.max_tokens = thinking.budget_tokens + ANSWER_HEADROOM_TOKENS;
    }
  }

  if (tuning?.toolChoice) {
    let type: string = tuning.toolChoice === 'required' ? 'any' : tuning.toolChoice;
    if (contract && !contract.forcedToolChoice && type === 'any') {
      log.warn(`${model} does not support forced tool use; using automatic tool selection`);
      type = 'auto';
    }
    request.tool_choice = { type };
  }
  return request;
}
