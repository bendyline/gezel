import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SharedModelClient, findSharedModel } from './model-pull.js';

const SHARED = join('C:', 'Users', 'me', '.gezel-dev', 'engines', 'llama-cpp', 'models');

function client(models: {
  llama?: Array<Record<string, unknown>>;
  mlx?: Array<Record<string, unknown>>;
}): SharedModelClient {
  return {
    listLlamaCppModels: async () => ({ models: models.llama ?? [] }),
    listDs4Models: async () => ({ models: [] }),
    listMlxModels: async () => ({ models: models.mlx ?? [] }),
  } as unknown as SharedModelClient;
}

describe('findSharedModel', () => {
  it('finds a verified copy in a shared store and says where it is', async () => {
    const shared = client({
      llama: [
        {
          id: 'qwen3.5-2b-q4',
          readOnly: true,
          weightsPath: join(SHARED, 'qwen3.5-2b-q4', 'Qwen3.5-2B-Q4_K_M.gguf'),
        },
      ],
    });
    await expect(findSharedModel(shared, 'llama-cpp', 'qwen3.5-2b-q4')).resolves.toEqual({
      location: join(SHARED, 'qwen3.5-2b-q4'),
      updateAvailable: false,
    });
  });

  it('reports a newer catalog build of a shared MLX copy', async () => {
    const shared = client({
      mlx: [{ id: 'qwen3.5-2b-4bit', readOnly: true, modelDir: '/srv/mlx', updateAvailable: true }],
    });
    await expect(findSharedModel(shared, 'mlx', 'qwen3.5-2b-4bit')).resolves.toEqual({
      location: '/srv/mlx',
      updateAvailable: true,
    });
  });

  it('leaves a model in this home, or one not downloaded at all, to the download', async () => {
    const own = client({
      llama: [{ id: 'qwen3.5-2b-q4', weightsPath: join('home', 'qwen3.5-2b-q4', 'w.gguf') }],
    });
    await expect(findSharedModel(own, 'llama-cpp', 'qwen3.5-2b-q4')).resolves.toBeNull();
    await expect(findSharedModel(own, 'llama-cpp', 'gemma4-e2b-q4')).resolves.toBeNull();
    await expect(findSharedModel(own, 'ds4', 'qwen3.5-2b-q4')).resolves.toBeNull();
  });
});
