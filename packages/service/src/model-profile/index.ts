/**
 * Public surface of the model-profile package — every consumer
 * imports from here, never from a deeper path.
 */

export type {
  Behavior,
  ModelCtx,
  NudgeVerdict,
  PromptCtx,
  ResolvedBehaviorEntry,
  ResolvedModelProfile,
  TurnCtx,
} from './types.js';

export { defaultStyleForProvider, TIER_DEFAULT_BEHAVIORS } from './defaults.js';

export {
  listBehaviors,
  lookupBehavior,
  resolveProfile,
  resolveProfileForCatalogId,
} from './registry.js';

export {
  applyTuning,
  ANTHROPIC_TUNING_MAP,
  COPILOT_TUNING_MAP,
  LLAMA_CPP_TUNING_MAP,
  MLX_TUNING_MAP,
  OLLAMA_BODY_TUNING_MAP,
  OLLAMA_OPTIONS_TUNING_MAP,
  OLLAMA_TUNING_MAP,
  OPENAI_TUNING_MAP,
  isReasoningEngaged,
  resolveTuning,
  tuningMapFor,
} from './tuning.js';

export type { ResolveTuningInput, ResolvedTuning, TuningMap, TuningPath } from './tuning.js';
