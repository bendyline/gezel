import { afterEach, describe, expect, it, vi } from 'vitest';
import { appleFoundationModelsStatus } from '../../providers/apple-foundation-models/status.js';
import type { ServiceContext } from '../context.js';
import { v1ModelsRoutes } from './v1-models.js';
vi.mock('../../providers/apple-foundation-models/status.js', () => ({
  appleFoundationModelsStatus: vi.fn(async () => ({
    supported: false,
    installed: false,
    available: false,
  })),
}));

function modelContext(): ServiceContext {
  return {
    store: {
      readConfig: async () => ({}),
      listGezels: async () => [],
      getGezel: async () => null,
    },
    chat: {
      listModelsForProvider: async (provider: string) =>
        provider === 'llama-cpp'
          ? [{ id: 'installed-model', contextWindow: 16_384, supportsReasoning: false }]
          : [],
    },
    catalog: {
      list: async () => [
        {
          manifest: {
            schemaVersion: 1,
            kind: 'chat-model',
            id: 'small-writer',
            name: 'Small Writer',
            description: 'A compact writing model.',
            tags: [],
            maintainer: { name: 'Gezel' },
            licenseClass: 'open',
            recoScore: 10,
            version: '1',
            releasedAt: '2026-01-01',
            parameterSize: '4B',
            approxSizeBytes: 2 * 1024 ** 3,
            supportsTools: true,
            contextWindow: 32_768,
            availableVersions: [],
            llamaCpp: {},
          },
        },
      ],
    },
  } as unknown as ServiceContext;
}

describe('GET /v1/models catalog metadata', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('keeps installed models selectable and advertises downloadable on-device models', async () => {
    const response = await v1ModelsRoutes(modelContext()).request('http://localhost/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(body.data).toContainEqual(
      expect.objectContaining({
        id: 'llama-cpp:installed-model',
        availability: 'available',
        locality: 'on-device',
      }),
    );
    expect(body.data).toContainEqual(
      expect.objectContaining({
        id: 'llama-cpp:small-writer',
        name: 'Small Writer',
        availability: 'download-required',
        locality: 'on-device',
        download_bytes: 2 * 1024 ** 3,
        context_window: 32_768,
      }),
    );
  });

  it('offers native catalog weights and never enumerates Python engines in store hosts', async () => {
    vi.stubEnv('GEZEL_DISTRIBUTION_PROFILE', 'store');
    const ctx = modelContext();
    const items = await ctx.catalog.list('chat-model');
    const first = items[0];
    if (!first) throw new Error('missing catalog fixture');
    const dual = { ...first, manifest: { ...first.manifest, mlx: {} } };
    const mlxOnly = {
      ...dual,
      manifest: { ...dual.manifest, id: 'python-only', llamaCpp: undefined },
    };
    ctx.catalog.list = vi.fn(async () => [dual, mlxOnly]) as typeof ctx.catalog.list;
    const providers: string[] = [];
    ctx.chat.listModelsForProvider = vi.fn(async (provider: string) => {
      providers.push(provider);
      return [];
    });
    const response = await v1ModelsRoutes(ctx, { localOnly: true }).request('http://localhost/');
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toEqual(['llama-cpp:small-writer']);
    expect(providers).toEqual(['llama-cpp', 'ds4']);
  });

  it('keeps the embedded profile local and does not enumerate gezels or cloud providers', async () => {
    const ctx = modelContext();
    const providers: string[] = [];
    ctx.store.listGezels = vi.fn(async () => {
      throw new Error('the embedded profile must not enumerate product gezels');
    });
    ctx.chat.listModelsForProvider = vi.fn(async (provider: string) => {
      providers.push(provider);
      return [];
    });

    const response = await v1ModelsRoutes(ctx, { localOnly: true }).request('http://localhost/');
    expect(response.status).toBe(200);
    expect(providers).toEqual(['llama-cpp', 'mlx', 'ds4']);
    expect(ctx.store.listGezels).not.toHaveBeenCalled();
  });
});

it('enumerates Apple readiness and context through the public inventory without granting product access', async () => {
  vi.mocked(appleFoundationModelsStatus).mockResolvedValueOnce({
    supported: true,
    installed: true,
    available: false,
    reason: 'Enable Apple Intelligence in System Settings.',
  });
  let response = await v1ModelsRoutes(modelContext(), { localOnly: true }).request(
    'http://localhost/',
  );
  let body = (await response.json()) as { data: Array<Record<string, unknown>> };
  expect(body.data).toContainEqual(
    expect.objectContaining({
      id: 'apple-foundation-models:apple-foundation-models',
      availability: 'unavailable',
      locality: 'on-device',
      preparation: 'system-settings',
      recovery_actions: ['open-system-settings'],
    }),
  );
  vi.mocked(appleFoundationModelsStatus).mockResolvedValueOnce({
    supported: true,
    installed: true,
    available: true,
    runtime: {
      version: '1',
      os: 'macOS',
      available: true,
      contextTokens: 4096,
      maxOutputTokens: 2048,
    },
  });
  response = await v1ModelsRoutes(modelContext(), { localOnly: true }).request('http://localhost/');
  body = (await response.json()) as { data: Array<Record<string, unknown>> };
  expect(body.data).toContainEqual(
    expect.objectContaining({
      id: 'apple-foundation-models:apple-foundation-models',
      availability: 'available',
      context_window: 4096,
      max_output_tokens: 2048,
    }),
  );
});
