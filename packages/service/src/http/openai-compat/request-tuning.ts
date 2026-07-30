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

  return {
    ...tuning,
    sampling,
    output,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  };
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

  return { ...tuning, sampling, output };
}
