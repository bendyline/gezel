import { describe, expect, it, vi } from 'vitest';
import { CapacityDeniedError } from '../../providers/native/capacity-broker.js';
import type { ServiceContext } from '../context.js';
import { llamaCppRoutes } from './llama-cpp.js';
import { mlxRoutes } from './mlx.js';

const installed = {
  id: 'local-model',
  name: 'Local model',
  approxSizeBytes: 4_000_000_000,
  installedAt: '2026-08-01T00:00:00.000Z',
  contextWindow: 131_072,
  quantization: 'Q4_K_M',
  chatTemplatePresent: true,
};

describe('local model inventory context caps', () => {
  it('adds the live llama.cpp admission cap without replacing the advertised window', async () => {
    const previewLocalEnginePlan = vi.fn(async () => ({
      contextWindow: 65_536,
      plannedResidentBytes: 9_000_000_000,
    }));
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: { previewLocalEnginePlan },
    } as unknown as ServiceContext;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [
        {
          contextWindow: 131_072,
          effectiveContextWindow: 65_536,
          predictedResidentBytes: 9_000_000_000,
        },
      ],
    });
    expect(previewLocalEnginePlan).toHaveBeenCalledWith('llama-cpp', 'local-model');
  });

  it('adds the configured MLX cap without replacing the advertised window', async () => {
    const previewLocalEnginePlan = vi.fn(async () => ({
      contextWindow: 65_536,
      plannedResidentBytes: 9_000_000_000,
    }));
    const ctx = {
      mlxModels: {
        listInstalled: vi.fn(async () => [{ ...installed, modelDir: '/models/model' }]),
      },
      chat: { previewLocalEnginePlan },
    } as unknown as ServiceContext;

    const response = await mlxRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [
        {
          contextWindow: 131_072,
          effectiveContextWindow: 65_536,
          predictedResidentBytes: 9_000_000_000,
        },
      ],
    });
    expect(previewLocalEnginePlan).toHaveBeenCalledWith('mlx', 'local-model');
  });

  it('marks a llama.cpp model whose selected context policy cannot fit', async () => {
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: {
        previewLocalEnginePlan: vi.fn(async () => {
          throw new CapacityDeniedError('strict context does not fit');
        }),
      },
    } as unknown as ServiceContext;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ contextSizingStatus: 'insufficient-memory' }],
    });
  });

  it('marks a model RESIDENT below the policy minimum as restart-required, not insufficient-memory', async () => {
    // The remedy differs: this denial means "restart the engine", and the
    // UI must not send the user off to free memory.
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: {
        previewLocalEnginePlan: vi.fn(async () => {
          throw new CapacityDeniedError('already running below the required window', {
            reason: 'resident-below-minimum',
          });
        }),
      },
    } as unknown as ServiceContext;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ contextSizingStatus: 'restart-required' }],
    });
  });
});
