/**
 * Tuning form schema for the cloud providers (OpenAI, Anthropic).
 * Copilot drops everything but the form still works — most fields are
 * just ignored at request-build time when the provider's tuning map
 * has `null` for that path.
 *
 * Knobs: temperature, top_p, top_k (Anthropic only), max_tokens, seed
 * (OpenAI only), frequency/presence penalty (OpenAI only),
 * response_format + json_schema (OpenAI strict mode), tool_choice,
 * and reasoning effort + thinking budget.
 */

import {
  FREQUENCY_PENALTY,
  MAX_TOKENS,
  OUTPUT_BLOCK_BASE,
  PRESENCE_PENALTY,
  REASONING_BLOCK_BASE,
  SEED,
  TEMPERATURE,
  TOOL_CHOICE,
  TOP_K,
  TOP_P,
  samplingWhenThinkingBlock,
} from './shared.js';
import type { LocalSquisqSchema as SquisqAnnotatedSchema } from './types.js';

const CLOUD_SAMPLING_PROPS: Record<string, SquisqAnnotatedSchema> = {
  temperature: TEMPERATURE,
  topP: TOP_P,
  topK: TOP_K,
  maxTokens: MAX_TOKENS,
  seed: SEED,
  frequencyPenalty: FREQUENCY_PENALTY,
  presencePenalty: PRESENCE_PENALTY,
};

const CLOUD_OUTPUT: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Structured output',
  properties: {
    responseFormat: OUTPUT_BLOCK_BASE.properties!.responseFormat!,
    jsonSchema: {
      type: 'object',
      title: 'JSON Schema',
      description: 'OpenAI strict mode. Leave empty for free-form JSON.',
      additionalProperties: true,
    },
  },
};

export const CLOUD_TUNING_SCHEMA: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Advanced tuning (cloud)',
  description:
    "Per-turn sampling, structured output, and reasoning controls. Empty fields fall through to the catalog default. Fields the active provider doesn't support are silently dropped at request build.",
  properties: {
    sampling: {
      type: 'object',
      title: 'Sampling',
      properties: CLOUD_SAMPLING_PROPS,
    },
    samplingWhenThinking: samplingWhenThinkingBlock(CLOUD_SAMPLING_PROPS),
    reasoning: REASONING_BLOCK_BASE,
    output: CLOUD_OUTPUT,
    toolChoice: TOOL_CHOICE,
  },
};
