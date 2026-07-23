/**
 * Shared knowledge about Ollama model families so the service and UI
 * stay aligned on which models behave like "reasoning" models. Ollama
 * doesn't expose a per-model capability flag we can trust today — this
 * is a curated prefix list. Keep it narrow: include families that
 * reliably consume their output budget on silent chain-of-thought
 * before producing a visible reply, nothing else.
 *
 * Add a family here when:
 *   1. Users report empty bubbles with the model selected.
 *   2. The model's Ollama page documents a reasoning / thinking mode.
 *
 * If Ollama later adds `capabilities: ["thinking"]` to `/api/show`
 * consistently, replace the prefix match with a runtime probe and
 * drop the list.
 */
export const OLLAMA_REASONING_MODEL_PREFIXES = ['deepseek-r1', 'qwq', 'gpt-oss', 'qwen3-thinking'];

/**
 * True when the given Ollama model id looks like a reasoning model.
 * Matches both a leading prefix (`deepseek-r1:latest`) and an embedded
 * substring (`hf.co/bartowski/qwen3-thinking-gguf:Q4_K_M`) so tag
 * variants don't slip through. Case-insensitive.
 */
export function isOllamaReasoningModel(modelId: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return OLLAMA_REASONING_MODEL_PREFIXES.some((p) => lower.startsWith(p) || lower.includes(p));
}

/**
 * Model families that leak unstructured chain-of-thought into the
 * visible reply unless explicitly instructed to wrap it. Broader than
 * `OLLAMA_REASONING_MODEL_PREFIXES` because the leakage problem isn't
 * confined to thinking-mode-on models — Qwen 3 base, Qwen 2.5, and a
 * handful of distillates pontificate freely as plain text and burn
 * their output token budget before reaching the actual tool call.
 *
 * Substrings, not prefixes — modelId may be an Ollama tag
 * (`qwen2.5:7b`), an MLX repo (`Qwen/Qwen3-30B-A3B-Instruct`), a
 * llama.cpp filesystem path (`/models/qwen3-coder-30b.gguf`), or a
 * bare HF id. Match case-insensitively against any substring.
 *
 * Add a family here when:
 *   1. Users report responses where reasoning prose dominates and
 *      tool calls truncate or fail to materialize.
 *   2. The model's docs or runtime expose a native reasoning /
 *      thinking mode.
 */
export const MODEL_FAMILIES_LEAKING_REASONING = [
  'qwen2.5',
  'qwen3',
  'qwen-3',
  'qwq',
  'deepseek-r1',
  'gpt-oss',
  // Gemma 3/4 exhibit the same "spin in plain prose / re-read files /
  // narrate intent without acting" pattern as the verbose Qwen family.
  // Routing them through local-model guidance gives them the tool-use
  // cookbook + "act first" block without teaching a synthetic wrapper
  // format they may detokenize poorly.
  'gemma3',
  'gemma-3',
  'gemma4',
  'gemma-4',
];

/**
 * True when the given model id (Ollama tag, MLX repo, llama.cpp path,
 * or bare HF id) belongs to a family known to leak chain-of-thought
 * into visible content unless told otherwise. Used by the system-
 * prompt builder to add local-model guidance, and by the Ollama
 * provider to bump the default `num_predict` cap so the leak doesn't
 * truncate the actual tool call mid-stream.
 */
export function leaksUntaggedReasoning(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return MODEL_FAMILIES_LEAKING_REASONING.some((p) => lower.includes(p));
}
