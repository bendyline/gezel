/**
 * What a GGUF file says about itself, read from its header before any weights
 * are downloaded (a ranged read of the first few megabytes). Every string is
 * the uploader's and untrusted: shown as text, matched against fixed tables,
 * never used to build a path, a command, or a prompt.
 */

import {
  LLAMA_CPP_ARCHITECTURES,
  LLAMA_CPP_REMOVED_TENSOR_TYPES,
  LLAMA_CPP_TENSOR_TYPES,
} from '../native/llama-cpp-gguf-support.js';

export interface GgufHeaderFacts {
  /** GGUF container version (2 or 3). */
  version: number;
  /** `general.architecture` — the model design (`llama`, `qwen3`, `gemma4`, …). */
  architecture?: string;
  /** `general.type` — `model`, or `adapter` for a LoRA, when the converter wrote it. */
  generalType?: string;
  /** `adapter.type` — `lora` on adapter files. */
  adapterType?: string;
  /** `general.name`. */
  name?: string;
  /** `general.basename` — the model's name without size or finetune suffixes. */
  basename?: string;
  /** `general.size_label` — `8B`, `30B-A3B`, `8x7B`. */
  sizeLabel?: string;
  /** `general.license`. */
  license?: string;
  /** `general.organization` — who made the base model. */
  organization?: string;
  /** `<arch>.context_length` — the window the model was trained for. */
  contextLength?: number;
  /** `general.file_type` as llama.cpp names it (`MOSTLY_Q4_K_M`). */
  fileTypeName?: string;
  /** `tokenizer.chat_template`, when the file carries one. */
  chatTemplate?: string;
  /** `tokenizer.ggml.model` (`gpt2`, `llama`, …); absent means no tokenizer at all. */
  tokenizerModel?: string;
  /** `<arch>.pooling_type` — set by embedding and reranker models. */
  poolingType?: number;
  /** `<arch>.expert_count` — above 1 for a Mixture-of-Experts model. */
  expertCount?: number;
  /** Parameters counted from the tensor table, when the whole table was read. */
  parameterCount?: number;
  /** ggml tensor type id → number of tensors stored in it (this file only). */
  tensorTypeCounts?: Record<number, number>;
  /** `split.count` — the number of files a split model spans. */
  splitCount?: number;
  /**
   * The model this file was converted or fine-tuned from, as `owner/name`
   * (`general.base_model.N.repo_url`).
   */
  baseModels?: string[];
  /** KV cache cost at f16, from the attention geometry. */
  kvBytesPerTokenF16?: number;
  kvFixedBytesF16?: number;
}

/** llama.cpp's encoder-only designs: they make search vectors, not replies. */
const EMBEDDING_ARCHITECTURES = new Set([
  'bert',
  'nomic-bert',
  'nomic-bert-moe',
  'neo-bert',
  'jina-bert-v2',
  'jina-bert-v3',
  't5encoder',
  'modern-bert',
]);

const SUPPORTED_ARCHITECTURES = new Set(LLAMA_CPP_ARCHITECTURES);

export function isSupportedGgufArchitecture(architecture: string): boolean {
  return SUPPORTED_ARCHITECTURES.has(architecture) && architecture !== 'clip';
}

/** Why this file is not a model someone can chat with, or undefined when it is. */
export function ggufNonChatKind(
  header: GgufHeaderFacts,
): 'adapter' | 'projector' | 'embedding' | undefined {
  if (header.generalType === 'adapter' || header.adapterType) return 'adapter';
  if (header.architecture === 'clip' || header.generalType === 'mmproj') return 'projector';
  if (header.architecture && EMBEDDING_ARCHITECTURES.has(header.architecture)) return 'embedding';
  // A pooling type marks a sentence-embedding or reranking head. Chat models
  // never set one, so it decides the cases a design name alone cannot.
  if (header.poolingType !== undefined && header.poolingType > 0 && !header.chatTemplate) {
    return 'embedding';
  }
  return undefined;
}

/** Tensor types in this file that the pinned engine cannot read, by name. */
export function unreadableGgufTensorTypes(header: GgufHeaderFacts): {
  removed: string[];
  unknown: number[];
} {
  const removed: string[] = [];
  const unknown: number[] = [];
  for (const raw of Object.keys(header.tensorTypeCounts ?? {})) {
    const id = Number(raw);
    if (LLAMA_CPP_TENSOR_TYPES[id] !== undefined) continue;
    const gone = LLAMA_CPP_REMOVED_TENSOR_TYPES[id];
    if (gone) removed.push(gone);
    else unknown.push(id);
  }
  return { removed, unknown };
}

/** Tensor type names in this file, most-used first, for the review's detail line. */
export function ggufTensorTypeNames(header: GgufHeaderFacts): string[] {
  return Object.entries(header.tensorTypeCounts ?? {})
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => LLAMA_CPP_TENSOR_TYPES[Number(id)] ?? `type ${id}`);
}

/**
 * Whether a chat template renders tool definitions. Templates that support
 * tools read a `tools` variable (or emit a tool-call marker); one that never
 * mentions either drops the tool list on the floor.
 */
export function chatTemplateSupportsTools(template: string | undefined): boolean {
  if (!template) return false;
  return /\btools\b/.test(template) || /tool_call/.test(template);
}

/** Whether a chat template has a thinking channel the engine should budget. */
export function chatTemplateThinks(template: string | undefined): boolean {
  if (!template) return false;
  return /<think>|enable_thinking|reasoning_content|<\|channel\|>/.test(template);
}

/**
 * Billions of parameters as the catalog writes them (`8B`, `30.5B`, `600M`).
 * Prefers the header's own size label (`8B`, `30B-A3B`); then the tensor
 * count; then file size at the quant's rough bits per weight.
 *
 * An expert-count label (`32x2.4B`, `8x7B`) is never multiplied out: experts
 * share attention and embeddings, so the product overstates the model.
 * gpt-oss-20b labels itself `32x2.4B` (77B multiplied) and counts 20.9B.
 */
export function ggufParameterSize(
  header: GgufHeaderFacts,
  fallback?: { sizeBytes: number; bitsPerWeight?: number },
): string | undefined {
  const label = header.sizeLabel?.trim();
  if (label && !/^\d+x/i.test(label)) {
    const plain = /^(\d+(?:\.\d+)?)([BMK])/i.exec(label);
    if (plain) return formatParameterCount(Number(plain[1]) * unitScale(plain[2] as string));
  }
  if (header.parameterCount && header.parameterCount > 0) {
    return formatParameterCount(header.parameterCount);
  }
  if (fallback && fallback.sizeBytes > 0) {
    const bits = fallback.bitsPerWeight ?? 4.8;
    return formatParameterCount((fallback.sizeBytes * 8) / bits);
  }
  return undefined;
}

function unitScale(unit: string): number {
  switch (unit.toUpperCase()) {
    case 'B':
      return 1e9;
    case 'M':
      return 1e6;
    default:
      return 1e3;
  }
}

export function formatParameterCount(count: number): string {
  if (count >= 1e9) {
    const billions = count / 1e9;
    return `${billions >= 10 ? Math.round(billions) : Math.round(billions * 10) / 10}B`;
  }
  return `${Math.max(1, Math.round(count / 1e6))}M`;
}

/** Rough bits per weight for a quant tag, for sizing a model whose header has no count. */
export function approximateBitsPerWeight(quant: string | undefined): number | undefined {
  if (!quant) return undefined;
  const q = quant.toUpperCase().replace(/^UD-/, '');
  if (q === 'BF16' || q === 'F16') return 16;
  if (q === 'F32') return 32;
  if (q.startsWith('MXFP4') || q === 'NVFP4') return 4.25;
  const bits = /^I?Q(\d)/.exec(q);
  return bits ? Number(bits[1]) + 0.8 : undefined;
}
