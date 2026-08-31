const LEGACY_CHAT_MODEL_CATALOG_IDS: Record<string, string> = {
  'deepseek-r1': 'deepseek-r1-8b-q4',
  'gemma4-26b': 'gemma4-26b-q4',
  'gemma4-31b': 'gemma4-31b-q4',
  'gpt-oss': 'gpt-oss-20b-q4',
  'llama3.2': 'llama3.2-3b-q4',
  mistral: 'mistral-7b-q4',
  'mistral-medium-3.5': 'mistral-medium-3.5-128b-q4',
  'nemotron3-nano-30b': 'nemotron3-nano-30b-q4',
  'nemotron3.5-lightning-30b': 'nemotron3.5-lightning-30b-q4',
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

/**
 * Does this model id already name its quantization? Every current
 * chat-model catalog id ends in the width it ships (`-q4`, `-q8`,
 * `-iq2`, `-mxfp4`, and `-iq1-s`-style variant tails). Ids minted
 * before that convention (`mistral`, `qwen3.5-9b`, `gemma4-e4b`) do
 * not, which is how a Q8 install ends up sitting in the model table
 * one row below its own Q4 sibling with nothing to tell them apart.
 */
export function hasQuantSuffix(modelId: string): boolean {
  return /-(?:i?q\d|mxfp\d|fp\d|bf16|f16)[a-z0-9_-]*$/i.test(modelId);
}

/**
 * The id suffix for a quantization label, or null when unrecognized.
 *
 * Label-driven on purpose: the engines name the same width differently
 * (`Q8_0` vs `8bit`, `UD-Q4_K_XL` vs `4bit`) and the label is what the
 * install manifest actually recorded. `iq` is tested before `q` so
 * `IQ2_XXS` does not read as `q2`.
 */
export function quantSuffixForLabel(quantization: string | undefined): string | null {
  const q = quantization?.toLowerCase();
  if (!q) return null;
  const mxfp = q.match(/(?:^|[^a-z0-9])mxfp(\d)/);
  if (mxfp) return `mxfp${mxfp[1]}`;
  const iq = q.match(/(?:^|[^a-z0-9])iq(\d)/);
  if (iq) return `iq${iq[1]}`;
  const qn = q.match(/(?:^|[^a-z0-9])q(\d)/);
  if (qn) return `q${qn[1]}`;
  const bit = q.match(/(?:^|[^a-z0-9])(\d)bit/);
  if (bit) return `q${bit[1]}`;
  if (/bf16/.test(q)) return 'bf16';
  if (/fp?16/.test(q)) return 'f16';
  return null;
}

/**
 * The suffixed id a pre-convention install should carry, or null when it
 * already carries one (or the manifest recorded no usable quantization
 * label). Prefers the current catalog id when the alias map knows one —
 * that both names the width and re-links the install to a live catalog
 * entry — and otherwise appends the width to the id the install already
 * has, which is the only option for a build the catalog never shipped
 * (`gemma4-e4b` was only ever published at Q4).
 */
export function quantSuffixedModelId(
  modelId: string,
  quantization: string | undefined,
): string | null {
  if (hasQuantSuffix(modelId)) return null;
  const aliased = normalizeChatModelCatalogId(modelId);
  if (aliased && aliased !== modelId && hasQuantSuffix(aliased)) return aliased;
  const suffix = quantSuffixForLabel(quantization);
  return suffix ? `${modelId}-${suffix}` : null;
}
