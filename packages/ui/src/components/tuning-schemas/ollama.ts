/**
 * Tuning form schema for the Ollama provider.
 *
 * Knobs: sampling under `options.*`, frequency + presence penalty,
 * repetition_penalty + repeat_last_n, max_tokens (num_predict), seed,
 * `format: 'json'` (and `format: <schema>` on Ollama 0.5+),
 * reasoning via the top-level `think` body field. No DRY/XTC, no
 * grammar, no tool_choice (Ollama is auto-only today).
 */

import {
  FREQUENCY_PENALTY,
  MAX_TOKENS,
  MIN_P,
  OUTPUT_BLOCK_BASE,
  PRESENCE_PENALTY,
  PROMPT_TAGS_BLOCK,
  REASONING_BLOCK_BASE,
  REPETITION_CONTEXT,
  REPETITION_PENALTY,
  SEED,
  TEMPERATURE,
  TOP_K,
  TOP_P,
  samplingWhenThinkingBlock,
} from './shared.js';
import type { LocalSquisqSchema as SquisqAnnotatedSchema } from './types.js';

const OLLAMA_SAMPLING_PROPS: Record<string, SquisqAnnotatedSchema> = {
  temperature: TEMPERATURE,
  topP: TOP_P,
  topK: TOP_K,
  minP: MIN_P,
  maxTokens: MAX_TOKENS,
  seed: SEED,
  repetitionPenalty: REPETITION_PENALTY,
  repetitionContext: REPETITION_CONTEXT,
  frequencyPenalty: FREQUENCY_PENALTY,
  presencePenalty: PRESENCE_PENALTY,
};

const OLLAMA_REASONING: SquisqAnnotatedSchema = {
  ...REASONING_BLOCK_BASE,
  properties: {
    enableThinking: REASONING_BLOCK_BASE.properties!.enableThinking!,
  },
};

const OLLAMA_OUTPUT: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Structured output',
  properties: {
    responseFormat: OUTPUT_BLOCK_BASE.properties!.responseFormat!,
    jsonSchema: {
      type: 'object',
      title: 'JSON Schema',
      description:
        'Pin output to a JSON Schema. Maps to Ollama 0.5+ `format: <schema>`. Leave empty for free-form JSON.',
      additionalProperties: true,
    },
  },
};

export const OLLAMA_TUNING_SCHEMA: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Advanced tuning (Ollama)',
  description:
    'Per-turn sampling, structured output, and reasoning controls. Empty fields fall through to the catalog default.',
  properties: {
    sampling: {
      type: 'object',
      title: 'Sampling',
      properties: OLLAMA_SAMPLING_PROPS,
    },
    samplingWhenThinking: samplingWhenThinkingBlock(OLLAMA_SAMPLING_PROPS),
    reasoning: OLLAMA_REASONING,
    output: OLLAMA_OUTPUT,
    promptTags: PROMPT_TAGS_BLOCK,
  },
};
