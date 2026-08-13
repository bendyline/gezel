import { describe, expect, it, vi } from 'vitest';
import { CapacityDeniedError } from '../../providers/native/capacity-broker.js';
import type { ServiceContext } from '../context.js';
import { ds4Routes } from './ds4.js';
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

const emptyStore = { readConfig: async () => ({}) };

describe('local model inventory context caps', () => {
  it('adds the standalone llama.cpp admission cap without replacing the advertised window', async () => {
    const previewLocalEnginePlan = vi.fn(async () => ({
      contextWindow: 65_536,
      plannedResidentBytes: 9_000_000_000,
    }));
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: { previewLocalEnginePlan },
      store: emptyStore,
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
    expect(previewLocalEnginePlan).toHaveBeenCalledWith('llama-cpp', 'local-model', {
      standalone: true,
    });
  });

  it('carries the slot reservation alongside the single-chat footprint', async () => {
    // Both figures reach the client because they answer different questions:
    // the headline is what one chat costs, the reservation is what the broker
    // holds. Collapsing them made a 3-slot host advertise ~49 GB for a model
    // whose measured peak RSS was ~32 GB.
    const previewLocalEnginePlan = vi.fn(async () => ({
      contextWindow: 65_536,
      plannedResidentBytes: 30_100_000_000,
      reservedResidentBytes: 49_300_000_000,
      plannedSlots: 3,
    }));
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: { previewLocalEnginePlan },
      store: emptyStore,
    } as never;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [
        {
          predictedResidentBytes: 30_100_000_000,
          reservedResidentBytes: 49_300_000_000,
          plannedSlots: 3,
        },
      ],
    });
  });

  it('carries the context-slider payload: linearization, auto marker, and override', async () => {
    const previewLocalEnginePlan = vi.fn(async () => ({
      contextWindow: 98_304,
      plannedResidentBytes: 9_000_000_000,
      autoContextWindow: 81_920,
      kvBytesPerTokenPerSlot: 36_864,
      kvFixedBytesPerSlot: 0,
      weightsResidentBytes: 4_800_000_000,
    }));
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: { previewLocalEnginePlan },
      store: {
        readConfig: async () => ({
          modelContextOverrides: { 'llama-cpp:local-model': 98_304 },
        }),
      },
    } as unknown as ServiceContext;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [
        {
          effectiveContextWindow: 98_304,
          overrideContextTokens: 98_304,
          autoContextWindow: 81_920,
          kvBytesPerTokenPerSlot: 36_864,
          kvFixedBytesPerSlot: 0,
          weightsResidentBytes: 4_800_000_000,
        },
      ],
    });
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
      store: emptyStore,
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
    expect(previewLocalEnginePlan).toHaveBeenCalledWith('mlx', 'local-model', {
      standalone: true,
    });
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
      store: emptyStore,
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
      store: emptyStore,
    } as unknown as ServiceContext;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ contextSizingStatus: 'restart-required' }],
    });
  });

  it('keeps the override on a restart-required row so the slider shows the pending setting', async () => {
    const ctx = {
      llamaCppModels: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: {
        previewLocalEnginePlan: vi.fn(async () => {
          throw new CapacityDeniedError('stale resident window', {
            reason: 'resident-below-minimum',
          });
        }),
      },
      store: {
        readConfig: async () => ({
          modelContextOverrides: { 'llama-cpp:local-model': 98_304 },
        }),
      },
    } as unknown as ServiceContext;

    const response = await llamaCppRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ contextSizingStatus: 'restart-required', overrideContextTokens: 98_304 }],
    });
  });

  it('MLX surfaces the same contextSizingStatus contract as llama.cpp', async () => {
    // MLX previously swallowed denials into a bare row, which left an
    // applied override indistinguishable from a pending one.
    const ctx = {
      mlxModels: {
        listInstalled: vi.fn(async () => [{ ...installed, modelDir: '/models/model' }]),
      },
      chat: {
        previewLocalEnginePlan: vi.fn(async () => {
          throw new CapacityDeniedError('already running below the required window', {
            reason: 'resident-below-minimum',
          });
        }),
      },
      store: emptyStore,
    } as unknown as ServiceContext;

    const response = await mlxRoutes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ contextSizingStatus: 'restart-required' }],
    });
  });

  it('ds4 rows now carry the effective window, override, and launch ceiling', async () => {
    const previewLocalEnginePlan = vi.fn(async () => ({
      contextWindow: 65_536,
      plannedResidentBytes: 48_000_000_000,
      contextCeilingTokens: 65_536,
    }));
    const ctx = {
      ds4Models: {
        listInstalled: vi.fn(async () => [{ ...installed, weightsPath: '/models/model.gguf' }]),
      },
      chat: { previewLocalEnginePlan },
      store: {
        readConfig: async () => ({
          modelContextOverrides: { 'ds4:local-model': 65_536 },
        }),
      },
    } as unknown as ServiceContext;

    const response = await ds4Routes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [
        {
          effectiveContextWindow: 65_536,
          overrideContextTokens: 65_536,
          contextCeilingTokens: 65_536,
        },
      ],
    });
    expect(previewLocalEnginePlan).toHaveBeenCalledWith('ds4', 'local-model', {
      standalone: true,
    });
  });

  it('returns rejected ds4 directories as management-only inventory rows', async () => {
    const ctx = {
      ds4Models: {
        listInstalled: vi.fn(async () => []),
        listUnrecognized: vi.fn(async () => [
          {
            id: 'deepseek-v4-flash-284b-q2',
            name: 'DeepSeek V4 Flash (IQ2_XXS)',
            bytes: 86_720_111_488,
            updatedAt: '2026-06-29T15:11:58.000Z',
            reason: 'This model was installed by an older version of Gezel.',
            canUpdate: true,
          },
        ]),
      },
      chat: { previewLocalEnginePlan: vi.fn() },
      store: emptyStore,
    } as unknown as ServiceContext;

    const response = await ds4Routes(ctx).request('http://test/models');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [],
      unrecognized: [
        {
          id: 'deepseek-v4-flash-284b-q2',
          bytes: 86_720_111_488,
          canUpdate: true,
        },
      ],
    });
  });
});
