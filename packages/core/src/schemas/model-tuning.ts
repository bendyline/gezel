/**
 * Per-model sampling / reasoning / structured-output / tool-call defaults.
 *
 * Lives on the chat-model catalog identity manifest (alongside `style` and
 * `behaviors`) as recommended values, and on gezel frontmatter as a sparse
 * `Partial<ChatModelTuning>` override. Providers consume the resolved value
 * via a small per-provider mapping table that translates these field names
 * into each backend's request-body shape (Ollama `options.temperature`,
 * llama.cpp `temperature`, Anthropic `temperature`, etc.). Fields a provider
 * doesn't support are silently dropped.
 *
 * Dual-mode models (Qwen3+, Nemotron Nano) carry a sparse `samplingWhenThinking`
 * override merged shallow-over `sampling` when the runtime determines reasoning
 * is engaged. Single-mode models leave `samplingWhenThinking` unset.
 */

import { z } from 'zod';
import { TuningProfileIdSchema } from './tuning-profile-registry.js';

/**
 * DRY (Don't Repeat Yourself) anti-repetition sampler. llama.cpp ships
 * this; MLX / Ollama / cloud providers don't. Schema-present so manifests
 * can declare it; non-supporting providers ignore. Multiplier 0 = off.
 */
export const DrySamplerSchema = z
  .object({
    multiplier: z
      .number()
      .min(0)
      .max(5)
      .describe('DRY penalty strength. 0 disables. 0.8 is a reasonable default.'),
    base: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe('Base of the exponential penalty for repeated tokens. Default 1.75.'),
    allowedLength: z
      .number()
      .int()
      .min(0)
      .max(64)
      .optional()
      .describe('Minimum n-gram length before DRY kicks in. Default 2.'),
  })
  .describe('DRY anti-repetition sampler (llama.cpp only).');
export type DrySamplerConfig = z.infer<typeof DrySamplerSchema>;

/**
 * XTC (Exclude Top Choices) sampler — drops the top-probability tokens with
 * a configurable probability when their probability exceeds a threshold,
 * trading determinism for surprise. llama.cpp only.
 */
export const XtcSamplerSchema = z
  .object({
    probability: z
      .number()
      .min(0)
      .max(1)
      .describe('Probability of triggering XTC on any given step.'),
    threshold: z.number().min(0).max(1).describe('Minimum top-token probability for XTC to fire.'),
  })
  .describe('XTC sampler (llama.cpp only).');
export type XtcSamplerConfig = z.infer<typeof XtcSamplerSchema>;

/**
 * Base sampling block — the parameters every provider with a real sampler
 * understands at least some subset of. Mode-specific overrides (thinking vs
 * not) live in `ChatModelTuning.samplingWhenThinking`.
 */
export const SamplingBlockSchema = z
  .object({
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Sampling temperature. 0 = greedy. Most reasoning models want 0.6–1.0.'),
    topP: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Nucleus sampling. 0.95 is the common default for Qwen, Gemma, Nemotron.'),
    topK: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe('Top-k cutoff. 20 for Qwen think, 64 for Gemma, 1 for greedy-on-instruct.'),
    minP: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Min-p cutoff (llama.cpp / MLX / Ollama). Qwen recommends 0.'),
    maxTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Per-turn output token cap. Maps to num_predict / max_tokens / n_predict.'),
    seed: z
      .number()
      .int()
      .optional()
      .describe('RNG seed. Unset / negative = random. Best-effort determinism on cloud.'),
    repetitionPenalty: z
      .number()
      .min(0)
      .max(3)
      .optional()
      .describe('Local engines (Ollama / llama.cpp / MLX): repeat_penalty. 1.0 = off, 1.1 = mild.'),
    repetitionContext: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Local engines: window size for repetition penalty (`repeat_last_n`).'),
    frequencyPenalty: z
      .number()
      .min(-2)
      .max(2)
      .optional()
      .describe('Cloud (OpenAI) and Ollama / llama.cpp: penalize repeated tokens by frequency.'),
    presencePenalty: z
      .number()
      .min(-2)
      .max(2)
      .optional()
      .describe('Cloud (OpenAI) and Ollama / llama.cpp: penalize any reused token.'),
    dry: DrySamplerSchema.optional(),
    xtc: XtcSamplerSchema.optional(),
  })
  .describe('Sampling parameters applied per-request.');
export type SamplingBlock = z.infer<typeof SamplingBlockSchema>;

/**
 * Reasoning controls. Mostly cloud-shaped today; the local engines that
 * support a thinking mode (Qwen3+, DeepSeek-R1, Nemotron) consume
 * `enableThinking` via chat-template kwargs.
 */
export const ReasoningBlockSchema = z
  .object({
    effort: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe(
        'Cloud reasoning effort. Maps to OpenAI `reasoning.effort` and Anthropic `thinking.budget_tokens` tiers.',
      ),
    thinkingBudget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Explicit thinking-token budget (Anthropic `thinking.budget_tokens`, Nemotron `reasoning_budget`). Wins over `effort` when both set.',
      ),
    enableThinking: z
      .boolean()
      .optional()
      .describe(
        'Chat-template toggle for dual-mode models (Qwen3+, Nemotron Nano/Super). Implicit on cloud thinking models.',
      ),
    templateKwargs: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        'Chat-template variables that drive this model\'s reasoning depth, forwarded verbatim as `chat_template_kwargs` on local engines. The names are the model\'s own — GPT-OSS reads `reasoning_effort`, Muse Glimmer reads `reasoning_strength` (low|medium|high|xhigh) — so the manifest declares them rather than the runtime guessing. Lives under `reasoning` (not `engine`) because depth is a per-request choice a tuning profile overrides: `thinking-coding` can ask for xhigh while `instruct` asks for low. Cloud providers ignore it; use `reasoning.effort` there.',
      ),
  })
  .describe('Reasoning controls.');
export type ReasoningBlock = z.infer<typeof ReasoningBlockSchema>;

/**
 * Structured-output controls. `responseFormat: 'json_object'` enforces JSON
 * output on supporting providers. `jsonSchema` (when set) goes further and
 * pins the shape; OpenAI strict mode and llama.cpp's `json_schema` body field
 * both honor it. `grammar` is a llama.cpp GBNF string — escape hatch when
 * neither of the above fit.
 */
export const StructuredOutputSchema = z
  .object({
    responseFormat: z
      .enum(['text', 'json_object'])
      .optional()
      .describe('Output mode. `text` = freeform (default). `json_object` = enforce JSON.'),
    jsonSchema: z
      .unknown()
      .optional()
      .describe('Pin output to a JSON Schema (OpenAI strict mode, llama.cpp --json-schema).'),
    grammar: z
      .string()
      .optional()
      .describe('llama.cpp GBNF grammar. Last-resort structured-output knob.'),
  })
  .describe('Structured-output controls.');
export type StructuredOutput = z.infer<typeof StructuredOutputSchema>;

/**
 * Prompt-tag mapping for models that toggle reasoning via user-prompt
 * markers (e.g. Qwen `/think` / `/no_think`). The chat layer can scan
 * incoming user prompts for these markers and flip `reasoning.enableThinking`
 * accordingly without the user editing settings.
 */
export const PromptTagsSchema = z
  .object({
    enableThinkingTag: z
      .string()
      .optional()
      .describe('User-prompt tag that enables thinking for this turn (e.g. `/think`).'),
    disableThinkingTag: z
      .string()
      .optional()
      .describe('User-prompt tag that disables thinking for this turn (e.g. `/no_think`).'),
  })
  .describe('Per-turn reasoning toggle tags.');
export type PromptTags = z.infer<typeof PromptTagsSchema>;

/**
 * Per-model llama.cpp ENGINE-launch defaults — flags applied once at
 * model load (`llama-server` argv), NOT per request. Distinct from the
 * sampling/reasoning blocks above, which the provider maps into the
 * per-request HTTP body. Lets the catalog ship model-specific engine
 * defaults the launcher merges under the user's global `GezelConfig`
 * overrides (global override > this manifest default > auto-planner >
 * server default). Every field optional.
 */
export const LlamaCppEngineConfigSchema = z
  .object({
    nGpuLayers: z
      .number()
      .int()
      .min(-1)
      .optional()
      .describe('`--n-gpu-layers` override. -1 = all. Unset = b9843 `auto`/`--fit`.'),
    cpuMoe: z
      .boolean()
      .optional()
      .describe('`--cpu-moe`: keep ALL MoE experts in system RAM (attention/dense on GPU).'),
    nCpuMoe: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('`--n-cpu-moe N`: keep the first N layers’ MoE experts in RAM. Partial split.'),
    cacheReuse: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        '`--cache-reuse N` prefix-KV reuse chunk. 0 = disable. Unset inherits the global default.',
      ),
    swaFull: z.boolean().optional().describe('`--swa-full`: full-size SWA cache (Gemma family).'),
    flashAttn: z
      .enum(['on', 'off', 'auto'])
      .optional()
      .describe('`--flash-attn` mode override for this model.'),
    ubatchSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('`--ubatch-size` (inner microbatch) override for this model.'),
    contextSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Per-turn context ceiling (tokens) this model launches with. Capped by GGUF train ctx.',
      ),
    chatTemplate: z
      .string()
      .min(1)
      .optional()
      .describe(
        '`--chat-template` override for GGUFs whose embedded Jinja template is incompatible with llama.cpp tool parsing.',
      ),
    threads: z.number().int().positive().optional().describe('`--threads` override.'),
    batchSize: z.number().int().positive().optional().describe('`--batch-size` override.'),
    spec: z
      .object({
        type: z
          .enum([
            'none',
            'draft-mtp',
            'draft-eagle3',
            'draft-dflash',
            'draft-simple',
            'ngram-mod',
            'ngram-simple',
            'ngram-map-k',
            'ngram-map-k4v',
            'ngram-cache',
          ])
          .optional()
          .describe('`--spec-type` speculative-decoding mode for this model.'),
        mtp: z
          .boolean()
          .optional()
          .describe(
            'VERIFIED capability metadata: this model’s target or companion GGUF carries MTP tensors. Does not enable `draft-mtp` by itself.',
          ),
        draftModelId: z
          .string()
          .optional()
          .describe('Catalog id / path of the draft model for `draft-simple`.'),
        nMax: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('`--spec-draft-n-max`: tokens drafted per step.'),
      })
      .optional()
      .describe('Speculative-decoding config for this model.'),
  })
  .describe('Per-model llama.cpp launch-flag defaults (engine-level, applied at model load).');
export type LlamaCppEngineConfig = z.infer<typeof LlamaCppEngineConfigSchema>;

/**
 * Per-model engine launch-flag defaults, keyed by engine. Only
 * `llamaCpp` today; `mlx` / `ollama` blocks can follow the same shape.
 */
export const EngineConfigSchema = z
  .object({
    llamaCpp: LlamaCppEngineConfigSchema.optional(),
  })
  .describe('Per-model engine launch-flag defaults, keyed by engine.');
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

/**
 * Per-model tuning, minus the `profiles` map. Split out from
 * {@link ChatModelTuningSchema} so each value inside `profiles` can carry
 * a sparse partial of the same shape without the recursion exploding the
 * Zod parser. Manifests and gezel-frontmatter overrides typed as
 * {@link ChatModelTuningSchema} (with profiles); profile *values* typed
 * as {@link ChatModelTuningBaseSchema} partials (no nested profiles).
 */
export const ChatModelTuningBaseSchema = z
  .object({
    sampling: SamplingBlockSchema.optional(),
    samplingWhenThinking: SamplingBlockSchema.optional().describe(
      'Sparse override of `sampling` applied when the runtime determines reasoning is engaged. Used by Qwen3+ (different sampling for /think mode) and Nemotron Nano (different sampling for thinking vs instruct).',
    ),
    reasoning: ReasoningBlockSchema.optional(),
    output: StructuredOutputSchema.optional(),
    toolChoice: z
      .enum(['auto', 'required', 'none'])
      .optional()
      .describe(
        'Tool selection mode (cloud + llama.cpp + MLX). `auto` lets the model decide; `required` forces a tool call this turn; `none` disables tools.',
      ),
    promptTags: PromptTagsSchema.optional(),
  })
  .describe('Per-model sampling, reasoning, and output defaults (without profiles).');
export type ChatModelTuningBase = z.infer<typeof ChatModelTuningBaseSchema>;

/**
 * Per-model tuning. All fields optional; an unset field falls through to
 * the provider's own default. Resolved at request time via `resolveTuning`,
 * which merges gezel-override > installDefault > profile > catalog default.
 *
 * `profiles` (when set) declares named tuning presets the model implements
 * — e.g. `thinking-coding`, `thinking-general`, `instruct`, `creative`.
 * Each profile value is a sparse {@link ChatModelTuningBaseSchema} partial
 * applied as a layer in the merge stack when the active gezel selects that
 * profile via its `tuningProfile` frontmatter field. See
 * `tuning-profile-registry.ts` for the canonical id set and fallback chains.
 */
export const ChatModelTuningSchema = ChatModelTuningBaseSchema.extend({
  engine: EngineConfigSchema.optional().describe(
    'Per-model ENGINE launch-flag defaults (llama.cpp `--n-gpu-layers`, `--cpu-moe`, `--spec-type`, …). Applied once at model load, not per request — so it lives on the top-level tuning object, not inside per-request `profiles`.',
  ),
  profiles: z
    .record(TuningProfileIdSchema, ChatModelTuningBaseSchema.partial())
    .optional()
    .describe(
      'Named tuning presets this model implements. Gezel frontmatter `tuningProfile` selects one; the resolver applies the profile as a layer between installDefault and catalog base. Missing requested profiles walk the canonical fallback chain.',
    ),
}).describe('Per-model sampling, reasoning, and output defaults.');
export type ChatModelTuning = z.infer<typeof ChatModelTuningSchema>;
