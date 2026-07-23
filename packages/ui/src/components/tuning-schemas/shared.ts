/**
 * Squisq-annotated JSON Schema fragments shared across the four
 * provider-scoped tuning schemas. Each scope picks the subset it
 * supports.
 *
 * Descriptions are written for the user, not the engineer. Each field
 * explains what changes in the conversation when you move the knob —
 * not the math behind it.
 */

import type { LocalSquisqSchema as SquisqAnnotatedSchema } from './types.js';

export const TEMPERATURE: SquisqAnnotatedSchema = {
  type: 'number',
  title: 'Temperature',
  description:
    'How adventurous the model is when picking words. Low values (0–0.3) make replies steady and repeatable — good for code, math, structured output. Mid values (0.5–0.9) feel like a thoughtful conversation. High values (1.0+) get creative but can drift off-topic or start rambling. 0 picks the single most likely word every time.',
  minimum: 0,
  maximum: 2,
  multipleOf: 0.05,
};

export const TOP_P: SquisqAnnotatedSchema = {
  type: 'number',
  title: 'top_p (nucleus)',
  description:
    'Trims the long tail of unlikely word choices. 0.95 keeps the model honest while letting it surprise you — the modern default. Lower values (0.7–0.85) make replies more predictable and stay in the safe zone. Higher values (close to 1) let weirder picks through. Usually tune temperature first, top_p second.',
  minimum: 0,
  maximum: 1,
  multipleOf: 0.01,
};

export const TOP_K: SquisqAnnotatedSchema = {
  type: 'integer',
  title: 'top_k',
  description:
    "A hard ceiling on how many word choices the model considers at each step. 20 is what Qwen recommends for thinking mode. 64 is Gemma's default. 1 means 'always pick the single most likely word' — deterministic but flat. Lower top_k = more predictable; higher = more variety.",
  minimum: 0,
  maximum: 1000,
};

export const MIN_P: SquisqAnnotatedSchema = {
  type: 'number',
  title: 'min_p',
  description:
    'A floor on word probability — filters out the really unlikely tokens regardless of top_k. 0 disables. 0.05 is a mild filter that prevents the model from grabbing genuinely rare tokens. Most users leave this at 0 and tune temperature + top_p instead.',
  minimum: 0,
  maximum: 1,
  multipleOf: 0.01,
};

export const MAX_TOKENS: SquisqAnnotatedSchema = {
  type: 'integer',
  title: 'Max reply length (tokens)',
  description:
    "Hard ceiling on how long one reply can be. Counts every word, punctuation mark, and reasoning token. Most chat turns fit in 2k–8k. Reasoning models that 'think out loud' need 16k+ to leave room for the actual answer after the thinking trace. Hitting this cap mid-reply cuts the model off.",
  minimum: 1,
  maximum: 131072,
};

export const SEED: SquisqAnnotatedSchema = {
  type: 'integer',
  title: 'Seed',
  description:
    'Lock in a specific run. Same seed + same prompt = (usually) the same reply, so you can A/B test prompt changes or reproduce a bug. Leave blank for random. Cloud providers honor seed on a best-effort basis; local engines are stricter.',
};

export const REPETITION_PENALTY: SquisqAnnotatedSchema = {
  type: 'number',
  title: 'Repetition penalty',
  description:
    "Punishes the model for re-using words it just said. 1.0 = off (the model is allowed to repeat freely). 1.1 = mild — catches 'I will… I'll… I will…' loops. Push above 1.2 and the model starts dodging legitimate repeats (the word 'the' starts feeling rare), and replies feel oddly stilted.",
  minimum: 0,
  maximum: 3,
  multipleOf: 0.05,
};

export const REPETITION_CONTEXT: SquisqAnnotatedSchema = {
  type: 'integer',
  title: 'Repetition window (tokens)',
  description:
    'How far back the repetition penalty looks. 20–64 catches recent loops without affecting older context. Larger windows (256+) penalize re-using words from much earlier in the chat — usually too aggressive for conversation.',
  minimum: 1,
  maximum: 8192,
};

export const FREQUENCY_PENALTY: SquisqAnnotatedSchema = {
  type: 'number',
  title: 'Frequency penalty',
  description:
    'Penalty that scales with how often a word has already appeared in this reply. Positive values (0.3–0.8) discourage repeating common words; negative values encourage repetition. -2 to 2; usually 0.',
  minimum: -2,
  maximum: 2,
  multipleOf: 0.05,
};

export const PRESENCE_PENALTY: SquisqAnnotatedSchema = {
  type: 'number',
  title: 'Presence penalty',
  description:
    'Penalty applied once any word has appeared at all in this reply (not scaled by count). Positive values (0.3–0.8) push the model toward new vocabulary; useful for brainstorming. -2 to 2; usually 0.',
  minimum: -2,
  maximum: 2,
  multipleOf: 0.05,
};

export const DRY: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'DRY anti-repetition (llama only)',
  description:
    "Don't-Repeat-Yourself: catches longer phrase loops that simple repetition penalty misses. Helpful for small local models that get stuck repeating whole sentences. Set multiplier to 0 to disable.",
  properties: {
    multiplier: {
      type: 'number',
      title: 'Strength',
      description:
        'How hard to penalize repeats. 0 = off. 0.8 is a reasonable starting point — strong enough to break loops without hurting normal repetition.',
      minimum: 0,
      maximum: 5,
      multipleOf: 0.05,
    },
    base: {
      type: 'number',
      title: 'Penalty curve',
      description:
        'How fast the penalty grows for longer repeated sequences. Higher = more aggressive on long repeats. 1.75 is the upstream default.',
      minimum: 0,
      maximum: 5,
      multipleOf: 0.05,
    },
    allowedLength: {
      type: 'integer',
      title: 'Free length',
      description:
        "Repeats shorter than this don't get penalized. 2 = allow 2-token repeats (small phrases), penalize anything longer.",
      minimum: 0,
      maximum: 64,
    },
  },
};

export const XTC: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'XTC sampler (llama only)',
  description:
    'Exclude-Top-Choices: occasionally throws away the most likely word and picks from the rest. Adds personality and surprise to creative writing. Skip this if you want consistency.',
  properties: {
    probability: {
      type: 'number',
      title: 'Trigger rate',
      description:
        'How often XTC fires. 0 = never. 0.5 = half the time. Higher values make replies less predictable.',
      minimum: 0,
      maximum: 1,
      multipleOf: 0.01,
    },
    threshold: {
      type: 'number',
      title: 'Activation threshold',
      description:
        'Only fires when the top word is more likely than this. 0.1 = activate when the model is fairly sure (most of the time); higher values restrict XTC to high-confidence moments.',
      minimum: 0,
      maximum: 1,
      multipleOf: 0.01,
    },
  },
};

export const REASONING_BLOCK_BASE: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Reasoning',
  description: "Controls how much the model 'thinks out loud' before answering.",
  properties: {
    effort: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      title: 'Reasoning effort',
      description:
        "How hard the model works before replying. Low = quick takes (fast, cheap). Medium = balanced (most common default). High = deep deliberation (slower, more thorough — best for math, code, complex planning). Maps to OpenAI's reasoning.effort and Anthropic's thinking.budget_tokens behind the scenes.",
      squisq: { control: 'segmented' },
    },
    thinkingBudget: {
      type: 'integer',
      title: 'Thinking budget (tokens)',
      description:
        "Explicit cap on how many tokens the model can spend thinking before it has to answer. Anthropic Claude and Nemotron use this directly. Wins over 'effort' when both are set. Typical values: 2k for quick, 8k for medium, 24k+ for deep reasoning.",
      minimum: 1,
      maximum: 65536,
    },
    enableThinking: {
      type: 'boolean',
      title: 'Show reasoning',
      description:
        "On = the model writes out its thinking before the final answer (often visible as a collapsible 'thinking' block). Off = the model goes straight to the answer. Mainly affects dual-mode local models like Qwen3 and Nemotron Nano/Super — cloud thinking models infer from the reasoning effort/budget.",
    },
  },
};

export const OUTPUT_BLOCK_BASE: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Structured output',
  description: 'Force the model to produce machine-readable output instead of prose.',
  properties: {
    responseFormat: {
      type: 'string',
      enum: ['text', 'json_object'],
      title: 'Output format',
      description:
        'Text = normal prose (default). JSON = the model must emit syntactically-valid JSON. Combine with a JSON Schema below to pin the exact shape.',
      squisq: { control: 'segmented', enumLabels: { text: 'Text', json_object: 'JSON' } },
    },
  },
};

export const TOOL_CHOICE: SquisqAnnotatedSchema = {
  type: 'string',
  enum: ['auto', 'required', 'none'],
  title: 'Tool calling',
  description:
    'Auto = the model decides whether to call a tool (normal). Required = the model MUST call a tool this turn (good for forcing structured handoffs). None = tools are hidden from the model — pure chat.',
  squisq: { control: 'segmented' },
};

export const PROMPT_TAGS_BLOCK: SquisqAnnotatedSchema = {
  type: 'object',
  title: 'Reasoning prompt tags',
  description:
    'Markers a user can include in a message to flip reasoning on/off for just that turn. Qwen recognizes /think and /no_think by default.',
  properties: {
    enableThinkingTag: {
      type: 'string',
      title: 'Enable tag',
      description:
        'Example: `/think`. Adding this to your message turns thinking ON for that turn.',
    },
    disableThinkingTag: {
      type: 'string',
      title: 'Disable tag',
      description:
        'Example: `/no_think`. Adding this to your message turns thinking OFF for that turn.',
    },
  },
};

/**
 * Build a "samplingWhenThinking" block that's hidden unless
 * `reasoning.enableThinking === true`. The override is sparse: users
 * only fill in the deltas vs the base `sampling` block.
 */
export function samplingWhenThinkingBlock(
  baseProps: Record<string, SquisqAnnotatedSchema>,
): SquisqAnnotatedSchema {
  return {
    type: 'object',
    title: 'When thinking is on, use these instead',
    description:
      'Some models like Qwen3 and Nemotron Nano want different sampling when reasoning. Only fill in the fields you want to change for thinking mode — the rest fall through to your main Sampling values above.',
    properties: baseProps,
    squisq: {
      hidden: { field: 'reasoning.enableThinking', truthy: false },
    },
  };
}
