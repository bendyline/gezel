/**
 * Tuning form schema for the llama.cpp provider.
 *
 * Knobs: full sampling (temp/top_p/top_k/min_p), DRY, XTC, frequency +
 * presence penalty, max_tokens, seed, grammar + json_schema for
 * structured output, tool_choice, and reasoning via
 * chat_template_kwargs.enable_thinking. The grammar field is a free
 * text area (GBNF source); jsonSchema is a JSON value via the
 * sub-editor.
 */

import {
  DRY,
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
  TOOL_CHOICE,
  TOP_K,
  TOP_P,
  XTC,
  samplingWhenThinkingBlock,
} from './shared.js';
import type { LocalSquisqSchema as SquisqAnnotatedSchema } from './types.js';

const LLAMA_CPP_SAMPLING_PROPS: Record<string, SquisqAnnotatedSchema> = {
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
  dry: DRY,
  xtc: XTC,
};

const LLAMA_CPP_REASONING: SquisqAnnotatedSchema = {
  ...REASONING_BLOCK_BASE,
  properties: {
    enableThinking: REASONING_BLOCK_BASE.properties!.enableThinking!,
  },
};

const LLAMA_CPP_OUTPUT: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Structured output',
  properties: {
    responseFormat: OUTPUT_BLOCK_BASE.properties!.responseFormat!,
    jsonSchema: {
      type: 'object',
      title: 'JSON Schema',
      description:
        'Pin output to a JSON Schema. Drives llama `--json-schema`. Leave empty for free-form JSON.',
      additionalProperties: true,
    },
    grammar: {
      type: 'string',
      title: 'GBNF grammar',
      description: 'Last-resort structured-output knob. llama-only. Multi-line GBNF source.',
      maxLength: 4096,
      squisq: { control: 'multiline' },
    },
  },
};

export const LLAMA_CPP_TUNING_SCHEMA: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Advanced tuning (llama)',
  description:
    'Per-turn sampling, structured output, and reasoning controls. Empty fields fall through to the catalog default.',
  properties: {
    sampling: {
      type: 'object',
      title: 'Sampling',
      properties: LLAMA_CPP_SAMPLING_PROPS,
    },
    samplingWhenThinking: samplingWhenThinkingBlock(LLAMA_CPP_SAMPLING_PROPS),
    reasoning: LLAMA_CPP_REASONING,
    output: LLAMA_CPP_OUTPUT,
    toolChoice: TOOL_CHOICE,
    promptTags: PROMPT_TAGS_BLOCK,
  },
};
