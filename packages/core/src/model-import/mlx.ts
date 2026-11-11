/**
 * MLX repositories on Hugging Face (`mlx-community/Qwen3-8B-4bit`): a model
 * directory of safetensors shards beside `config.json` and tokenizer files,
 * sometimes several builds side by side (`4bit/`, `8bit/`). This picks the
 * files the MLX engine reads and reads what the configs say about the model.
 *
 * A checkpoint can carry Python: mlx-vlm executes a `model_file` named in
 * `config.json`, and transformers fetches and runs the code an `auto_map`
 * points at. Only data files are ever selected here, and a config that asks
 * for code is reported so the review refuses it.
 */

import { MLX_MODEL_TYPES, MLX_MODEL_TYPE_ALIASES } from '../native/mlx-model-support.js';
import type { HubRepoFile } from './gguf-files.js';

/** The data files an MLX model directory holds, by basename. */
const MLX_DATA_FILE =
  /^(?:[^/]+\.safetensors|model\.safetensors\.index\.json|config\.json|generation_config\.json|tokenizer\.json|tokenizer\.model|tokenizer_config\.json|special_tokens_map\.json|added_tokens\.json|vocab\.json|merges\.txt|chat_template\.jinja|chat_template\.json|preprocessor_config\.json|processor_config\.json|video_preprocessor_config\.json)$/;

/** Small JSON/text files the review reads in full (configs, never weights). */
export const MLX_CONFIG_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer_config.json',
  'chat_template.jinja',
  'chat_template.json',
  'processor_config.json',
  'preprocessor_config.json',
] as const;

export function isMlxDataFile(name: string): boolean {
  return MLX_DATA_FILE.test(name);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Directories holding a whole MLX model: `config.json` plus at least one
 * safetensors shard beside it. `''` is the repo root. Shallowest first.
 */
export function mlxModelRoots(files: readonly HubRepoFile[]): string[] {
  const configs = new Set<string>();
  const weights = new Set<string>();
  for (const file of files) {
    const base = baseOf(file.path);
    if (base === 'config.json') configs.add(dirOf(file.path));
    else if (base.endsWith('.safetensors')) weights.add(dirOf(file.path));
  }
  return [...configs]
    .filter((dir) => weights.has(dir))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** The files an MLX install of `root` needs, at most one directory deep below it. */
export function selectMlxFiles(files: readonly HubRepoFile[], root: string): HubRepoFile[] {
  const prefix = root ? `${root}/` : '';
  return files.filter((file) => {
    if (!file.path.startsWith(prefix)) return false;
    const rel = file.path.slice(prefix.length);
    return !rel.includes('/') && isMlxDataFile(rel);
  });
}

/** What an MLX model's configs say, read before any weight downloads. */
export interface MlxConfigFacts {
  /** `config.json` `model_type`, after mlx-vlm's own aliases. */
  modelType?: string;
  /** Bits per weight from the `quantization` block, when the build is quantized. */
  quantizationBits?: number;
  /** `max_position_embeddings` (from `text_config` on multimodal models). */
  contextLength?: number;
  /** Routed experts, above 1 on a Mixture-of-Experts model. */
  expertCount?: number;
  /** A config names code to run (`auto_map`, `model_file`); never loaded. */
  customCode: boolean;
  /** A vision tower is part of the checkpoint. */
  vision: boolean;
  /** The conversation template, from whichever file carries it. */
  chatTemplate?: string;
  /** `general.base_model`-style references from the configs, normalized. */
  baseModels?: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function templateFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  // A list of named templates (`[{ name: 'default', template: '…' }]`).
  if (Array.isArray(value)) {
    for (const item of value) {
      const template = record(item)?.template;
      if (typeof template === 'string' && template.trim()) return template;
    }
  }
  return undefined;
}

export function mlxConfigFacts(input: {
  config: unknown;
  tokenizerConfig?: unknown;
  chatTemplateJinja?: string;
  chatTemplateJson?: unknown;
  processorConfigs?: unknown[];
}): MlxConfigFacts {
  const config = record(input.config) ?? {};
  const text = record(config.text_config) ?? config;
  const rawType = typeof config.model_type === 'string' ? config.model_type : undefined;
  const modelType = rawType ? (MLX_MODEL_TYPE_ALIASES[rawType] ?? rawType) : undefined;
  const quantization = record(config.quantization) ?? record(config.quantization_config);
  const bits = positive(quantization?.bits);
  const contextLength =
    positive(text.max_position_embeddings) ?? positive(config.max_position_embeddings);
  const expertCount =
    positive(text.num_local_experts) ??
    positive(text.num_experts) ??
    positive(text.n_routed_experts);
  const tokenizerConfig = record(input.tokenizerConfig);
  const codeIn = (value: Record<string, unknown> | undefined) =>
    Boolean(value && (value.auto_map !== undefined || value.model_file !== undefined));
  const customCode =
    codeIn(config) ||
    codeIn(record(config.text_config)) ||
    codeIn(tokenizerConfig) ||
    (input.processorConfigs ?? []).some((item) => codeIn(record(item)));
  const chatTemplate =
    templateFrom(input.chatTemplateJinja) ??
    templateFrom(record(input.chatTemplateJson)?.chat_template) ??
    templateFrom(tokenizerConfig?.chat_template);
  return {
    ...(modelType ? { modelType } : {}),
    ...(bits ? { quantizationBits: bits } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(expertCount ? { expertCount } : {}),
    customCode,
    vision: record(config.vision_config) !== undefined,
    ...(chatTemplate ? { chatTemplate } : {}),
  };
}

const SUPPORTED_MLX_TYPES = new Set(MLX_MODEL_TYPES);

export function isSupportedMlxModelType(modelType: string): boolean {
  return SUPPORTED_MLX_TYPES.has(MLX_MODEL_TYPE_ALIASES[modelType] ?? modelType);
}

/** `4bit`, `8bit`, `bf16`: the quant label the model table shows. */
export function mlxQuantizationLabel(facts: MlxConfigFacts): string {
  return facts.quantizationBits ? `${facts.quantizationBits}bit` : 'bf16';
}
