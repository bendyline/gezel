import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateExactPerSlotKvBytesF16 } from '../llama-cpp/offload-planner.js';
import { readMlxModelGeometry } from './model-geometry.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mlx-geometry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

describe('readMlxModelGeometry', () => {
  it('reads a gemma4-style SWA layout from text_config (real gemma4-12b shape)', () => {
    // 48 layers, 5:1 sliding:full, SWA layers 8 heads × 256 dims, global
    // layers 1 head × 512 dims — matches the GGUF header byte for byte.
    const layerTypes = Array.from({ length: 48 }, (_, i) =>
      (i + 1) % 6 === 0 ? 'full_attention' : 'sliding_attention',
    );
    const geometry = readMlxModelGeometry(
      writeConfig({
        model_type: 'gemma4',
        text_config: {
          num_hidden_layers: 48,
          num_key_value_heads: 8,
          num_global_key_value_heads: 1,
          head_dim: 256,
          global_head_dim: 512,
          sliding_window: 1024,
          layer_types: layerTypes,
        },
      }),
    );
    expect(geometry).toMatchObject({ blockCount: 48, slidingWindow: 1024 });
    expect(geometry?.slidingWindowPattern?.filter((swa) => !swa)).toHaveLength(8);
    expect(geometry?.headCountKvPerLayer?.[5]).toBe(1);
    expect(geometry?.headCountKvPerLayer?.[0]).toBe(8);
    // The shared estimator prices it windowed: 8 global layers scale,
    // 40 SWA layers are a fixed window block.
    const perSlot = estimateExactPerSlotKvBytesF16(geometry ?? {}, 65_536);
    expect(perSlot).toBe(8 * 1 * 1024 * 2 * 65_536 + 40 * 8 * 512 * 2 * (1024 + 2048));
  });

  it('treats linear-attention hybrid layers as bounded state (qwen3.6-a3b shape)', () => {
    const layerTypes = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 3 ? 'full_attention' : 'linear_attention',
    );
    const geometry = readMlxModelGeometry(
      writeConfig({
        text_config: {
          num_hidden_layers: 40,
          num_key_value_heads: 2,
          head_dim: 256,
          layer_types: layerTypes,
        },
      }),
    );
    // No sliding_window in the config: linear layers get the synthetic
    // 1024-token state window instead of pricing all 40 layers full.
    expect(geometry?.slidingWindow).toBe(1024);
    expect(geometry?.slidingWindowPattern?.filter((bounded) => bounded)).toHaveLength(30);
    const perSlot = estimateExactPerSlotKvBytesF16(geometry ?? {}, 65_536);
    const fullAllLayers = 40 * 2 * 512 * 2 * 65_536;
    expect(perSlot).toBeLessThan(fullAllLayers / 3);
  });

  it('reads a dense top-level config and derives head_dim from hidden/heads', () => {
    const geometry = readMlxModelGeometry(
      writeConfig({
        num_hidden_layers: 36,
        num_key_value_heads: 8,
        num_attention_heads: 32,
        hidden_size: 4096,
      }),
    );
    expect(geometry).toEqual({
      blockCount: 36,
      headCountKv: 8,
      keyLength: 128,
      valueLength: 128,
    });
  });

  it('returns undefined for unreadable or dimension-less configs', () => {
    expect(readMlxModelGeometry(join(dir, 'missing'))).toBeUndefined();
    expect(readMlxModelGeometry(writeConfig({ model_type: 'x' }))).toBeUndefined();
    expect(
      readMlxModelGeometry(writeConfig({ num_hidden_layers: 40, num_key_value_heads: 8 })),
    ).toBeUndefined();
  });
});
