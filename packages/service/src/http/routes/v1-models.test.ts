import { resetAppleStatusCache } from '@bendyline/gezel-inference/internal/http/openai-compat/apple-model';
import { v1ModelsRoutes } from '@bendyline/gezel-inference/internal/http/routes/v1-models';
import { appleFoundationModelsStatus } from '@bendyline/gezel-inference/internal/providers/apple-foundation-models/status';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
vi.mock('@bendyline/gezel-inference/internal/providers/apple-foundation-models/status', () => ({
  appleFoundationModelsStatus: vi.fn(async () => ({
    supported: false,
    installed: false,
    available: false,
  })),
}));
// Never probe this machine's GPU from a unit test; tests that rate models
// pass a profile, and the rest exercise the listing without one.
vi.mock('@bendyline/gezel-inference/internal/system/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bendyline/gezel-inference/internal/system/memory')>()),
  detectMemoryProfileCached: vi.fn(async () => {
    throw new Error('no memory probe in unit tests');
  }),
}));

const GiB = 1024 ** 3;

// Listings cache Apple's readiness; each test starts from a fresh check.
beforeEach(() => resetAppleStatusCache());

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

  it('advertises structured output for engines that enforce a schema', async () => {
    const ctx = modelContext();
    ctx.chat.listModelsForProvider = vi.fn(async (provider: string) =>
      provider === 'llama-cpp'
        ? [
            { id: 'small-writer', name: 'Small Writer', contextWindow: 32_768 },
            { id: 'custom-gguf', name: 'Custom', contextWindow: 8192 },
          ]
        : [],
    );
    const response = await v1ModelsRoutes(ctx, { localOnly: true }).request('http://localhost/');
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const byId = new Map(body.data.map((entry) => [entry.id, entry]));
    // Installed with a catalog entry: the entry's capabilities, schemas included.
    expect(byId.get('llama-cpp:small-writer')?.capabilities).toEqual({
      text: true,
      tools: true,
      structuredOutput: true,
      images: false,
      foregroundOnly: false,
    });
    // No catalog entry: unflagged rather than a guess about tools or images.
    expect(byId.get('llama-cpp:custom-gguf')).not.toHaveProperty('capabilities');

    const downloadable = modelContext();
    downloadable.chat.listModelsForProvider = vi.fn(async () => []);
    const listed = (await (
      await v1ModelsRoutes(downloadable, { localOnly: true }).request('http://localhost/')
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(listed.data).toContainEqual(
      expect.objectContaining({
        id: 'llama-cpp:small-writer',
        availability: 'download-required',
        capabilities: expect.objectContaining({ structuredOutput: true }),
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

  describe('rating downloadable models for this machine', () => {
    const smallCard = async () => ({
      platform: 'win32',
      totalRamBytes: 32 * GiB,
      gpuVramBytes: 12 * GiB,
      gpuMemoryKind: 'discrete' as const,
      source: 'gpu-nvidia' as const,
      usableBytes: 11.4 * GiB,
      budgetBytes: 19 * GiB,
    });

    function catalogOf(
      ...models: Array<{ id: string; gib: number; recoScore?: number; ds4Only?: boolean }>
    ) {
      const ctx = modelContext();
      ctx.chat.listModelsForProvider = vi.fn(async () => []);
      ctx.catalog.list = vi.fn(async () =>
        models.map(({ id, gib, recoScore, ds4Only }) => ({
          manifest: {
            schemaVersion: 1,
            kind: 'chat-model',
            id,
            name: id,
            tags: [],
            licenseClass: 'open',
            ...(recoScore === undefined ? {} : { recoScore }),
            approxSizeBytes: gib * GiB,
            supportsTools: true,
            ...(ds4Only
              ? { ds4: { approxSizeBytes: gib * GiB } }
              : { llamaCpp: { approxSizeBytes: gib * GiB } }),
          },
        })),
      ) as unknown as typeof ctx.catalog.list;
      return ctx;
    }

    async function list(ctx: ServiceContext, memoryProfile = smallCard) {
      const response = await v1ModelsRoutes(ctx, { localOnly: true, memoryProfile }).request(
        'http://localhost/',
      );
      return ((await response.json()) as { data: Array<Record<string, unknown>> }).data;
    }

    it('lists the recommended model first and one too big for this machine last, at 0', async () => {
      const data = await list(
        catalogOf(
          { id: 'huge', gib: 60, recoScore: 30 },
          { id: 'plain', gib: 4 },
          { id: 'curated', gib: 6, recoScore: 20 },
        ),
      );
      expect(data.map((entry) => entry.id)).toEqual([
        'llama-cpp:curated',
        'llama-cpp:plain',
        'llama-cpp:huge',
      ]);
      expect(data[0]).toMatchObject({
        fit: { tier: 'fits' },
        recommendation: { score: 100, recommended: true },
      });
      expect(data[1]).toMatchObject({ recommendation: { score: 50, recommended: false } });
      expect(data[2]).toMatchObject({
        fit: { tier: 'too-big' },
        recommendation: { score: 0, recommended: false },
      });
    });

    it('falls back to curated order, unrated, when this machine cannot be read', async () => {
      const data = await list(
        catalogOf({ id: 'plain', gib: 4 }, { id: 'curated', gib: 6, recoScore: 20 }),
        async () => {
          throw new Error('probe failed');
        },
      );
      expect(data.map((entry) => entry.id)).toEqual(['llama-cpp:curated', 'llama-cpp:plain']);
      expect(data[0]).not.toHaveProperty('fit');
      expect(data[0]).not.toHaveProperty('recommendation');
    });

    it('offers ds4-only models only where a ds4 build is on disk', async () => {
      const ctx = catalogOf({ id: 'giant-moe', gib: 80, ds4Only: true });
      vi.stubEnv('GEZEL_DS4_SERVER_BIN', '');
      expect(await list(ctx)).toEqual([]);
      vi.stubEnv('GEZEL_DS4_SERVER_BIN', '/opt/gezel/ds4-server');
      expect((await list(ctx)).map((entry) => entry.id)).toEqual(['ds4:giant-moe']);
    });
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

it('reuses one Apple readiness check across listings instead of launching the helper each time', async () => {
  const status = vi.mocked(appleFoundationModelsStatus);
  status.mockClear();
  await Promise.all([
    v1ModelsRoutes(modelContext(), { localOnly: true }).request('http://localhost/'),
    v1ModelsRoutes(modelContext(), { localOnly: true }).request('http://localhost/'),
  ]);
  await v1ModelsRoutes(modelContext(), { localOnly: true }).request('http://localhost/');
  expect(status).toHaveBeenCalledTimes(1);
  resetAppleStatusCache();
  await v1ModelsRoutes(modelContext(), { localOnly: true }).request('http://localhost/');
  expect(status).toHaveBeenCalledTimes(2);
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
  resetAppleStatusCache();
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
      default_output_tokens: 2048,
      capabilities: expect.objectContaining({ structuredOutput: true, images: false }),
    }),
  );
});
