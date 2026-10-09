import { describe, expect, it, vi } from 'vitest';
import { createDesktopEmbedding } from './desktop-embedding.js';
import { connectOrHost } from './gezel.js';
vi.mock('./gezel.js', () => ({ connectOrHost: vi.fn() }));
describe('desktop embedding policy', () => {
  it('requests only inference, keeps initial connection silent, prompts only on reconnect', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(connectOrHost).mockResolvedValue({
      hosting: false,
      openai: { models: async () => ({ object: 'list', data: [] }) },
      close,
    } as never);
    const onVerificationCode = vi.fn();
    const host = createDesktopEmbedding({
      appId: 'fixture',
      appName: 'Fixture',
      host: {},
      onVerificationCode,
    });
    await host.setEnabled(true);
    await host.models.list();
    expect(connectOrHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopes: ['openai'],
        requireVerificationCode: true,
        host: expect.objectContaining({
          mode: 'in-process',
          inferenceOnly: true,
          systemBootstrap: false,
        }),
      }),
    );
    expect(vi.mocked(connectOrHost).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'onVerificationCode',
    );
    await host.reconnect();
    expect(vi.mocked(connectOrHost).mock.calls.at(-1)?.[0].onVerificationCode).toBe(
      onVerificationCode,
    );
    await host.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

it('opts into catalog authority without product access and keeps explicit downloads separate from engine preparation', async () => {
  const { connectDesktopEmbedding } = await import('./desktop-embedding.js');
  const ensureModel = vi.fn(async () => ({}));
  const installed = {
    id: 'llama-cpp:writer',
    object: 'model',
    created: 0,
    owned_by: 'llama-cpp',
    availability: 'available',
  };
  const knowledge = { retrieve: vi.fn(), state: vi.fn(), update: vi.fn() };
  vi.mocked(connectOrHost).mockResolvedValue({
    hosting: true,
    openai: {
      models: async () => ({
        data: [installed, { ...installed, id: 'mlx:writer', owned_by: 'mlx' }],
      }),
      knowledge,
    },
    ensureModel,
    close: vi.fn(),
  } as never);
  const connection = await connectDesktopEmbedding(
    {
      appId: 'editor',
      appName: 'Editor',
      knowledge: true,
      host: { distributionProfile: 'store', nativeBinDir: '/bundled' },
    },
    { interactive: false },
  );
  expect(vi.mocked(connectOrHost).mock.calls.at(-1)?.[0].scopes).toEqual(['openai', 'knowledge']);
  expect(connection.knowledge).toBe(knowledge);
  expect((await connection.models.list()).map((entry) => entry.id)).toEqual(['llama-cpp:writer']);
  await connection.models.prepare(installed.id);
  expect(ensureModel).toHaveBeenCalledWith(
    expect.objectContaining({
      engine: 'llama-cpp',
      model: 'writer',
      allowWeightDownload: false,
      pinAsDefault: false,
    }),
  );
  await connection.close();
});

it('never permits disallowed hosted engines', async () => {
  const { connectDesktopEmbedding } = await import('./desktop-embedding.js');
  const ensureModel = vi.fn(async () => ({}));
  const entry = {
    id: 'ds4:writer',
    object: 'model',
    created: 0,
    owned_by: 'ds4',
    availability: 'download-required',
  };
  vi.mocked(connectOrHost).mockResolvedValue({
    hosting: true,
    openai: { models: async () => ({ data: [entry] }) },
    ensureModel,
    close: vi.fn(),
  } as never);
  const connection = await connectDesktopEmbedding(
    { appId: 'editor', appName: 'Editor', hostedEngines: ['llama-cpp'], host: {} },
    { interactive: false },
  );
  await expect(connection.models.prepare(entry.id, { allowDownload: true })).rejects.toMatchObject({
    code: 'model_unavailable',
  });
  expect(ensureModel).not.toHaveBeenCalled();
  await connection.close();
});

it('revokes only a standalone grant and forgets the token even when revocation fails', async () => {
  const { connectDesktopEmbedding } = await import('./desktop-embedding.js');
  const revoke = vi.fn(async () => {
    throw new Error('offline');
  });
  const forget = vi.fn();
  const close = vi.fn();
  vi.mocked(connectOrHost).mockResolvedValue({
    hosting: false,
    openai: { models: vi.fn(), revokeMyToken: revoke },
    close,
  } as never);
  const connection = await connectDesktopEmbedding(
    { appId: 'editor', appName: 'Editor', tokenStorage: { save: vi.fn(), delete: forget } },
    { interactive: false },
  );
  await expect(connection.revoke()).rejects.toThrow('offline');
  expect(forget).toHaveBeenCalledWith('editor');
  await connection.close();
  await connection.close();
  expect(close).toHaveBeenCalledOnce();
});

it('does not grant a weight download during ordinary preparation, and aborts explicit downloads', async () => {
  const { connectDesktopEmbedding } = await import('./desktop-embedding.js');
  const controller = new AbortController();
  const ensureModel = vi.fn(async (options) => {
    expect(options.allowWeightDownload).toBe(true);
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    options.signal.throwIfAborted();
  });
  const entry = {
    id: 'llama-cpp:writer',
    object: 'model',
    created: 0,
    owned_by: 'llama-cpp',
    availability: 'download-required',
  };
  vi.mocked(connectOrHost).mockResolvedValue({
    hosting: true,
    openai: { models: async () => ({ data: [entry] }) },
    ensureModel,
    close: vi.fn(),
  } as never);
  const connection = await connectDesktopEmbedding(
    { appId: 'editor', appName: 'Editor', host: {} },
    { interactive: false },
  );
  await expect(connection.models.prepare(entry.id)).rejects.toMatchObject({
    code: 'model_download_required',
  });
  expect(ensureModel).not.toHaveBeenCalled();
  await expect(
    connection.models.prepare(entry.id, { allowDownload: true, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'aborted' });
  expect(ensureModel).toHaveBeenCalledOnce();
  await connection.close();
});
