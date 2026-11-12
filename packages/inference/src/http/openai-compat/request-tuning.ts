import {
  CONSTRAINED_TURN_REASONING_DEPTH,
  REASONING_DEPTH_TEMPLATE_KWARGS,
} from '@bendyline/gezel/local-loop';
import type { ResolvedTuning } from '../../model-profile/tuning.js';
import type { ChatCompletionRequest } from './translate.js';

/**
 * Overlay per-request knobs onto a model's resolved tuning as the
 * TOPMOST layer — an explicit value in the request beats the gezel
 * override, the install default, and the catalog recommendation, which
 * is exactly what an OpenAI-shaped caller expects when it sends
 * `temperature: 0.2`.
 *
 * The result flows through the normal `SessionOpts.tuning` path, so it
 * reaches every tuning-consuming provider (llama-cpp, MLX, Ollama,
 * ds4, OpenAI, Anthropic) via each one's tuning map. Copilot and the
 * CLI providers ignore tuning — the same silent-no-op UI sessions have
 * on those backends.
 */
export function overlayOpenAiRequestTuning(
  tuning: ResolvedTuning,
  req: ChatCompletionRequest,
): ResolvedTuning {
  const sampling = { ...tuning.sampling };
  if (req.temperature !== undefined) sampling.temperature = req.temperature;
  if (req.top_p !== undefined) sampling.topP = req.top_p;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens !== undefined) sampling.maxTokens = maxTokens;
  if (req.presence_penalty !== undefined) sampling.presencePenalty = req.presence_penalty;
  if (req.frequency_penalty !== undefined) sampling.frequencyPenalty = req.frequency_penalty;
  if (req.seed !== undefined) sampling.seed = req.seed;

  const output = { ...tuning.output };
  if (req.response_format?.type === 'json_object') {
    output.responseFormat = 'json_object';
  } else if (req.response_format?.type === 'json_schema') {
    output.jsonSchema = req.response_format.json_schema.schema;
  }

  const toolChoice = typeof req.tool_choice === 'string' ? req.tool_choice : tuning.toolChoice;

  // Only the off direction is mapped: turning thinking ON for a model whose
  // catalog leaves it off could select a mode the model does not have.
  const reasoning = disablesThinking(req.reasoning_effort)
    ? withoutReasoning(tuning.reasoning)
    : tuning.reasoning;

  return {
    ...tuning,
    sampling,
    reasoning,
    output,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  };
}

/**
 * The reasoning block for a request that asked to skip reasoning.
 *
 * The switch alone is not enough. GPT-OSS's template ignores
 * `enable_thinking` and reasons at whatever depth its `reasoning_effort`
 * kwarg says — the catalog's `medium` — so a DocBlocks review that asked for
 * no reasoning spent its output budget thinking and was cut off (docbench,
 * 2026-11-11: 27 of 142 gpt-oss-20b outputs). Every reasoning-depth dial the
 * model declares drops to its floor too, as a constrained turn's does
 * (`downgradeReasoningDepthKwargs`). Only declared dials move: a key the
 * template does not read can raise inside it.
 */
export function withoutReasoning(
  reasoning: ResolvedTuning['reasoning'],
): ResolvedTuning['reasoning'] {
  const kwargs = reasoning.templateKwargs;
  return {
    ...reasoning,
    enableThinking: false,
    ...(kwargs
      ? {
          templateKwargs: Object.fromEntries(
            Object.entries(kwargs).map(([key, value]) => [
              key,
              REASONING_DEPTH_TEMPLATE_KWARGS.has(key) ? CONSTRAINED_TURN_REASONING_DEPTH : value,
            ]),
          ),
        }
      : {}),
  };
}

/** OpenAI effort values that mean "answer without a reasoning phase". */
export function disablesThinking(effort: string | undefined): boolean {
  return effort === 'none' || effort === 'minimal';
}

/**
 * Ollama's per-request `options` block, overlaid the same way. Only the
 * sampling-shaped keys are honored; engine-level knobs (`num_ctx`,
 * `num_thread`, …) are ignored — the engine pool owns those.
 */
export interface OllamaRequestOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  num_predict?: number;
  seed?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

export function overlayOllamaRequestTuning(
  tuning: ResolvedTuning,
  options: OllamaRequestOptions | undefined,
  format: 'json' | Record<string, unknown> | undefined,
  /**
   * Ollama's top-level `think`. Only `false` is mapped, for the reason
   * `overlayOpenAiRequestTuning` maps only the off direction. Without it an
   * Ollama client had no way to skip the reasoning phase: a three-word answer
   * took 5 to 15 seconds and 164 to 400 unseen tokens (qwen3.5-9b, 2026-11-10).
   */
  think?: boolean | string,
): ResolvedTuning {
  const sampling = { ...tuning.sampling };
  if (options) {
    if (options.temperature !== undefined) sampling.temperature = options.temperature;
    if (options.top_p !== undefined) sampling.topP = options.top_p;
    if (options.top_k !== undefined) sampling.topK = options.top_k;
    if (options.min_p !== undefined) sampling.minP = options.min_p;
    if (options.num_predict !== undefined && options.num_predict > 0) {
      sampling.maxTokens = options.num_predict;
    }
    if (options.seed !== undefined) sampling.seed = options.seed;
    if (options.repeat_penalty !== undefined) sampling.repetitionPenalty = options.repeat_penalty;
    if (options.presence_penalty !== undefined) sampling.presencePenalty = options.presence_penalty;
    if (options.frequency_penalty !== undefined) {
      sampling.frequencyPenalty = options.frequency_penalty;
    }
  }

  const output = { ...tuning.output };
  if (format === 'json') {
    output.responseFormat = 'json_object';
  } else if (format && typeof format === 'object') {
    // Ollama's structured-output form: `format` IS the JSON schema.
    output.jsonSchema = format;
  }

  const reasoning = think === false ? withoutReasoning(tuning.reasoning) : tuning.reasoning;

  return { ...tuning, sampling, reasoning, output };
}
