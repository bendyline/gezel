import { access, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_IMAGE_CONFIG,
  type CodexImageClient,
  type CodexImageClientOptions,
  type RpcRecord,
} from './codex-image-client.js';
import { codexImageSettings, decodeCodexImage } from './codex-image-settings.js';
import { CodexImageProvider } from './codex-image.js';
import { MockImageProvider } from './mock.js';
import { ImageGenerationCancelledError } from './types.js';

async function fixture(overrides: Record<string, RpcRecord> = {}) {
  const { png } = await new MockImageProvider().generate({
    prompt: 'fixture',
    width: 8,
    height: 8,
  });
  const listeners = new Set<(method: string, params: RpcRecord) => void>();
  const emit = (method: string, params: RpcRecord) => {
    for (const listener of listeners) listener(method, params);
  };
  let onTurn = () =>
    emit('item/completed', {
      threadId: 'image-thread',
      item: {
        type: 'imageGeneration',
        status: 'completed',
        result: png.toString('base64'),
        failure: null,
      },
    });
  const client: CodexImageClient = {
    request: vi.fn(async (method: string) => {
      if (method in overrides) return overrides[method]!;
      switch (method) {
        case 'account/read':
          return { account: { type: 'chatgpt' } };
        case 'modelProvider/capabilities/read':
          return { imageGeneration: true };
        case 'model/list':
          return { data: [{ model: 'default-chat-model', isDefault: true }] };
        case 'config/read':
          return {
            config: {
              mcp_servers: {
                'private.server': { command: 'never-execute', env: { TOKEN: 'never-forward' } },
              },
            },
          };
        case 'thread/start':
          return { thread: { id: 'image-thread' } };
        case 'turn/start':
          onTurn();
          return { turn: { id: 'turn' } };
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    }),
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: vi.fn(async () => {
      listeners.clear();
    }),
  };
  const factory = vi.fn(async (opts: CodexImageClientOptions) => {
    opts.signal.addEventListener(
      'abort',
      () => emit('error', { error: { message: 'cancelled' } }),
      { once: true },
    );
    return client;
  });
  const provider = new CodexImageProvider({ clientFactory: factory });
  return {
    provider,
    client,
    factory,
    png,
    emit,
    setTurn: (callback: () => void) => {
      onTurn = callback;
    },
  };
}

describe('Codex image provider', () => {
  it('reuses account access and deduplicates concurrent availability probes', async () => {
    const f = await fixture();
    const [health, models, model] = await Promise.all([
      f.provider.health(),
      f.provider.listInstalledModels(),
      f.provider.resolveDefaultModelId(),
    ]);
    expect(health.status).toBe('ok');
    expect(models).toEqual([expect.objectContaining({ id: 'codex-image', supportsImg2Img: true })]);
    expect(model).toBe('codex-image');
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.client.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it.each([null, { type: 'apiKey' }])(
    'requires a Codex account instead of silently billing API credentials: %s',
    async (account) => {
      const f = await fixture({ 'account/read': { account } });
      expect(await f.provider.health()).toMatchObject({
        status: 'not-configured',
        error: expect.stringContaining('codex login'),
      });
      await expect(f.provider.generate({ prompt: 'compass' })).rejects.toThrow('codex login');
      expect(f.client.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
    },
  );

  it('reports unavailable native image capability', async () => {
    const f = await fixture({ 'modelProvider/capabilities/read': { imageGeneration: false } });
    expect(await f.provider.health()).toMatchObject({
      status: 'not-configured',
      error: expect.stringContaining('not available'),
    });
  });

  it('forwards settings and reference bytes while disabling unrelated tools and cleaning up', async () => {
    const f = await fixture();
    const request = vi.mocked(f.client.request);
    const original = request.getMockImplementation()!;
    let referencePath = '';
    request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') {
        const inputs = params!.input as RpcRecord[];
        referencePath = String(inputs[1]!.path);
        expect(await readFile(referencePath)).toEqual(f.png);
        expect(String(inputs[0]!.text)).toContain('"widthPx":1536');
        expect(String(inputs[0]!.text)).toContain('"heightPx":1024');
        expect(String(inputs[0]!.text)).toContain('"aspectRatio":"3:2"');
        expect(String(inputs[0]!.text)).toContain('"quality":"high"');
        expect(String(inputs[0]!.text)).toContain('"avoid":"text"');
        expect(String(inputs[0]!.text)).toContain('40% change');
      }
      return original(method, params);
    });
    const output = await f.provider.generate({
      prompt: 'compass',
      width: 1536,
      height: 1024,
      aspectRatio: '3:2',
      quality: 'high',
      negativePrompt: 'text',
      seed: 42,
      steps: 30,
      strength: 0.4,
      inputImages: [{ data: f.png, mimeType: 'image/png' }],
    });
    expect(output.png).toEqual(f.png);
    expect(output.meta).toMatchObject({ model: 'codex-image', widthPx: 8, heightPx: 8 });
    expect(output.meta.settingsNotes?.join(' ')).toMatch(
      /seed.*not applied.*steps.*not applied.*8×8/s,
    );
    expect(request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        model: 'default-chat-model',
        config: { ...CODEX_IMAGE_CONFIG, mcp_servers: { 'private.server': { enabled: false } } },
      }),
    );
    expect(f.client.stop).toHaveBeenCalledOnce();
    await expect(access(referencePath)).rejects.toThrow();
  });

  it('rejects prose claiming to have written an image', async () => {
    const f = await fixture();
    f.setTurn(() => {
      f.emit('item/completed', {
        item: { type: 'agentMessage', text: 'Image saved at /tmp/example.png' },
      });
      f.emit('turn/completed', { turn: { status: 'completed' } });
    });
    await expect(f.provider.generate({ prompt: 'compass' })).rejects.toThrow(
      'without returning a native image',
    );
    expect(f.client.stop).toHaveBeenCalledOnce();
  });

  it('rejects unrelated tools and failed turns', async () => {
    const f = await fixture();
    f.setTurn(() => f.emit('item/started', { item: { type: 'commandExecution' } }));
    await expect(f.provider.generate({ prompt: 'compass' })).rejects.toThrow('unrelated tool');
    f.setTurn(() =>
      f.emit('turn/completed', {
        turn: { status: 'failed', error: { message: 'Account denied' } },
      }),
    );
    await expect(f.provider.generate({ prompt: 'compass' })).rejects.toThrow('Account denied');
  });

  it.each(['abort', 'shutdown'] as const)('stops a pending generation on %s', async (action) => {
    const f = await fixture();
    const controller = new AbortController();
    f.setTurn(() => {
      if (action === 'abort') controller.abort();
      else void f.provider.shutdown();
    });
    await expect(
      f.provider.generate({ prompt: 'compass', signal: controller.signal }),
    ).rejects.toBeInstanceOf(ImageGenerationCancelledError);
    await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledOnce());
  });

  it('does not start a cancelled or invalid request', async () => {
    const f = await fixture();
    await expect(
      f.provider.generate({ prompt: 'compass', signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(ImageGenerationCancelledError);
    await expect(f.provider.generate({ prompt: 'compass', model: 'sd-model' })).rejects.toThrow(
      'chooses its image model',
    );
    await expect(
      f.provider.generate({
        prompt: 'compass',
        inputImages: [{ data: f.png, mimeType: 'image/svg+xml' }],
      }),
    ).rejects.toThrow('reference images');
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('reports unsupported seed and steps without inventing controls', () => {
    const settings = codexImageSettings({ prompt: 'compass', seed: 123, steps: 99 });
    expect(settings.prompt).not.toContain('123');
    expect(settings.prompt).not.toContain('99');
    expect(settings.notes).toHaveLength(2);
    expect(() => decodeCodexImage({ status: 'completed', result: 'not a PNG' })).toThrow(
      'invalid PNG',
    );
    expect(() =>
      decodeCodexImage({ status: 'failed', failure: { type: 'usageLimitExceeded' } }),
    ).toThrow('usage limit');
    expect(() =>
      decodeCodexImage({ status: 'completed', savedPath: '/private/image.png' }),
    ).toThrow('image bytes');
  });
});
