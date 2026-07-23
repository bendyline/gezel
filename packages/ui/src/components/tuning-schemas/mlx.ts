/**
 * Tuning form schema for the MLX provider (Apple Silicon).
 *
 * Knobs: sampling (temp/top_p/top_k/min_p), repetition_penalty +
 * repetition_context, max_tokens, seed, response_format,
 * tool_choice, and reasoning via chat_template_kwargs.enable_thinking.
 * No frequency/presence penalty (mlx-vlm has only repetition_penalty),
 * no DRY/XTC, no grammar/json_schema, no reasoning.effort (cloud-only).
 */

import {
  MAX_TOKENS,
  MIN_P,
  OUTPUT_BLOCK_BASE,
  PROMPT_TAGS_BLOCK,
  REASONING_BLOCK_BASE,
  REPETITION_CONTEXT,
  REPETITION_PENALTY,
  SEED,
  TEMPERATURE,
  TOOL_CHOICE,
  TOP_K,
  TOP_P,
  samplingWhenThinkingBlock,
} from './shared.js';
import type { LocalSquisqSchema as SquisqAnnotatedSchema } from './types.js';

const MLX_SAMPLING_PROPS: Record<string, SquisqAnnotatedSchema> = {
  temperature: TEMPERATURE,
  topP: TOP_P,
  topK: TOP_K,
  minP: MIN_P,
  maxTokens: MAX_TOKENS,
  seed: SEED,
  repetitionPenalty: REPETITION_PENALTY,
  repetitionContext: REPETITION_CONTEXT,
};

const MLX_REASONING: SquisqAnnotatedSchema = {
  ...REASONING_BLOCK_BASE,
  properties: {
    enableThinking: REASONING_BLOCK_BASE.properties!.enableThinking!,
  },
};

export const MLX_TUNING_SCHEMA: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Advanced tuning (MLX)',
  description:
    'Per-turn sampling and reasoning controls. Empty fields fall through to the catalog default.',
  properties: {
    sampling: {
      type: 'object',
      title: 'Sampling',
      properties: MLX_SAMPLING_PROPS,
    },
    samplingWhenThinking: samplingWhenThinkingBlock(MLX_SAMPLING_PROPS),
    reasoning: MLX_REASONING,
    output: OUTPUT_BLOCK_BASE,
    toolChoice: TOOL_CHOICE,
    promptTags: PROMPT_TAGS_BLOCK,
  },
};
