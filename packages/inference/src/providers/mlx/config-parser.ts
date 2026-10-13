/**
 * MLX model metadata parsing.
 *
 * Unlike llama.cpp's single-file GGUF format, MLX models are a directory
 * of HuggingFace-standard files:
 *   - `config.json`            architecture, hidden sizes, contextWindow
 *   - `tokenizer_config.json`  chat_template (when present)
 *   - `tokenizer.json`         raw tokenizer
 *   - `model.safetensors`(+.index.json when sharded)  the weights
 *
 * This helper extracts the metadata the rest of the provider needs —
 * context window (to set `mlx_lm.server --max-tokens` / pass-through in
 * the API call) and chat-template presence (surfaced as a UI warning
 * same as llama.cpp).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MlxModelSummary {
  /** Detected context window from config.json, or null when not findable. */
  contextWindow: number | null;
  /** Architecture family (`llama`, `gemma`, `qwen2`, …) — surfaced in the UI. */
  architecture: string | null;
  /** True when `tokenizer_config.json` has a non-empty `chat_template` field. */
  chatTemplatePresent: boolean;
}

/**
 * Read the metadata files in an MLX model directory. Returns conservative
 * defaults when individual files are missing or malformed — we never raise
 * because a weird HF repo shouldn't render the model unusable.
 */
export async function readMlxSummary(modelDir: string): Promise<MlxModelSummary> {
  const config = await readJsonSafe(join(modelDir, 'config.json'));
  const tokenizerConfig = await readJsonSafe(join(modelDir, 'tokenizer_config.json'));

  return {
    contextWindow: extractContextWindow(config),
    architecture: extractArchitecture(config),
    chatTemplatePresent: extractChatTemplate(tokenizerConfig),
  };
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * HuggingFace configs are inconsistent about which field carries the
 * context window. Check the half-dozen common spellings in order of
 * precedence; return the first positive integer found.
 */
function extractContextWindow(config: Record<string, unknown> | null): number | null {
  if (!config) return null;
  const candidates = [
    'max_position_embeddings',
    'n_positions',
    'n_ctx',
    'max_sequence_length',
    'seq_length',
    'model_max_length',
  ];
  for (const key of candidates) {
    const v = config[key];
    if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return Math.floor(v);
  }
  return null;
}

function extractArchitecture(config: Record<string, unknown> | null): string | null {
  if (!config) return null;
  const arch = config.architectures;
  if (Array.isArray(arch) && arch.length > 0 && typeof arch[0] === 'string') {
    return arch[0];
  }
  const modelType = config.model_type;
  if (typeof modelType === 'string' && modelType.length > 0) return modelType;
  return null;
}

function extractChatTemplate(tokenizerConfig: Record<string, unknown> | null): boolean {
  if (!tokenizerConfig) return false;
  const tpl = tokenizerConfig.chat_template;
  return typeof tpl === 'string' && tpl.length > 0;
}
