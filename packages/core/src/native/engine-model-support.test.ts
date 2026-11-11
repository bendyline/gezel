import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LLAMA_CPP_ARCHITECTURES,
  LLAMA_CPP_GGUF_SUPPORT_COMMIT,
  LLAMA_CPP_GGUF_SUPPORT_TAG,
} from './llama-cpp-gguf-support.js';
import { MLX_MODEL_TYPES, MLX_VLM_SUPPORT_VERSION } from './mlx-model-support.js';

const repo = resolve(import.meta.dirname, '..', '..', '..', '..');

// A stale table blocks models the new engine loads (or admits ones it dropped).
// Fix either failure with: node scripts/sync-engine-model-support.mjs
describe('engine model support tables', () => {
  it('were generated from the pinned llama.cpp', () => {
    const pin = readFileSync(resolve(repo, 'native', 'engines', 'llama-cpp', 'VERSION'), 'utf8');
    expect(LLAMA_CPP_GGUF_SUPPORT_COMMIT).toBe(/^commit=(.+)$/m.exec(pin)?.[1]?.trim());
    expect(LLAMA_CPP_GGUF_SUPPORT_TAG).toBe(/^tag=(.+)$/m.exec(pin)?.[1]?.trim());
  });

  it('were generated from the pinned mlx-vlm', () => {
    const venv = readFileSync(
      resolve(repo, 'packages', 'inference', 'src', 'providers', 'mlx', 'venv.ts'),
      'utf8',
    );
    expect(MLX_VLM_SUPPORT_VERSION).toBe(/'mlx-vlm==([^']+)'/.exec(venv)?.[1]);
  });

  it('know the designs the catalog ships', () => {
    for (const arch of ['llama', 'qwen3', 'gemma3', 'gemma4', 'gpt-oss']) {
      expect(LLAMA_CPP_ARCHITECTURES).toContain(arch);
    }
    for (const type of ['llama', 'qwen3', 'gemma3', 'gemma4', 'qwen3_5']) {
      expect(MLX_MODEL_TYPES).toContain(type);
    }
  });
});
