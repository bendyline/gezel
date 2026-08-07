import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { WindowedKvInput } from '../llama-cpp/offload-planner.js';

const log = createLogger('mlx');

/**
 * Attention geometry from an MLX model directory's `config.json` — the
 * safetensors-world equivalent of the GGUF header read, feeding the same
 * KV estimators (`estimateExactPerSlotKvBytesF16` /
 * `estimateWindowedKvLinearization`). Before this, MLX memory math could
 * only use the weights-scaled heuristic, which under-prices small dense
 * models ~3× and knows nothing about sliding-window layers.
 *
 * Shapes handled (fields live under `text_config` on multimodal configs,
 * top-level otherwise):
 * - Dense full-attention (qwen3.5): `num_hidden_layers`,
 *   `num_key_value_heads`, `head_dim` (or hidden/heads).
 * - Sliding-window (gemma4): `layer_types` of
 *   `sliding_attention`/`full_attention`, `sliding_window`, SWA layers at
 *   `head_dim` × `num_key_value_heads`, global layers at
 *   `global_head_dim` × `num_global_key_value_heads`.
 * - Linear-attention hybrids (qwen3.6-a3b): `linear_attention` layers
 *   carry a small context-independent recurrent state; approximated as a
 *   window-capped layer with a synthetic 1024-token window — the right
 *   order of magnitude, and the full-attention layers dominate either
 *   way. Pricing such a hybrid with full math overstates ~4×.
 *
 * Returns undefined (never guesses) when the layer count or head dims
 * are unreadable — callers fall back to the heuristic.
 */
export function readMlxModelGeometry(
  modelDir: string,
): Omit<WindowedKvInput, 'kvCacheType'> | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(modelDir, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (err) {
    log.debug(`model geometry unreadable in ${modelDir}: ${String(err)}`);
    return undefined;
  }
  const cfg = (
    typeof raw.text_config === 'object' && raw.text_config !== null ? raw.text_config : raw
  ) as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const v = cfg[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const blockCount = num('num_hidden_layers');
  if (!blockCount) return undefined;
  const headCountKv = num('num_key_value_heads');
  const headDim =
    num('head_dim') ??
    (num('hidden_size') && num('num_attention_heads')
      ? Math.floor((num('hidden_size') as number) / (num('num_attention_heads') as number))
      : undefined);
  if (!headCountKv || !headDim) return undefined;

  const layerTypes = Array.isArray(cfg.layer_types) ? (cfg.layer_types as unknown[]) : undefined;
  if (!layerTypes || layerTypes.length !== blockCount) {
    // Uniform full attention: every layer scales with context.
    return {
      blockCount,
      headCountKv,
      keyLength: headDim,
      valueLength: headDim,
    };
  }
  const boundedTypes = new Set(['sliding_attention', 'linear_attention']);
  const pattern = layerTypes.map((t) => boundedTypes.has(String(t)));
  if (!pattern.some(Boolean)) {
    return {
      blockCount,
      headCountKv,
      keyLength: headDim,
      valueLength: headDim,
    };
  }
  const globalHeadDim = num('global_head_dim') ?? headDim;
  const globalKvHeads = num('num_global_key_value_heads') ?? headCountKv;
  const LINEAR_STATE_WINDOW_TOKENS = 1024;
  const slidingWindow = num('sliding_window') ?? LINEAR_STATE_WINDOW_TOKENS;
  return {
    blockCount,
    headCountKv,
    headCountKvPerLayer: pattern.map((bounded) => (bounded ? headCountKv : globalKvHeads)),
    slidingWindow,
    slidingWindowPattern: pattern,
    keyLength: globalHeadDim,
    valueLength: globalHeadDim,
    keyLengthSwa: headDim,
    valueLengthSwa: headDim,
  };
}
