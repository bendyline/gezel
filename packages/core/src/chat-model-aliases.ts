const LEGACY_CHAT_MODEL_CATALOG_IDS: Record<string, string> = {
  'deepseek-r1': 'deepseek-r1-8b-q4',
  'gemma4-26b': 'gemma4-26b-q4',
  'gemma4-31b': 'gemma4-31b-q4',
  'gemma4-e2b': 'gemma4-e2b-q8',
  'gemma4-e4b': 'gemma4-e4b-q8',
  'gpt-oss': 'gpt-oss-20b-q4',
  'llama3.2': 'llama3.2-3b-q4',
  mistral: 'mistral-7b-q4',
  'mistral-medium-3.5': 'mistral-medium-3.5-128b-q4',
  'nemotron3-nano-30b': 'nemotron3-nano-30b-q4',
  'nemotron3-super-120b': 'nemotron3-super-120b-q4',
  'qwen3.5-2b': 'qwen3.5-2b-q4',
  'qwen3.5-4b': 'qwen3.5-4b-q4',
  'qwen3.5-9b': 'qwen3.5-9b-q4',
  'qwen3.5-122b-a10b': 'qwen3.5-122b-a10b-q4',
  'qwen3.6': 'qwen3.6-27b-q4',
};

/**
 * Map pre-quantized catalog ids from older installs/eval caches to the
 * current chat-model catalog ids. The installed model manifest may keep
 * an old id (`qwen3.5-9b`) while the catalog entry now encodes size and
 * quantization (`qwen3.5-9b-q4`). Catalog-driven tuning, model profiles,
 * eval hints, and reasoning budgets all need the current id.
 */
export function normalizeChatModelCatalogId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return LEGACY_CHAT_MODEL_CATALOG_IDS[modelId] ?? modelId;
}
